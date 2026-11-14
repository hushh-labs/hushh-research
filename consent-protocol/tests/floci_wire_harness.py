# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Ephemeral Floci (`https://floci.io/`) multi-cloud wire-conformance harness.

Provides Tier-1.5 wire-protocol validation between pure in-process unit tests (Tier 1)
and live cloud sandbox qualification (Tier 2):

1. If `FLOCI_ENDPOINT_URL` is configured (loopback HTTP), connects to that live Floci
   daemon directly (`mode="floci_external"`).
2. Else if the MIT-licensed `floci` native binary is installed on `PATH`, launches an
   ephemeral `floci` instance on a free loopback port (`mode="floci_native"`).
3. Otherwise boots a deterministic loopback HTTP/1.1 wire server speaking real AWS S3
   REST/XML (`If-None-Match: *`, `If-Match: <ETag>`, `PreconditionFailed`, `AccessDenied`)
   and AWS KMS `AWSJson1_1` (`TrentService.CreateKey`, `Encrypt`, `Decrypt` with real
   AES-256-GCM + `EncryptionContext` AAD binding) so unmocked `boto3` / `botocore`
   clients exercise the complete HTTP + SigV4 wire stack on every local and CI run.

Security invariant: Floci wire conformance proves SDK/wire/CAS/AAD correctness only; it
never flips `execution_qualified = True` in `PROVIDER_CAPABILITY_REGISTRY`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


@dataclass
class _WireState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    buckets: dict[str, dict[str, tuple[bytes, str]]] = field(default_factory=dict)
    forbidden_buckets: set[str] = field(default_factory=set)
    kms_keys: dict[str, bytes] = field(default_factory=dict)
    disabled_kms_keys: set[str] = field(default_factory=set)

    def ensure_kms_key(self, key_id: str) -> bytes:
        with self.lock:
            existing = self.kms_keys.get(key_id)
            if existing is None:
                existing = os.urandom(32)
                self.kms_keys[key_id] = existing
            return existing


@dataclass(frozen=True)
class FlociWireEnvironment:
    endpoint_url: str
    mode: str
    region: str = "us-east-1"
    _state: _WireState | None = None

    def set_bucket_forbidden(self, bucket: str, *, forbidden: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if forbidden:
                self._state.forbidden_buckets.add(bucket)
            else:
                self._state.forbidden_buckets.discard(bucket)

    def set_kms_key_disabled(self, key_id: str, *, disabled: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if disabled:
                self._state.disabled_kms_keys.add(key_id)
            else:
                self._state.disabled_kms_keys.discard(key_id)


def _canonical_aad(key_id: str, context: dict[str, str] | None) -> bytes:
    normalized = {str(k): str(v) for k, v in (context or {}).items()}
    payload = {"KeyId": key_id, "EncryptionContext": normalized}
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _s3_error_xml(code: str, message: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Error><Code>{code}</Code><Message>{message}</Message></Error>"
    ).encode("utf-8")


def _build_wire_handler(state: _WireState) -> type[BaseHTTPRequestHandler]:
    class _Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send_bytes(
            self,
            status: int,
            body: bytes,
            *,
            content_type: str = "application/xml",
            headers: dict[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for hk, hv in (headers or {}).items():
                self.send_header(hk, hv)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _read_body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or "0")
            return self.rfile.read(length) if length > 0 else b""

        def _parse_s3_path(self) -> tuple[str, str]:
            parsed = urllib.parse.urlsplit(self.path)
            raw_path = urllib.parse.unquote(parsed.path.lstrip("/"))
            if not raw_path:
                return "", ""
            parts = raw_path.split("/", 1)
            bucket = parts[0]
            key = parts[1] if len(parts) > 1 else ""
            return bucket, key

        def _check_bucket_access(self, bucket: str) -> bool:
            with state.lock:
                if bucket in state.forbidden_buckets:
                    self._send_bytes(
                        403,
                        _s3_error_xml("AccessDenied", "Access Denied"),
                    )
                    return False
            return True

        def do_HEAD(self) -> None:  # noqa: N802
            bucket, key = self._parse_s3_path()
            if not self._check_bucket_access(bucket):
                return
            with state.lock:
                bkt = state.buckets.get(bucket)
                if bkt is None:
                    self._send_bytes(404, _s3_error_xml("NoSuchBucket", "No such bucket"))
                    return
                if not key:
                    self._send_bytes(200, b"")
                    return
                entry = bkt.get(key)
            if entry is None:
                self._send_bytes(404, _s3_error_xml("NoSuchKey", "No such key"))
                return
            payload, etag = entry
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("ETag", etag)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/_floci/health":
                self._send_bytes(
                    200,
                    b'{"status":"ok"}',
                    content_type="application/json",
                )
                return
            bucket, key = self._parse_s3_path()
            if not self._check_bucket_access(bucket):
                return
            with state.lock:
                bkt = state.buckets.get(bucket)
                if bkt is None:
                    self._send_bytes(404, _s3_error_xml("NoSuchBucket", "No such bucket"))
                    return
                entry = bkt.get(key)
            if entry is None:
                self._send_bytes(404, _s3_error_xml("NoSuchKey", "No such key"))
                return
            payload, etag = entry
            self._send_bytes(
                200,
                payload,
                content_type="application/octet-stream",
                headers={"ETag": etag},
            )

        def do_PUT(self) -> None:  # noqa: N802
            body = self._read_body()
            bucket, key = self._parse_s3_path()
            if not self._check_bucket_access(bucket):
                return
            if not key:
                with state.lock:
                    state.buckets.setdefault(bucket, {})
                self._send_bytes(200, b"")
                return

            if_none_match = (self.headers.get("If-None-Match") or "").strip()
            if_match = (self.headers.get("If-Match") or "").strip()
            new_etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'

            with state.lock:
                bkt = state.buckets.get(bucket)
                if bkt is None:
                    self._send_bytes(404, _s3_error_xml("NoSuchBucket", "No such bucket"))
                    return
                current = bkt.get(key)
                if if_none_match == "*" and current is not None:
                    self._send_bytes(
                        412,
                        _s3_error_xml(
                            "PreconditionFailed",
                            "At least one of the pre-conditions you specified did not hold",
                        ),
                    )
                    return
                if if_match:
                    if current is None:
                        self._send_bytes(404, _s3_error_xml("NoSuchKey", "No such key"))
                        return
                    current_etag = current[1]
                    if if_match.strip('"') != current_etag.strip('"'):
                        self._send_bytes(
                            412,
                            _s3_error_xml(
                                "PreconditionFailed",
                                "At least one of the pre-conditions you specified did not hold",
                            ),
                        )
                        return
                bkt[key] = (body, new_etag)

            self._send_bytes(200, b"", headers={"ETag": new_etag})

        def do_DELETE(self) -> None:  # noqa: N802
            self._read_body()
            bucket, key = self._parse_s3_path()
            if not self._check_bucket_access(bucket):
                return
            if_match = (self.headers.get("If-Match") or "").strip()
            with state.lock:
                bkt = state.buckets.get(bucket)
                if bkt is None:
                    self._send_bytes(404, _s3_error_xml("NoSuchBucket", "No such bucket"))
                    return
                current = bkt.get(key)
                if if_match and current is not None:
                    if if_match.strip('"') != current[1].strip('"'):
                        self._send_bytes(
                            412,
                            _s3_error_xml("PreconditionFailed", "ETag precondition failed"),
                        )
                        return
                bkt.pop(key, None)
            self._send_bytes(204, b"")

        def do_POST(self) -> None:  # noqa: N802
            raw = self._read_body()
            target = (self.headers.get("X-Amz-Target") or "").strip()
            if not target.startswith("TrentService."):
                self._send_bytes(
                    400,
                    b'{"__type":"UnknownOperationException"}',
                    content_type="application/x-amz-json-1.1",
                )
                return

            payload = json.loads(raw.decode("utf-8") or "{}")
            op = target.split(".", 1)[1]

            if op == "CreateKey":
                arn = f"arn:aws:kms:us-east-1:000000000000:key/{os.urandom(8).hex()}"
                state.ensure_kms_key(arn)
                resp = {"KeyMetadata": {"KeyId": arn, "Arn": arn, "Enabled": True}}
                self._send_bytes(
                    200,
                    json.dumps(resp).encode("utf-8"),
                    content_type="application/x-amz-json-1.1",
                )
                return

            key_id = str(payload.get("KeyId") or "").strip()
            with state.lock:
                disabled = key_id in state.disabled_kms_keys
            if disabled:
                self._send_bytes(
                    400,
                    json.dumps(
                        {"__type": "DisabledException", "message": "KMS key is disabled"}
                    ).encode("utf-8"),
                    content_type="application/x-amz-json-1.1",
                )
                return

            if op == "Encrypt":
                raw_pt = base64.b64decode(payload["Plaintext"])
                kek = state.ensure_kms_key(key_id)
                nonce = os.urandom(12)
                aad = _canonical_aad(key_id, payload.get("EncryptionContext"))
                ct = AESGCM(kek).encrypt(nonce, raw_pt, aad)
                envelope = json.dumps(
                    {
                        "k": key_id,
                        "n": base64.b64encode(nonce).decode("ascii"),
                        "c": base64.b64encode(ct).decode("ascii"),
                    }
                ).encode("utf-8")
                self._send_bytes(
                    200,
                    json.dumps(
                        {
                            "CiphertextBlob": base64.b64encode(envelope).decode("ascii"),
                            "KeyId": key_id,
                        }
                    ).encode("utf-8"),
                    content_type="application/x-amz-json-1.1",
                )
                return

            if op == "Decrypt":
                try:
                    raw_blob = base64.b64decode(payload["CiphertextBlob"])
                    decoded = json.loads(raw_blob.decode("utf-8"))
                    blob_key_id = str(decoded["k"])
                    expected_key_id = key_id or blob_key_id
                    if expected_key_id != blob_key_id:
                        raise ValueError("KMS KeyId mismatch")
                    with state.lock:
                        if expected_key_id in state.disabled_kms_keys:
                            raise PermissionError("KMS key disabled")
                        kek_opt = state.kms_keys.get(expected_key_id)
                    if kek_opt is None:
                        raise ValueError("Unknown KMS key")
                    nonce = base64.b64decode(decoded["n"])
                    ct = base64.b64decode(decoded["c"])
                    aad = _canonical_aad(expected_key_id, payload.get("EncryptionContext"))
                    pt = AESGCM(kek_opt).decrypt(nonce, ct, aad)
                except PermissionError:
                    self._send_bytes(
                        400,
                        json.dumps(
                            {"__type": "DisabledException", "message": "KMS key is disabled"}
                        ).encode("utf-8"),
                        content_type="application/x-amz-json-1.1",
                    )
                    return
                except Exception:  # noqa: BLE001
                    self._send_bytes(
                        400,
                        json.dumps(
                            {
                                "__type": "InvalidCiphertextException",
                                "message": "Ciphertext or EncryptionContext invalid",
                            }
                        ).encode("utf-8"),
                        content_type="application/x-amz-json-1.1",
                    )
                    return

                self._send_bytes(
                    200,
                    json.dumps(
                        {
                            "Plaintext": base64.b64encode(pt).decode("ascii"),
                            "KeyId": expected_key_id,
                        }
                    ).encode("utf-8"),
                    content_type="application/x-amz-json-1.1",
                )
                return

            self._send_bytes(
                400,
                b'{"__type":"UnsupportedOperationException"}',
                content_type="application/x-amz-json-1.1",
            )

    return _Handler


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_tcp(port: int, *, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.1)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.02)
    return False


@contextmanager
def floci_aws_wire_environment() -> Iterator[FlociWireEnvironment]:
    """Yield an ephemeral loopback AWS wire environment (Floci native or wire fallback)."""
    configured = (os.getenv("FLOCI_ENDPOINT_URL") or "").strip()
    if configured:
        yield FlociWireEnvironment(endpoint_url=configured, mode="floci_external")
        return

    floci_bin = shutil.which("floci")
    if floci_bin and os.getenv("HUSHH_PREFER_FLOCI_BINARY", "1") == "1":
        port = _find_free_port()
        proc = subprocess.Popen(  # noqa: S603
            [floci_bin, "start", "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            if _wait_tcp(port, timeout_s=2.5):
                yield FlociWireEnvironment(
                    endpoint_url=f"http://127.0.0.1:{port}",
                    mode="floci_native",
                )
                return
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)

    state = _WireState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _build_wire_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        host_str = host.decode("ascii") if isinstance(host, bytes) else str(host)
        yield FlociWireEnvironment(
            endpoint_url=f"http://{host_str}:{port}",
            mode="loopback_wire_reference",
            _state=state,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
