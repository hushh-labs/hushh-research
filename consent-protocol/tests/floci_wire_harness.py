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
from xml.sax.saxutils import escape as xml_escape

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _fnmatch_action(pattern: str, action: str) -> bool:
    pat = pattern.strip().lower()
    act = action.strip().lower()
    if pat == "*" or pat == act:
        return True
    if pat.endswith("*"):
        return act.startswith(pat[:-1])
    return False


@dataclass
class _WireState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    buckets: dict[str, dict[str, tuple[bytes, str]]] = field(default_factory=dict)
    forbidden_buckets: set[str] = field(default_factory=set)
    kms_keys: dict[str, bytes] = field(default_factory=dict)
    kms_aliases: dict[str, str] = field(default_factory=dict)
    disabled_kms_keys: set[str] = field(default_factory=set)
    iam_roles: dict[str, dict[str, Any]] = field(default_factory=dict)
    sts_sessions: dict[str, dict[str, str]] = field(default_factory=dict)
    sts_seq: int = 0
    ecs_clusters: dict[str, dict[str, Any]] = field(default_factory=dict)
    ecs_task_defs: dict[str, dict[str, Any]] = field(default_factory=dict)
    ecs_task_family_seq: dict[str, int] = field(default_factory=dict)
    ecs_services: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    def resolve_kms_key_id(self, raw_id: str) -> str:
        candidate = str(raw_id or "").strip()
        if ":key/alias/" in candidate:
            alias_part = "alias/" + candidate.split(":key/alias/", 1)[1]
            if alias_part in self.kms_aliases:
                return self.kms_aliases[alias_part]
        if ":alias/" in candidate:
            alias_part = "alias/" + candidate.split(":alias/", 1)[1]
            if alias_part in self.kms_aliases:
                return self.kms_aliases[alias_part]
        if candidate in self.kms_aliases:
            return self.kms_aliases[candidate]
        return candidate

    def ensure_kms_key(self, key_id: str) -> bytes:
        with self.lock:
            resolved = self.resolve_kms_key_id(key_id)
            existing = self.kms_keys.get(resolved)
            if existing is None:
                existing = os.urandom(32)
                self.kms_keys[resolved] = existing
            return existing

    def session_allows(self, session_token: str, action: str) -> bool:
        tok = (session_token or "").strip()
        if not tok:
            return True
        with self.lock:
            sess = self.sts_sessions.get(tok)
            if sess is None:
                return False
            role = self.iam_roles.get(sess["role_name"])
            if role is None:
                return False
            policies = list((role.get("Policies") or {}).values())
        for doc in policies:
            stmts = doc.get("Statement") or []
            if isinstance(stmts, dict):
                stmts = [stmts]
            for stmt in stmts:
                if str(stmt.get("Effect") or "") != "Allow":
                    continue
                actions = stmt.get("Action") or []
                if isinstance(actions, str):
                    actions = [actions]
                if any(_fnmatch_action(str(a), action) for a in actions):
                    return True
        return False


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
            resolved = self._state.resolve_kms_key_id(key_id)
            if disabled:
                self._state.disabled_kms_keys.add(resolved)
            else:
                self._state.disabled_kms_keys.discard(resolved)


def _canonical_aad(key_id: str, context: dict[str, str] | None) -> bytes:
    normalized = {str(k): str(v) for k, v in (context or {}).items()}
    payload = {"KeyId": key_id, "EncryptionContext": normalized}
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _s3_error_xml(code: str, message: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Error><Code>{code}</Code><Message>{message}</Message></Error>"
    ).encode("utf-8")


def _query_error_xml(code: str, message: str) -> bytes:
    return (
        "<ErrorResponse><Error><Type>Sender</Type>"
        f"<Code>{xml_escape(code)}</Code><Message>{xml_escape(message)}</Message>"
        "</Error><RequestId>floci-err-1</RequestId></ErrorResponse>"
    ).encode("utf-8")


def _parse_form_tags(params: dict[str, str], prefix: str = "Tags.member") -> dict[str, str]:
    out: dict[str, str] = {}
    idx = 1
    while f"{prefix}.{idx}.Key" in params:
        out[params[f"{prefix}.{idx}.Key"]] = params.get(f"{prefix}.{idx}.Value", "")
        idx += 1
    return out


def _build_wire_handler(state: _WireState) -> type[BaseHTTPRequestHandler]:
    class _Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _session_token(self) -> str:
            return (self.headers.get("X-Amz-Security-Token") or "").strip()

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

        def _send_amz_json(self, status: int, payload: dict[str, Any]) -> None:
            self._send_bytes(
                status,
                json.dumps(payload).encode("utf-8"),
                content_type="application/x-amz-json-1.1",
            )

        def _require_json_action(self, action: str) -> bool:
            if not state.session_allows(self._session_token(), action):
                self._send_amz_json(
                    400,
                    {
                        "__type": "AccessDeniedException",
                        "message": f"Assumed session is not authorized to perform {action}",
                    },
                )
                return False
            return True

        def _require_query_action(self, action: str) -> bool:
            if not state.session_allows(self._session_token(), action):
                self._send_bytes(
                    403,
                    _query_error_xml(
                        "AccessDenied",
                        f"Assumed session is not authorized to perform {action}",
                    ),
                )
                return False
            return True

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

        def _check_bucket_access(self, bucket: str, s3_action: str) -> bool:
            if not state.session_allows(self._session_token(), s3_action):
                self._send_bytes(
                    403,
                    _s3_error_xml("AccessDenied", "Access Denied"),
                )
                return False
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
            action = "s3:GetObject" if key else "s3:ListBucket"
            if not self._check_bucket_access(bucket, action):
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
            action = "s3:GetObject" if key else "s3:ListBucket"
            if not self._check_bucket_access(bucket, action):
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
            action = "s3:PutObject" if key else "s3:CreateBucket"
            if not self._check_bucket_access(bucket, action):
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
                    self._send_bytes(404, _s3_error_xml("NoSuchBucket", "NoSuchBucket"))
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
            action = "s3:DeleteObject" if key else "s3:DeleteBucket"
            if not self._check_bucket_access(bucket, action):
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

        def _handle_kms(self, op: str, payload: dict[str, Any]) -> None:
            if not self._require_json_action(f"kms:{op}"):
                return
            if op == "CreateKey":
                arn = f"arn:aws:kms:us-east-1:123456789012:key/{os.urandom(8).hex()}"
                state.ensure_kms_key(arn)
                self._send_amz_json(
                    200, {"KeyMetadata": {"KeyId": arn, "Arn": arn, "Enabled": True}}
                )
                return

            if op == "CreateAlias":
                alias_name = str(payload.get("AliasName") or "").strip()
                target_key = str(payload.get("TargetKeyId") or "").strip()
                with state.lock:
                    state.kms_aliases[alias_name] = state.resolve_kms_key_id(target_key)
                self._send_amz_json(200, {})
                return

            raw_key_id = str(payload.get("KeyId") or "").strip()
            with state.lock:
                key_id = state.resolve_kms_key_id(raw_key_id)
                disabled = key_id in state.disabled_kms_keys
                exists = key_id in state.kms_keys

            if op == "DescribeKey":
                if not exists:
                    self._send_amz_json(
                        400, {"__type": "NotFoundException", "message": "Key not found"}
                    )
                    return
                self._send_amz_json(
                    200,
                    {
                        "KeyMetadata": {
                            "KeyId": key_id,
                            "Arn": key_id,
                            "Enabled": not disabled,
                            "KeyState": "Disabled" if disabled else "Enabled",
                        }
                    },
                )
                return

            if op == "DisableKey":
                if not exists:
                    self._send_amz_json(
                        400, {"__type": "NotFoundException", "message": "Key not found"}
                    )
                    return
                with state.lock:
                    state.disabled_kms_keys.add(key_id)
                self._send_amz_json(200, {})
                return

            if op == "EnableKey":
                with state.lock:
                    state.disabled_kms_keys.discard(key_id)
                self._send_amz_json(200, {})
                return

            if disabled:
                self._send_amz_json(
                    400,
                    {"__type": "DisabledException", "message": "KMS key is disabled"},
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
                self._send_amz_json(
                    200,
                    {
                        "CiphertextBlob": base64.b64encode(envelope).decode("ascii"),
                        "KeyId": key_id,
                    },
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
                    self._send_amz_json(
                        400,
                        {"__type": "DisabledException", "message": "KMS key is disabled"},
                    )
                    return
                except Exception:  # noqa: BLE001
                    self._send_amz_json(
                        400,
                        {
                            "__type": "InvalidCiphertextException",
                            "message": "Ciphertext or EncryptionContext invalid",
                        },
                    )
                    return

                self._send_amz_json(
                    200,
                    {
                        "Plaintext": base64.b64encode(pt).decode("ascii"),
                        "KeyId": expected_key_id,
                    },
                )
                return

            self._send_amz_json(400, {"__type": "UnsupportedOperationException"})

        def _handle_ecs(self, op: str, payload: dict[str, Any]) -> None:
            if not self._require_json_action(f"ecs:{op}"):
                return
            acct = "123456789012"
            reg = "us-east-1"

            if op == "CreateCluster":
                cname = str(payload.get("clusterName") or "default")
                cluster = {
                    "clusterName": cname,
                    "clusterArn": f"arn:aws:ecs:{reg}:{acct}:cluster/{cname}",
                    "status": "ACTIVE",
                }
                with state.lock:
                    state.ecs_clusters[cname] = cluster
                self._send_amz_json(200, {"cluster": cluster})
                return

            if op == "RegisterTaskDefinition":
                family = str(payload.get("family") or "task")
                with state.lock:
                    rev = state.ecs_task_family_seq.get(family, 0) + 1
                    state.ecs_task_family_seq[family] = rev
                    arn = f"arn:aws:ecs:{reg}:{acct}:task-definition/{family}:{rev}"
                    td = {
                        "taskDefinitionArn": arn,
                        "family": family,
                        "revision": rev,
                        "status": "ACTIVE",
                        "taskRoleArn": str(payload.get("taskRoleArn") or ""),
                        "executionRoleArn": str(payload.get("executionRoleArn") or ""),
                        "containerDefinitions": payload.get("containerDefinitions") or [],
                    }
                    state.ecs_task_defs[arn] = td
                    state.ecs_task_defs[f"{family}:{rev}"] = td
                    state.ecs_task_defs[family] = td
                self._send_amz_json(200, {"taskDefinition": td})
                return

            if op == "DescribeTaskDefinition":
                ref = str(payload.get("taskDefinition") or "")
                with state.lock:
                    td_opt = state.ecs_task_defs.get(ref)
                if td_opt is None:
                    self._send_amz_json(
                        400,
                        {
                            "__type": "ClientException",
                            "message": "Unable to describe task definition",
                        },
                    )
                    return
                self._send_amz_json(200, {"taskDefinition": td_opt})
                return

            if op == "CreateService":
                cluster_raw = str(payload.get("cluster") or "default").rsplit("/", 1)[-1]
                sname = str(payload.get("serviceName") or "")
                td_ref = str(payload.get("taskDefinition") or "")
                desired = int(payload.get("desiredCount") or 0)
                with state.lock:
                    td_resolved = state.ecs_task_defs.get(td_ref) or {}
                    td_arn = str(td_resolved.get("taskDefinitionArn") or td_ref)
                    svc = {
                        "serviceName": sname,
                        "serviceArn": f"arn:aws:ecs:{reg}:{acct}:service/{cluster_raw}/{sname}",
                        "clusterArn": f"arn:aws:ecs:{reg}:{acct}:cluster/{cluster_raw}",
                        "status": "ACTIVE",
                        "desiredCount": desired,
                        "runningCount": desired,
                        "taskDefinition": td_arn,
                        "deploymentConfiguration": payload.get("deploymentConfiguration")
                        or {"maximumPercent": 100, "minimumHealthyPercent": 0},
                        "tags": list(payload.get("tags") or []),
                        "forceDeployCount": 0,
                    }
                    state.ecs_services[(cluster_raw, sname)] = svc
                self._send_amz_json(200, {"service": svc})
                return

            if op == "DescribeServices":
                cluster_raw = str(payload.get("cluster") or "default").rsplit("/", 1)[-1]
                wanted = [str(item).rsplit("/", 1)[-1] for item in (payload.get("services") or [])]
                found: list[dict[str, Any]] = []
                failures: list[dict[str, str]] = []
                with state.lock:
                    if cluster_raw not in state.ecs_clusters:
                        self._send_amz_json(
                            400,
                            {
                                "__type": "ClusterNotFoundException",
                                "message": "Cluster not found",
                            },
                        )
                        return
                    for name in wanted:
                        svc_opt = state.ecs_services.get((cluster_raw, name))
                        if svc_opt is None:
                            failures.append(
                                {
                                    "arn": f"arn:aws:ecs:{reg}:{acct}:service/{cluster_raw}/{name}",
                                    "reason": "MISSING",
                                }
                            )
                        else:
                            found.append(json.loads(json.dumps(svc_opt)))
                self._send_amz_json(200, {"services": found, "failures": failures})
                return

            if op == "UpdateService":
                cluster_raw = str(payload.get("cluster") or "default").rsplit("/", 1)[-1]
                sname = str(payload.get("service") or "").rsplit("/", 1)[-1]
                with state.lock:
                    svc_opt = state.ecs_services.get((cluster_raw, sname))
                    if svc_opt is None:
                        self._send_amz_json(
                            400,
                            {
                                "__type": "ServiceNotFoundException",
                                "message": "Service not found",
                            },
                        )
                        return
                    if "desiredCount" in payload and payload["desiredCount"] is not None:
                        desired = int(payload["desiredCount"])
                        svc_opt["desiredCount"] = desired
                        svc_opt["runningCount"] = desired
                    if payload.get("taskDefinition"):
                        td_ref = str(payload["taskDefinition"])
                        td_resolved = state.ecs_task_defs.get(td_ref) or {}
                        svc_opt["taskDefinition"] = str(
                            td_resolved.get("taskDefinitionArn") or td_ref
                        )
                    if payload.get("forceNewDeployment"):
                        svc_opt["forceDeployCount"] = int(svc_opt.get("forceDeployCount") or 0) + 1
                    snapshot = json.loads(json.dumps(svc_opt))
                self._send_amz_json(200, {"service": snapshot})
                return

            if op == "DeleteService":
                cluster_raw = str(payload.get("cluster") or "default").rsplit("/", 1)[-1]
                sname = str(payload.get("service") or "").rsplit("/", 1)[-1]
                with state.lock:
                    svc_opt = state.ecs_services.pop((cluster_raw, sname), None)
                if svc_opt is None:
                    self._send_amz_json(
                        400,
                        {"__type": "ServiceNotFoundException", "message": "Service not found"},
                    )
                    return
                svc_opt["status"] = "INACTIVE"
                self._send_amz_json(200, {"service": svc_opt})
                return

            self._send_amz_json(400, {"__type": "UnsupportedOperationException"})

        def _handle_query_xml(self, params: dict[str, str]) -> None:
            action = str(params.get("Action") or "").strip()
            sts_ns = "https://sts.amazonaws.com/doc/2011-06-15/"
            iam_ns = "https://iam.amazonaws.com/doc/2010-05-08/"

            if action == "GetCallerIdentity":
                tok = self._session_token()
                with state.lock:
                    sess = state.sts_sessions.get(tok) if tok else None
                arn = (
                    sess["role_arn"]
                    if sess is not None
                    else "arn:aws:iam::123456789012:user/floci-bootstrap"
                )
                body = (
                    f'<GetCallerIdentityResponse xmlns="{sts_ns}">'
                    "<GetCallerIdentityResult>"
                    "<UserId>floci-caller-1</UserId>"
                    "<Account>123456789012</Account>"
                    f"<Arn>{xml_escape(arn)}</Arn>"
                    "</GetCallerIdentityResult>"
                    "<ResponseMetadata><RequestId>floci-sts-1</RequestId></ResponseMetadata>"
                    "</GetCallerIdentityResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action in {"AssumeRole", "AssumeRoleWithWebIdentity"}:
                role_arn = str(params.get("RoleArn") or "").strip()
                role_name = (
                    role_arn.split(":role/", 1)[1].rsplit("/", 1)[-1]
                    if ":role/" in role_arn
                    else ""
                )
                provided_ext_id = str(params.get("ExternalId") or "").strip()
                with state.lock:
                    role = state.iam_roles.get(role_name)
                    if role is None or role.get("Arn") != role_arn:
                        self._send_bytes(
                            403,
                            _query_error_xml("AccessDenied", "Target IAM role does not exist"),
                        )
                        return
                    trust = role.get("AssumeRolePolicyDocument") or {}
                    required_ext_id = ""
                    for stmt in trust.get("Statement") or []:
                        cond = (stmt.get("Condition") or {}).get("StringEquals") or {}
                        if "sts:ExternalId" in cond:
                            required_ext_id = str(cond["sts:ExternalId"])
                    if required_ext_id and provided_ext_id and provided_ext_id != required_ext_id:
                        self._send_bytes(
                            403,
                            _query_error_xml("AccessDenied", "sts:ExternalId mismatch"),
                        )
                        return
                    state.sts_seq += 1
                    seq = state.sts_seq
                    sess_tok = f"floci-sts-session-token-{seq}-{os.urandom(6).hex()}"
                    key_id = f"floci-sts-key-{seq:04d}"
                    secret_val = f"floci-sts-sec-{seq:04d}"
                    state.sts_sessions[sess_tok] = {
                        "role_name": role_name,
                        "role_arn": role_arn,
                    }
                sess_name = str(params.get("RoleSessionName") or "session")
                assumed_arn = f"arn:aws:sts::123456789012:assumed-role/{role_name}/{sess_name}"
                body = (
                    f'<AssumeRoleResponse xmlns="{sts_ns}">'
                    "<AssumeRoleResult>"
                    "<Credentials>"
                    f"<AccessKeyId>{xml_escape(key_id)}</AccessKeyId>"
                    f"<SecretAccessKey>{xml_escape(secret_val)}</SecretAccessKey>"
                    f"<SessionToken>{xml_escape(sess_tok)}</SessionToken>"
                    "<Expiration>2030-01-01T00:00:00Z</Expiration>"
                    "</Credentials>"
                    "<AssumedRoleUser>"
                    f"<AssumedRoleId>floci-role:{xml_escape(sess_name)}</AssumedRoleId>"
                    f"<Arn>{xml_escape(assumed_arn)}</Arn>"
                    "</AssumedRoleUser>"
                    "</AssumeRoleResult>"
                    "<ResponseMetadata><RequestId>floci-sts-ar</RequestId></ResponseMetadata>"
                    "</AssumeRoleResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action == "CreateRole":
                if not self._require_query_action("iam:CreateRole"):
                    return
                rname = str(params.get("RoleName") or "").strip()
                raw_trust = str(params.get("AssumeRolePolicyDocument") or "{}")
                trust_doc = json.loads(raw_trust)
                arn = f"arn:aws:iam::123456789012:role/{rname}"
                tags = _parse_form_tags(params)
                with state.lock:
                    state.iam_roles[rname] = {
                        "RoleName": rname,
                        "Arn": arn,
                        "AssumeRolePolicyDocument": trust_doc,
                        "Policies": {},
                        "Tags": tags,
                    }
                body = (
                    f'<CreateRoleResponse xmlns="{iam_ns}">'
                    "<CreateRoleResult><Role>"
                    "<Path>/</Path>"
                    f"<RoleName>{xml_escape(rname)}</RoleName>"
                    f"<RoleId>floci-role-{xml_escape(rname[:12])}</RoleId>"
                    f"<Arn>{xml_escape(arn)}</Arn>"
                    "<CreateDate>2026-01-01T00:00:00Z</CreateDate>"
                    "</Role></CreateRoleResult>"
                    "<ResponseMetadata><RequestId>floci-iam-cr</RequestId></ResponseMetadata>"
                    "</CreateRoleResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action == "GetRole":
                if not self._require_query_action("iam:GetRole"):
                    return
                rname = str(params.get("RoleName") or "").strip()
                with state.lock:
                    role = state.iam_roles.get(rname)
                if role is None:
                    self._send_bytes(404, _query_error_xml("NoSuchEntity", "Role not found"))
                    return
                body = (
                    f'<GetRoleResponse xmlns="{iam_ns}">'
                    "<GetRoleResult><Role>"
                    "<Path>/</Path>"
                    f"<RoleName>{xml_escape(rname)}</RoleName>"
                    f"<RoleId>floci-role-{xml_escape(rname[:12])}</RoleId>"
                    f"<Arn>{xml_escape(role['Arn'])}</Arn>"
                    "<CreateDate>2026-01-01T00:00:00Z</CreateDate>"
                    "</Role></GetRoleResult>"
                    "<ResponseMetadata><RequestId>floci-iam-gr</RequestId></ResponseMetadata>"
                    "</GetRoleResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action == "PutRolePolicy":
                if not self._require_query_action("iam:PutRolePolicy"):
                    return
                rname = str(params.get("RoleName") or "").strip()
                pname = str(params.get("PolicyName") or "").strip()
                pdoc = json.loads(str(params.get("PolicyDocument") or "{}"))
                with state.lock:
                    role = state.iam_roles.get(rname)
                    if role is None:
                        self._send_bytes(404, _query_error_xml("NoSuchEntity", "Role not found"))
                        return
                    role["Policies"][pname] = pdoc
                body = (
                    f'<PutRolePolicyResponse xmlns="{iam_ns}">'
                    "<ResponseMetadata><RequestId>floci-iam-prp</RequestId></ResponseMetadata>"
                    "</PutRolePolicyResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action == "GetRolePolicy":
                if not self._require_query_action("iam:GetRolePolicy"):
                    return
                rname = str(params.get("RoleName") or "").strip()
                pname = str(params.get("PolicyName") or "").strip()
                with state.lock:
                    role = state.iam_roles.get(rname)
                    if role is None or pname not in role["Policies"]:
                        self._send_bytes(
                            404, _query_error_xml("NoSuchEntity", "Role policy not found")
                        )
                        return
                    encoded_doc = urllib.parse.quote(json.dumps(role["Policies"][pname]), safe="")
                body = (
                    f'<GetRolePolicyResponse xmlns="{iam_ns}">'
                    "<GetRolePolicyResult>"
                    f"<RoleName>{xml_escape(rname)}</RoleName>"
                    f"<PolicyName>{xml_escape(pname)}</PolicyName>"
                    f"<PolicyDocument>{xml_escape(encoded_doc)}</PolicyDocument>"
                    "</GetRolePolicyResult>"
                    "<ResponseMetadata><RequestId>floci-iam-grp</RequestId></ResponseMetadata>"
                    "</GetRolePolicyResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action == "ListRolePolicies":
                if not self._require_query_action("iam:ListRolePolicies"):
                    return
                rname = str(params.get("RoleName") or "").strip()
                with state.lock:
                    role = state.iam_roles.get(rname)
                    if role is None:
                        self._send_bytes(404, _query_error_xml("NoSuchEntity", "Role not found"))
                        return
                    pnames = sorted(role["Policies"].keys())
                members = "".join(f"<member>{xml_escape(p)}</member>" for p in pnames)
                body = (
                    f'<ListRolePoliciesResponse xmlns="{iam_ns}">'
                    "<ListRolePoliciesResult>"
                    f"<PolicyNames>{members}</PolicyNames>"
                    "<IsTruncated>false</IsTruncated>"
                    "</ListRolePoliciesResult>"
                    "<ResponseMetadata><RequestId>floci-iam-lrp</RequestId></ResponseMetadata>"
                    "</ListRolePoliciesResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            if action == "DeleteRolePolicy":
                if not self._require_query_action("iam:DeleteRolePolicy"):
                    return
                rname = str(params.get("RoleName") or "").strip()
                pname = str(params.get("PolicyName") or "").strip()
                with state.lock:
                    role = state.iam_roles.get(rname)
                    if role is None or pname not in role["Policies"]:
                        self._send_bytes(
                            404, _query_error_xml("NoSuchEntity", "Role policy not found")
                        )
                        return
                    role["Policies"].pop(pname, None)
                body = (
                    f'<DeleteRolePolicyResponse xmlns="{iam_ns}">'
                    "<ResponseMetadata><RequestId>floci-iam-drp</RequestId></ResponseMetadata>"
                    "</DeleteRolePolicyResponse>"
                ).encode("utf-8")
                self._send_bytes(200, body, content_type="text/xml")
                return

            self._send_bytes(400, _query_error_xml("InvalidAction", f"Unknown action {action}"))

        def do_POST(self) -> None:  # noqa: N802
            raw = self._read_body()
            target = (self.headers.get("X-Amz-Target") or "").strip()
            if target.startswith("TrentService."):
                payload = json.loads(raw.decode("utf-8") or "{}")
                self._handle_kms(target.split(".", 1)[1], payload)
                return
            if target.startswith("AmazonEC2ContainerServiceV20141113."):
                payload = json.loads(raw.decode("utf-8") or "{}")
                self._handle_ecs(target.split(".", 1)[1], payload)
                return
            decoded_text = raw.decode("utf-8", errors="replace")
            if "Action=" in decoded_text:
                params = dict(urllib.parse.parse_qsl(decoded_text, keep_blank_values=True))
                self._handle_query_xml(params)
                return
            self._send_amz_json(400, {"__type": "UnknownOperationException"})

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


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    cleaned = (value or "").strip()
    return base64.urlsafe_b64decode(cleaned + "=" * (-len(cleaned) % 4))


@dataclass
class _GcpWireState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    buckets: dict[str, dict[str, tuple[bytes, int]]] = field(default_factory=dict)
    next_generation: int = 1000
    forbidden_buckets: set[str] = field(default_factory=set)
    refused_tokens: set[str] = field(default_factory=set)
    strip_media_generation_header: bool = False
    kms_keys: dict[str, bytes] = field(default_factory=dict)
    disabled_kms_keys: set[str] = field(default_factory=set)

    def ensure_kms_key(self, key_name: str) -> bytes:
        with self.lock:
            existing = self.kms_keys.get(key_name)
            if existing is None:
                existing = os.urandom(32)
                self.kms_keys[key_name] = existing
            return existing


@dataclass(frozen=True)
class FlociGcpWireEnvironment:
    endpoint_url: str
    mode: str
    _state: _GcpWireState | None = None

    def set_bucket_forbidden(self, bucket: str, *, forbidden: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if forbidden:
                self._state.forbidden_buckets.add(bucket)
            else:
                self._state.forbidden_buckets.discard(bucket)

    def set_token_refused(self, token: str, *, refused: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if refused:
                self._state.refused_tokens.add(token)
            else:
                self._state.refused_tokens.discard(token)

    def set_strip_media_generation(self, strip: bool) -> None:
        if self._state is None:
            return
        with self._state.lock:
            self._state.strip_media_generation_header = strip

    def set_kms_key_disabled(self, key_name: str, *, disabled: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if disabled:
                self._state.disabled_kms_keys.add(key_name)
            else:
                self._state.disabled_kms_keys.discard(key_name)


def _gcp_kms_aad(key_name: str, extra_aad: bytes | None) -> bytes:
    payload = {
        "aad_b64": base64.b64encode(extra_aad or b"").decode("ascii"),
        "kms_key": key_name,
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _build_gcp_wire_handler(state: _GcpWireState) -> type[BaseHTTPRequestHandler]:
    class _GcpHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send_json(
            self, status: int, payload: dict[str, Any], headers: dict[str, str] | None = None
        ) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self._send_raw(status, raw, content_type="application/json", headers=headers)

        def _send_raw(
            self,
            status: int,
            body: bytes,
            *,
            content_type: str = "application/octet-stream",
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

        def _check_bearer(self, bucket: str | None = None) -> bool:
            auth = str(self.headers.get("Authorization") or "")
            if not auth.startswith("Bearer ") or not auth[7:].strip():
                self._send_json(401, {"error": {"code": 401, "message": "Unauthenticated"}})
                return False
            token = auth[7:].strip()
            with state.lock:
                if token in state.refused_tokens:
                    self._send_json(401, {"error": {"code": 401, "message": "Invalid Credentials"}})
                    return False
                if bucket and bucket in state.forbidden_buckets:
                    self._send_json(403, {"error": {"code": 403, "message": "Permission denied"}})
                    return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            # GET /storage/v1/b/{bucket}/o/{encoded_key}
            if len(parts) == 6 and parts[:3] == ["storage", "v1", "b"] and parts[4] == "o":
                bucket = parts[3]
                if not self._check_bearer(bucket):
                    return
                key = urllib.parse.unquote(parts[5])
                query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
                with state.lock:
                    entry = state.buckets.get(bucket, {}).get(key)
                    strip_gen = state.strip_media_generation_header
                if entry is None:
                    self._send_json(404, {"error": {"code": 404, "message": "No such object"}})
                    return
                data, gen = entry
                if query.get("fields") == "generation":
                    self._send_json(200, {"generation": str(gen)})
                    return
                if query.get("alt") == "media":
                    pinned = query.get("generation")
                    if pinned is not None and pinned != str(gen):
                        self._send_json(404, {"error": {"code": 404, "message": "No such version"}})
                        return
                    hdrs = {} if strip_gen else {"x-goog-generation": str(gen)}
                    self._send_raw(200, data, headers=hdrs)
                    return
                self._send_json(200, {"name": key, "bucket": bucket, "generation": str(gen)})
                return
            self._send_json(404, {"error": {"code": 404, "message": "Not Found"}})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            content_len = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(content_len) if content_len > 0 else b""
            parts = [p for p in parsed.path.strip("/").split("/") if p]

            # POST /upload/storage/v1/b/{bucket}/o?uploadType=media&name={key}&ifGenerationMatch={expected}
            if len(parts) == 5 and parts[:4] == ["upload", "storage", "v1", "b"]:
                pass
            if len(parts) == 5 and parts[:3] == ["upload", "storage", "v1"] and parts[3] == "b":
                self._send_json(404, {"error": {"code": 404}})
                return
            if (
                len(parts) == 6
                and parts[:4] == ["upload", "storage", "v1", "b"]
                and parts[5] == "o"
            ):
                bucket = parts[4]
                if not self._check_bearer(bucket):
                    return
                query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
                key = query.get("name") or ""
                expected_raw = query.get("ifGenerationMatch")
                if not key or expected_raw is None:
                    self._send_json(400, {"error": {"code": 400, "message": "Bad Request"}})
                    return
                expected_gen = int(expected_raw)
                with state.lock:
                    bmap = state.buckets.setdefault(bucket, {})
                    current = bmap.get(key)
                    current_gen = current[1] if current is not None else 0
                    if current_gen != expected_gen:
                        self._send_json(
                            412,
                            {"error": {"code": 412, "message": "Precondition Failed"}},
                        )
                        return
                    state.next_generation += 1
                    new_gen = state.next_generation
                    bmap[key] = (body, new_gen)
                self._send_json(200, {"name": key, "bucket": bucket, "generation": str(new_gen)})
                return

            # POST /v1/{kms_key}:encrypt or :decrypt
            if parsed.path.startswith("/v1/") and ":" in parsed.path:
                if not self._check_bearer():
                    return
                key_name, _, verb = parsed.path[4:].rpartition(":")
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                except ValueError:
                    self._send_json(400, {"error": {"code": 400, "message": "Malformed JSON"}})
                    return
                with state.lock:
                    disabled = key_name in state.disabled_kms_keys
                if disabled:
                    self._send_json(403, {"error": {"code": 403, "message": "KMS key disabled"}})
                    return
                extra_aad: bytes | None = None
                if "additionalAuthenticatedData" in payload:
                    extra_aad = base64.b64decode(payload["additionalAuthenticatedData"])
                if verb == "encrypt":
                    kek = state.ensure_kms_key(key_name)
                    pt = base64.b64decode(payload["plaintext"])
                    nonce = os.urandom(12)
                    ct = AESGCM(kek).encrypt(nonce, pt, _gcp_kms_aad(key_name, extra_aad))
                    blob = json.dumps(
                        {
                            "c": base64.b64encode(ct).decode("ascii"),
                            "k": key_name,
                            "n": base64.b64encode(nonce).decode("ascii"),
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                    self._send_json(
                        200,
                        {
                            "name": key_name,
                            "ciphertext": base64.b64encode(blob).decode("ascii"),
                        },
                    )
                    return
                if verb == "decrypt":
                    try:
                        raw_blob = base64.b64decode(payload["ciphertext"])
                        decoded = json.loads(raw_blob.decode("utf-8"))
                        if decoded.get("k") != key_name:
                            raise ValueError("key mismatch")
                        with state.lock:
                            kek_opt = state.kms_keys.get(key_name)
                        if kek_opt is None:
                            raise ValueError("unknown key")
                        nonce = base64.b64decode(decoded["n"])
                        ct = base64.b64decode(decoded["c"])
                        pt = AESGCM(kek_opt).decrypt(nonce, ct, _gcp_kms_aad(key_name, extra_aad))
                    except Exception:  # noqa: BLE001
                        self._send_json(
                            400,
                            {"error": {"code": 400, "message": "Decryption failed"}},
                        )
                        return
                    self._send_json(
                        200,
                        {"plaintext": base64.b64encode(pt).decode("ascii")},
                    )
                    return
            self._send_json(404, {"error": {"code": 404, "message": "Not Found"}})

        def do_DELETE(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            if len(parts) == 6 and parts[:3] == ["storage", "v1", "b"] and parts[4] == "o":
                bucket = parts[3]
                if not self._check_bearer(bucket):
                    return
                key = urllib.parse.unquote(parts[5])
                with state.lock:
                    existed = state.buckets.get(bucket, {}).pop(key, None) is not None
                if existed:
                    self._send_raw(204, b"")
                else:
                    self._send_json(404, {"error": {"code": 404, "message": "No such object"}})
                return
            self._send_json(404, {"error": {"code": 404, "message": "Not Found"}})

    return _GcpHandler


@contextmanager
def floci_gcp_wire_environment() -> Iterator[FlociGcpWireEnvironment]:
    """Yield an ephemeral loopback GCP (GCS JSON API + Cloud KMS v1) wire environment."""
    configured = (os.getenv("FLOCI_GCP_ENDPOINT_URL") or "").strip()
    if configured:
        yield FlociGcpWireEnvironment(endpoint_url=configured, mode="floci_gcp_external")
        return

    floci_gcp_bin = shutil.which("floci-gcp")
    if floci_gcp_bin and os.getenv("HUSHH_PREFER_FLOCI_BINARY", "1") == "1":
        port = _find_free_port()
        proc = subprocess.Popen(  # noqa: S603
            [floci_gcp_bin, "start", "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            if _wait_tcp(port, timeout_s=2.5):
                yield FlociGcpWireEnvironment(
                    endpoint_url=f"http://127.0.0.1:{port}",
                    mode="floci_gcp_native",
                )
                return
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)

    state = _GcpWireState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _build_gcp_wire_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        host_str = host.decode("ascii") if isinstance(host, bytes) else str(host)
        yield FlociGcpWireEnvironment(
            endpoint_url=f"http://{host_str}:{port}",
            mode="loopback_gcp_wire_reference",
            _state=state,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


@dataclass
class _AzureWireState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    expected_identity_header: str = "floci-az-msi-secret"
    msi_mint_count: int = 0
    valid_tokens: set[str] = field(default_factory=set)
    revoked_tokens: set[str] = field(default_factory=set)
    containers: dict[tuple[str, str], dict[str, tuple[bytes, str]]] = field(default_factory=dict)
    forbidden_containers: set[str] = field(default_factory=set)
    vault_keys: dict[str, Any] = field(default_factory=dict)
    disabled_vault_keys: set[str] = field(default_factory=set)

    def ensure_rsa_key(self, kid: str) -> Any:
        from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: PLC0415

        with self.lock:
            existing = self.vault_keys.get(kid)
            if existing is None:
                existing = rsa.generate_private_key(public_exponent=65537, key_size=2048)
                self.vault_keys[kid] = existing
            return existing


@dataclass(frozen=True)
class FlociAzureWireEnvironment:
    endpoint_url: str
    mode: str
    identity_header: str = "floci-az-msi-secret"
    client_id: str = "11111111-2222-3333-4444-555555555555"
    _state: _AzureWireState | None = None

    @property
    def identity_endpoint(self) -> str:
        return f"{self.endpoint_url}/msi/token"

    @property
    def msi_mint_count(self) -> int:
        if self._state is None:
            return 0
        with self._state.lock:
            return self._state.msi_mint_count

    def revoke_issued_tokens(self) -> None:
        if self._state is None:
            return
        with self._state.lock:
            self._state.revoked_tokens.update(self._state.valid_tokens)

    def set_container_forbidden(self, container: str, *, forbidden: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if forbidden:
                self._state.forbidden_containers.add(container)
            else:
                self._state.forbidden_containers.discard(container)

    def set_vault_key_disabled(self, kid: str, *, disabled: bool = True) -> None:
        if self._state is None:
            return
        with self._state.lock:
            if disabled:
                self._state.disabled_vault_keys.add(kid)
            else:
                self._state.disabled_vault_keys.discard(kid)


def _az_blob_error_xml(code: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f"<Error><Code>{code}</Code><Message>{code}</Message></Error>"
    ).encode("utf-8")


def _build_azure_wire_handler(
    state: _AzureWireState, origin_fn: Any
) -> type[BaseHTTPRequestHandler]:
    class _AzureHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send_raw(
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

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            self._send_raw(
                status,
                json.dumps(payload).encode("utf-8"),
                content_type="application/json",
            )

        def _check_bearer(self, *, container: str | None = None) -> bool:
            auth = str(self.headers.get("Authorization") or "")
            if not auth.startswith("Bearer ") or not auth[7:].strip():
                self._send_raw(
                    401,
                    _az_blob_error_xml("AuthenticationFailed"),
                    headers={"x-ms-error-code": "AuthenticationFailed"},
                )
                return False
            token = auth[7:].strip()
            with state.lock:
                if token in state.revoked_tokens:
                    self._send_raw(
                        403,
                        _az_blob_error_xml("AuthenticationFailed"),
                        headers={"x-ms-error-code": "AuthenticationFailed"},
                    )
                    return False
                if container and container in state.forbidden_containers:
                    self._send_raw(
                        403,
                        _az_blob_error_xml("AuthorizationPermissionMismatch"),
                        headers={"x-ms-error-code": "AuthorizationPermissionMismatch"},
                    )
                    return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))

            # Managed Identity token endpoint: GET /msi/token
            if parsed.path == "/msi/token":
                hdr = str(self.headers.get("X-IDENTITY-HEADER") or "")
                with state.lock:
                    expected_hdr = state.expected_identity_header
                if hdr != expected_hdr:
                    self._send_json(403, {"error": "invalid_identity_header"})
                    return
                client_id = str(query.get("client_id") or "")
                resource = str(query.get("resource") or "")
                with state.lock:
                    state.msi_mint_count += 1
                    tok = f"floci-az-msi-{state.msi_mint_count}-{client_id}"
                    state.valid_tokens.add(tok)
                self._send_json(
                    200,
                    {
                        "access_token": tok,
                        "expires_on": str(int(time.time()) + 3600),
                        "resource": resource,
                        "token_type": "Bearer",
                        "client_id": client_id,
                    },
                )
                return

            parts = [p for p in parsed.path.strip("/").split("/") if p]
            # Key Vault public JWK: GET /keys/{name}/{version}?api-version=7.4
            if len(parts) == 3 and parts[0] == "keys":
                if not self._check_bearer():
                    return
                kid = f"{origin_fn()}/keys/{parts[1]}/{parts[2]}"
                with state.lock:
                    disabled = kid in state.disabled_vault_keys
                if disabled:
                    self._send_json(403, {"error": {"code": "Forbidden"}})
                    return
                priv = state.ensure_rsa_key(kid)
                numbers = priv.public_key().public_numbers()
                n_bytes = numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")
                e_bytes = numbers.e.to_bytes((numbers.e.bit_length() + 7) // 8, "big")
                self._send_json(
                    200,
                    {
                        "key": {
                            "kid": kid,
                            "kty": "RSA",
                            "key_ops": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
                            "n": _b64url_encode(n_bytes),
                            "e": _b64url_encode(e_bytes),
                        }
                    },
                )
                return

            # Azure Blob GET /{account}/{container}/{blob_key...}
            if len(parts) >= 3:
                account, container = parts[0], parts[1]
                blob_key = urllib.parse.unquote("/".join(parts[2:]))
                if not self._check_bearer(container=container):
                    return
                with state.lock:
                    entry = state.containers.get((account, container), {}).get(blob_key)
                if entry is None:
                    self._send_raw(
                        404,
                        _az_blob_error_xml("BlobNotFound"),
                        headers={"x-ms-error-code": "BlobNotFound"},
                    )
                    return
                data, etag = entry
                self._send_raw(
                    200,
                    data,
                    content_type="application/octet-stream",
                    headers={"ETag": etag},
                )
                return

            self._send_raw(404, _az_blob_error_xml("ResourceNotFound"))

        def do_PUT(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            content_len = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(content_len) if content_len > 0 else b""
            if len(parts) < 3:
                self._send_raw(400, _az_blob_error_xml("InvalidUri"))
                return
            account, container = parts[0], parts[1]
            blob_key = urllib.parse.unquote("/".join(parts[2:]))
            if not self._check_bearer(container=container):
                return

            if_none_match = self.headers.get("If-None-Match")
            if_match = self.headers.get("If-Match")
            new_etag = f'"0x{hashlib.sha256(body + str(time.time_ns()).encode()).hexdigest()[:16]}"'
            with state.lock:
                cmap = state.containers.setdefault((account, container), {})
                current = cmap.get(blob_key)
                if if_none_match == "*" and current is not None:
                    self._send_raw(
                        409,
                        _az_blob_error_xml("BlobAlreadyExists"),
                        headers={"x-ms-error-code": "BlobAlreadyExists"},
                    )
                    return
                if if_match is not None:
                    if current is None:
                        self._send_raw(
                            404,
                            _az_blob_error_xml("BlobNotFound"),
                            headers={"x-ms-error-code": "BlobNotFound"},
                        )
                        return
                    if current[1] != if_match:
                        self._send_raw(
                            412,
                            _az_blob_error_xml("ConditionNotMet"),
                            headers={"x-ms-error-code": "ConditionNotMet"},
                        )
                        return
                cmap[blob_key] = (body, new_etag)

            self._send_raw(201, b"", headers={"ETag": new_etag})

        def do_POST(self) -> None:  # noqa: N802
            from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
            from cryptography.hazmat.primitives.asymmetric import padding  # noqa: PLC0415

            parsed = urllib.parse.urlsplit(self.path)
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            content_len = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(content_len) if content_len > 0 else b""

            # Key Vault unwrap: POST /keys/{name}/{version}/unwrapkey?api-version=7.4
            if len(parts) == 4 and parts[0] == "keys" and parts[3] == "unwrapkey":
                if not self._check_bearer():
                    return
                kid = f"{origin_fn()}/keys/{parts[1]}/{parts[2]}"
                with state.lock:
                    disabled = kid in state.disabled_vault_keys
                if disabled:
                    self._send_json(403, {"error": {"code": "Forbidden"}})
                    return
                priv = state.ensure_rsa_key(kid)
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    if payload.get("alg") != "RSA-OAEP-256":
                        raise ValueError("alg")
                    ct = _b64url_decode(str(payload.get("value") or ""))
                    pt = priv.decrypt(
                        ct,
                        padding.OAEP(
                            mgf=padding.MGF1(hashes.SHA256()),
                            algorithm=hashes.SHA256(),
                            label=None,
                        ),
                    )
                except Exception:  # noqa: BLE001
                    self._send_json(400, {"error": {"code": "BadParameter"}})
                    return
                self._send_json(200, {"kid": kid, "value": _b64url_encode(pt)})
                return

            self._send_json(404, {"error": {"code": "NotFound"}})

        def do_DELETE(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            if len(parts) >= 3:
                account, container = parts[0], parts[1]
                blob_key = urllib.parse.unquote("/".join(parts[2:]))
                if not self._check_bearer(container=container):
                    return
                with state.lock:
                    existed = (
                        state.containers.get((account, container), {}).pop(blob_key, None)
                        is not None
                    )
                if existed:
                    self._send_raw(202, b"")
                else:
                    self._send_raw(
                        404,
                        _az_blob_error_xml("BlobNotFound"),
                        headers={"x-ms-error-code": "BlobNotFound"},
                    )
                return
            self._send_raw(404, _az_blob_error_xml("ResourceNotFound"))

    return _AzureHandler


@contextmanager
def floci_azure_wire_environment() -> Iterator[FlociAzureWireEnvironment]:
    """Yield an ephemeral loopback Azure (Blob 2023-11-03 + Key Vault 7.4 + MSI) environment."""
    configured = (os.getenv("FLOCI_AZ_ENDPOINT_URL") or "").strip()
    if configured:
        yield FlociAzureWireEnvironment(endpoint_url=configured, mode="floci_az_external")
        return

    floci_az_bin = shutil.which("floci-az")
    if floci_az_bin and os.getenv("HUSHH_PREFER_FLOCI_BINARY", "1") == "1":
        port = _find_free_port()
        proc = subprocess.Popen(  # noqa: S603
            [floci_az_bin, "start", "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            if _wait_tcp(port, timeout_s=2.5):
                yield FlociAzureWireEnvironment(
                    endpoint_url=f"http://127.0.0.1:{port}",
                    mode="floci_az_native",
                )
                return
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1.0)

    state = _AzureWireState()
    origin_box: list[str] = [""]
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        _build_azure_wire_handler(state, lambda: origin_box[0]),
    )
    host, port = server.server_address[:2]
    host_str = host.decode("ascii") if isinstance(host, bytes) else str(host)
    origin_box[0] = f"http://{host_str}:{port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield FlociAzureWireEnvironment(
            endpoint_url=origin_box[0],
            mode="loopback_azure_wire_reference",
            _state=state,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


@dataclass
class _PrefixGatewayState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    objects: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    clock_offset_seconds: int = 0
    secret: bytes | None = None


@dataclass(frozen=True)
class FlociPrefixGatewayEnvironment:
    endpoint_url: str
    _state: _PrefixGatewayState

    def advance_clock(self, seconds: int) -> None:
        with self._state.lock:
            self._state.clock_offset_seconds += int(seconds)


def _build_prefix_gateway_handler(state: _PrefixGatewayState) -> type[BaseHTTPRequestHandler]:
    from hushh_mcp.services.pod_capability_broker import (  # noqa: PLC0415
        PodCapabilityBrokerForbidden,
        PodCapabilityBrokerUnauthorized,
        verify_prefix_gateway_token,
    )

    class _GatewayHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send_raw(
            self, status: int, body: bytes, *, headers: dict[str, str] | None = None
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            for hk, hv in (headers or {}).items():
                self.send_header(hk, hv)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _authorize_object(self) -> str | None:
            parsed = urllib.parse.urlsplit(self.path)
            object_path = urllib.parse.unquote(parsed.path.strip("/"))
            auth = str(self.headers.get("Authorization") or "")
            if not auth.startswith("Bearer ") or not auth[7:].strip():
                self._send_raw(401, b"missing bearer")
                return None
            token = auth[7:].strip()
            with state.lock:
                now_epoch = int(time.time()) + state.clock_offset_seconds
                secret = state.secret
            try:
                verify_prefix_gateway_token(
                    token,
                    object_path=object_path,
                    now_epoch=now_epoch,
                    secret=secret,
                )
            except PodCapabilityBrokerUnauthorized:
                self._send_raw(401, b"expired token")
                return None
            except PodCapabilityBrokerForbidden:
                self._send_raw(403, b"forbidden prefix")
                return None
            return object_path

        def do_GET(self) -> None:  # noqa: N802
            obj = self._authorize_object()
            if obj is None:
                return
            with state.lock:
                entry = state.objects.get(obj)
            if entry is None:
                self._send_raw(404, b"")
                return
            data, etag = entry
            self._send_raw(200, data, headers={"ETag": etag})

        def do_PUT(self) -> None:  # noqa: N802
            content_len = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(content_len) if content_len > 0 else b""
            obj = self._authorize_object()
            if obj is None:
                return
            if_none_match = self.headers.get("If-None-Match")
            if_match = self.headers.get("If-Match")
            new_etag = f'"{hashlib.sha256(body + str(time.time_ns()).encode()).hexdigest()[:24]}"'
            with state.lock:
                current = state.objects.get(obj)
                if if_none_match == "*" and current is not None:
                    self._send_raw(409, b"conflict")
                    return
                if if_match is not None:
                    if current is None:
                        self._send_raw(404, b"absent")
                        return
                    if current[1] != if_match:
                        self._send_raw(412, b"precondition failed")
                        return
                state.objects[obj] = (body, new_etag)
            self._send_raw(201, b"", headers={"ETag": new_etag})

        def do_DELETE(self) -> None:  # noqa: N802
            obj = self._authorize_object()
            if obj is None:
                return
            with state.lock:
                existed = state.objects.pop(obj, None) is not None
            self._send_raw(204 if existed else 404, b"")

    return _GatewayHandler


@contextmanager
def floci_prefix_gateway_environment(
    *, secret: bytes | None = None
) -> Iterator[FlociPrefixGatewayEnvironment]:
    """Yield an ephemeral loopback HTTPS-equivalent prefix capability storage gateway."""
    state = _PrefixGatewayState(secret=secret)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _build_prefix_gateway_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        host_str = host.decode("ascii") if isinstance(host, bytes) else str(host)
        yield FlociPrefixGatewayEnvironment(
            endpoint_url=f"http://{host_str}:{port}",
            _state=state,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
