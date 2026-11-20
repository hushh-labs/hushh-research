# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Out-of-sandbox Sentinel HTTP/CONNECT proxy daemon and durable audit sink (#9744)."""

from __future__ import annotations

import datetime
import hmac
import http.client
import json
import os
import re
import secrets
import select
import signal
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from hushh_mcp.operons.agent_sandbox.egress_policy import DomainRuleMode, evaluate_sandbox_egress
from hushh_mcp.operons.agent_sandbox.tamper_evident_audit import (
    AuditEntry,
    TamperEvidentAuditLedger,
)
from hushh_mcp.services.agent_sandbox.sentinel_egress_proxy import (
    AUDIT_UNAVAILABLE,
    SURROGATE_EXFILTRATION_BLOCKED,
    SentinelEgressError,
    SentinelEgressGatekeeper,
)

UpstreamTransport = Callable[
    [str, str, Mapping[str, str], bytes], tuple[int, dict[str, str], bytes]
]
ModelStreamTransport = Callable[
    [str, str, Mapping[str, str], bytes], tuple[int, dict[str, str], Iterable[bytes]]
]
VertexTokenProvider = Callable[[], str]
DnsResolver = Callable[[str, int], list[str]]

DEFAULT_PROXY_PORT = 3128
DEFAULT_CONTROL_PORT = 8081
DEFAULT_MODEL_GATEWAY_PORT = 8082
SENTINEL_ROOT_FORBIDDEN = "SENTINEL_ROOT_FORBIDDEN"
MODEL_GATEWAY_PATH_FORBIDDEN = "MODEL_GATEWAY_PATH_FORBIDDEN"
MODEL_GATEWAY_AUTH_REQUIRED = "MODEL_GATEWAY_AUTH_REQUIRED"
MODEL_SURROGATE_IP_MISMATCH = "MODEL_SURROGATE_IP_MISMATCH"
MODEL_GATEWAY_UNAVAILABLE = "MODEL_GATEWAY_UNAVAILABLE"
_MAX_BODY_BYTES = 2 * 1024 * 1024
_MAX_MODEL_BODY_BYTES = 16 * 1024 * 1024
_MAX_MODEL_RESPONSE_BYTES = 16 * 1024 * 1024
_SURROGATE_RE = re.compile(r"hsur_[a-f0-9]{48}")
_VERTEX_MODEL_PATH_RE = re.compile(
    r"^/(v1|v1beta1)/projects/([a-z][a-z0-9-]{4,28}[a-z0-9])/locations/([a-z0-9-]+)/"
    r"publishers/google/models/([A-Za-z0-9._-]+):(generateContent|streamGenerateContent|countTokens)$"
)
_CONTROL_POLICY_PATH_RE = re.compile(r"^/v1/leases/([^/]+)/policy$")
_CONTROL_SURROGATE_PATH_RE = re.compile(r"^/v1/leases/([^/]+)/model-surrogate$")
_CONTROL_LEASE_PATH_RE = re.compile(r"^/v1/leases/([^/]+)$")
_HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "content-length",
    }
)


@dataclass
class ModelSurrogateGrant:
    """Short-lived surrogate bearer grant swapped by Sentinel :8082 for Vertex OAuth2."""

    surrogate_token: str
    owner_id: str
    lease_id: str
    expires_at_s: int
    revoked: bool = False


class DurableAuditSink(TamperEvidentAuditLedger):
    """Thread-safe HMAC audit ledger with atomic JSONL persistence outside the sandbox."""

    def __init__(
        self,
        hmac_key: bytes,
        *,
        audit_log_path: Path | None = None,
        clock_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(hmac_key, clock_ms=clock_ms)
        self._lock = threading.Lock()
        self.audit_log_path = audit_log_path
        if self.audit_log_path is not None:
            self.audit_log_path.parent.mkdir(parents=True, exist_ok=True)
            if self.audit_log_path.exists():
                self._load_existing(self.audit_log_path)

    def _load_existing(self, path: Path) -> None:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            clean = raw_line.strip()
            if not clean:
                continue
            item = json.loads(clean)
            self._entries.append(AuditEntry(**item))
        self.verify_chain()

    def append(
        self,
        *,
        lease_id: str,
        owner_id: str,
        event_type: str,
        payload: Mapping[str, Any] | None = None,
    ) -> AuditEntry:
        with self._lock:
            entry = super().append(
                lease_id=lease_id,
                owner_id=owner_id,
                event_type=event_type,
                payload=payload,
            )
            if self.audit_log_path is not None:
                try:
                    line = json.dumps(asdict(entry), sort_keys=True, separators=(",", ":"))
                    with self.audit_log_path.open("a", encoding="utf-8") as handle:
                        handle.write(line + "\n")
                        handle.flush()
                        os.fsync(handle.fileno())
                except OSError as exc:
                    self._entries.pop()
                    raise SentinelEgressError(
                        AUDIT_UNAVAILABLE, f"Audit sink write failed: {exc}", status=503
                    ) from exc
            return entry

    def entries_for_lease(self, lease_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            self.verify_chain()
            rows = (
                self._entries
                if not lease_id
                else [e for e in self._entries if e.lease_id == lease_id]
            )
            return [asdict(entry) for entry in rows]


def _default_dns_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos if info[4]})


def _default_https_transport(
    url: str, method: str, headers: Mapping[str, str], body: bytes
) -> tuple[int, dict[str, str], bytes]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Only HTTPS URLs permitted at upstream edge")
    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection(
        parsed.hostname,
        parsed.port or 443,
        timeout=20.0,
        context=ctx,
    )
    try:
        target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        req_body = body if body or method in {"POST", "PUT", "PATCH"} else None
        conn.request(method, target, body=req_body, headers=dict(headers))
        resp = conn.getresponse()
        return int(resp.status), dict(resp.getheaders()), resp.read(_MAX_BODY_BYTES)
    finally:
        conn.close()


class _CachedVertexTokenProvider:
    """Thread-safe GCP Vertex OAuth2 token cache with 120s expiry refresh buffer."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._creds: Any = None

    def __call__(self) -> str:
        import google.auth  # noqa: PLC0415
        from google.auth.transport.requests import Request as GoogleAuthRequest  # noqa: PLC0415

        with self._lock:
            if self._creds is None:
                creds, _ = google.auth.default(
                    scopes=["https://www.googleapis.com/auth/cloud-platform"]
                )
                self._creds = creds
            token = getattr(self._creds, "token", None)
            expiry = getattr(self._creds, "expiry", None)
            needs_refresh = not token
            if expiry is not None:
                now = (
                    datetime.datetime.now(datetime.timezone.utc)
                    if expiry.tzinfo is not None
                    else datetime.datetime.utcnow()
                )
                if (expiry - now).total_seconds() < 120:
                    needs_refresh = True
            if needs_refresh or not getattr(self._creds, "valid", False):
                self._creds.refresh(GoogleAuthRequest())
            refreshed = str(getattr(self._creds, "token", "") or "").strip()
            if not refreshed:
                raise RuntimeError("Sentinel GCP Vertex token unavailable")
            return refreshed


def _default_model_stream_transport(
    url: str, method: str, headers: Mapping[str, str], body: bytes
) -> tuple[int, dict[str, str], Iterable[bytes]]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Only HTTPS URLs permitted at model upstream edge")
    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection(
        parsed.hostname,
        parsed.port or 443,
        timeout=120.0,
        context=ctx,
    )
    target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    conn.request(method, target, body=body if body else None, headers=dict(headers))
    resp = conn.getresponse()
    resp_headers = {str(k): str(v) for k, v in resp.getheaders()}

    def _chunks() -> Iterator[bytes]:
        try:
            while True:
                chunk = resp.read1(16384)
                if not chunk:
                    break
                yield chunk
        finally:
            conn.close()

    return int(resp.status), resp_headers, _chunks()


def _normalize_client_ip(raw_ip: str | None) -> str:
    ip = str(raw_ip or "").strip()
    if ip.startswith("::ffff:"):
        ip = ip[len("::ffff:") :]
    return ip


def build_sentinel_readiness_payload(
    *, audit_sink: DurableAuditSink, uid: int | None = None
) -> dict[str, Any]:
    """Return Sentinel readiness telemetry after enforcing non-root execution."""
    effective_uid = os.getuid() if uid is None else int(uid)
    effective_euid = os.geteuid() if uid is None else int(uid)
    if effective_uid == 0 or effective_euid == 0:
        raise PermissionError(f"{SENTINEL_ROOT_FORBIDDEN}: Sentinel cannot run as root")
    entries = audit_sink.entries_for_lease()
    return {
        "status": "sentinel_ready",
        "uid": effective_uid,
        "audit_entries": len(entries),
        "chain_valid": True,
    }


class SentinelProxyRuntime:
    """Out-of-sandbox proxy (:3128), control API (:8081), and Vertex model gateway (:8082)."""

    def __init__(
        self,
        *,
        hmac_key: bytes,
        control_token: str,
        audit_log_path: Path | None = None,
        proxy_host: str = "127.0.0.1",
        proxy_port: int = DEFAULT_PROXY_PORT,
        control_host: str = "127.0.0.1",
        control_port: int = DEFAULT_CONTROL_PORT,
        model_gateway_host: str | None = None,
        model_gateway_port: int | None = None,
        default_mode: str = "deny",
        system_allow_hosts: Sequence[str] = (),
        upstream_transport: UpstreamTransport | None = None,
        model_upstream_transport: ModelStreamTransport | None = None,
        vertex_token_provider: VertexTokenProvider | None = None,
        dns_resolver: DnsResolver | None = None,
        clock_s: Callable[[], int] | None = None,
    ) -> None:
        clean_token = str(control_token or "").strip()
        if len(clean_token) < 16:
            raise ValueError("control_token must be at least 16 characters")
        self._clock_s = clock_s or (lambda: int(time.time()))
        self.audit_sink = DurableAuditSink(hmac_key, audit_log_path=audit_log_path)
        self.gatekeeper = SentinelEgressGatekeeper(self.audit_sink, clock_s=self._clock_s)
        self._control_token = clean_token
        self.default_mode = "deny" if default_mode == "deny" else "ask"
        self.system_allow_hosts: tuple[str, ...] = tuple(
            dict.fromkeys(
                str(host or "").strip().lower().rstrip(".")
                for host in system_allow_hosts
                if str(host or "").strip()
            )
        )
        self._upstream = upstream_transport or _default_https_transport
        self._model_upstream = model_upstream_transport or _default_model_stream_transport
        self._vertex_token_provider = vertex_token_provider or _CachedVertexTokenProvider()
        self._dns = dns_resolver or _default_dns_resolver
        self._lock = threading.Lock()
        self._lease_policies: dict[str, dict[str, DomainRuleMode]] = {}
        self._ip_leases: dict[str, tuple[str, str]] = {}
        self._model_surrogates: dict[str, ModelSurrogateGrant] = {}
        resolved_gw_host = proxy_host if model_gateway_host is None else model_gateway_host
        resolved_gw_port = (
            (0 if proxy_port == 0 and control_port == 0 else DEFAULT_MODEL_GATEWAY_PORT)
            if model_gateway_port is None
            else int(model_gateway_port)
        )
        self.proxy_server = self._make_proxy_server(proxy_host, proxy_port)
        self.control_server = self._make_control_server(control_host, control_port)
        self.model_gateway_server = self._make_model_gateway_server(
            resolved_gw_host, resolved_gw_port
        )
        self._threads: list[threading.Thread] = []

    @property
    def proxy_port(self) -> int:
        return int(self.proxy_server.server_address[1])

    @property
    def control_port(self) -> int:
        return int(self.control_server.server_address[1])

    @property
    def model_gateway_port(self) -> int:
        return int(self.model_gateway_server.server_address[1])

    def set_lease_policy(
        self,
        lease_id: str,
        rules: Mapping[str, DomainRuleMode],
        *,
        owner_id: str | None = None,
        pod_ip: str | None = None,
    ) -> None:
        clean_ip = _normalize_client_ip(pod_ip)
        with self._lock:
            current = dict(self._lease_policies.get(lease_id, {}))
            for host, mode in rules.items():
                clean_host = str(host or "").strip().lower().rstrip(".")
                if clean_host and mode in {"allow", "ask", "deny"}:
                    current[clean_host] = mode
            self._lease_policies[lease_id] = current
            if clean_ip:
                resolved_owner = str(owner_id or "sandbox").strip() or "sandbox"
                self._ip_leases[clean_ip] = (lease_id, resolved_owner)

    def lease_for_ip(self, client_ip: str | None) -> tuple[str, str] | None:
        clean_ip = _normalize_client_ip(client_ip)
        if not clean_ip:
            return None
        with self._lock:
            return self._ip_leases.get(clean_ip)

    def policy_for_lease(self, lease_id: str) -> dict[str, DomainRuleMode]:
        with self._lock:
            return dict(self._lease_policies.get(lease_id, {}))

    def effective_policy_for_lease(self, lease_id: str) -> dict[str, DomainRuleMode]:
        with self._lock:
            merged: dict[str, DomainRuleMode] = {host: "allow" for host in self.system_allow_hosts}
            merged.update(self._lease_policies.get(lease_id, {}))
            return merged

    def mint_model_surrogate(
        self, *, lease_id: str, owner_id: str, ttl_seconds: int = 3600
    ) -> tuple[str, int]:
        ttl = max(60, min(7200, int(ttl_seconds)))
        expires_at_s = int(self._clock_s()) + ttl
        token = f"hsur_{secrets.token_hex(24)}"
        with self._lock:
            self._model_surrogates[token] = ModelSurrogateGrant(
                surrogate_token=token,
                owner_id=str(owner_id),
                lease_id=str(lease_id),
                expires_at_s=expires_at_s,
            )
        self.audit_sink.append(
            lease_id=str(lease_id),
            owner_id=str(owner_id),
            event_type="MODEL_SURROGATE_ISSUED",
            payload={"ttl_seconds": ttl},
        )
        return token, expires_at_s

    def delete_lease(self, lease_id: str) -> None:
        clean_lease = str(lease_id).strip()
        with self._lock:
            self.gatekeeper.revoke_lease_surrogates(clean_lease)
            for grant in self._model_surrogates.values():
                if grant.lease_id == clean_lease:
                    grant.revoked = True
            self._lease_policies.pop(clean_lease, None)
            stale_ips = [ip for ip, pair in self._ip_leases.items() if pair[0] == clean_lease]
            for ip in stale_ips:
                self._ip_leases.pop(ip, None)
        self.audit_sink.append(
            lease_id=clean_lease or "unknown",
            owner_id="control",
            event_type="LEASE_POLICY_DELETED",
            payload={"lease_id": clean_lease},
        )

    def _revoke_model_surrogates_in_text(
        self, *, lease_id: str, owner_id: str, values: Iterable[str], channel: str
    ) -> None:
        found: set[str] = set()
        for value in values:
            if value:
                found.update(_SURROGATE_RE.findall(str(value)))
        if not found:
            return
        with self._lock:
            matched = [
                self._model_surrogates[tok] for tok in found if tok in self._model_surrogates
            ]
            for grant in matched:
                grant.revoked = True
        if matched:
            self.audit_sink.append(
                lease_id=lease_id,
                owner_id=owner_id,
                event_type="MODEL_SURROGATE_EXFILTRATION_BLOCKED",
                payload={"channel": channel},
            )
            raise SentinelEgressError(
                SURROGATE_EXFILTRATION_BLOCKED,
                "Model surrogate token cannot traverse web egress",
                status=403,
            )

    def authorize_model_surrogate(
        self, token: str, *, client_ip: str | None
    ) -> ModelSurrogateGrant:
        now_s = int(self._clock_s())
        clean_ip = _normalize_client_ip(client_ip)
        with self._lock:
            grant = self._model_surrogates.get(token)
            if grant is None:
                raise SentinelEgressError(
                    MODEL_GATEWAY_AUTH_REQUIRED, "Unknown model surrogate token", status=401
                )
            if grant.revoked or now_s >= grant.expires_at_s:
                raise SentinelEgressError(
                    MODEL_GATEWAY_AUTH_REQUIRED, "Expired or revoked model surrogate", status=401
                )
            ip_binding = self._ip_leases.get(clean_ip) if clean_ip else None
            if ip_binding is not None and ip_binding[0] != grant.lease_id:
                grant.revoked = True
                mismatch_lease = grant.lease_id
                mismatch_owner = grant.owner_id
            else:
                mismatch_lease = ""
                mismatch_owner = ""
        if mismatch_lease:
            self.audit_sink.append(
                lease_id=mismatch_lease,
                owner_id=mismatch_owner,
                event_type="MODEL_SURROGATE_IP_MISMATCH",
                payload={"client_ip": clean_ip},
            )
            raise SentinelEgressError(
                MODEL_SURROGATE_IP_MISMATCH, "Model surrogate IP binding mismatch", status=403
            )
        return grant

    def resolve_target_ips(self, url: str) -> list[str]:
        parsed = urllib.parse.urlsplit(url)
        host = (parsed.hostname or "").strip().lower().rstrip(".")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if not host:
            return []
        try:
            return self._dns(host, port)
        except OSError:
            return []

    def handle_forward(
        self,
        *,
        owner_id: str,
        lease_id: str,
        url: str,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        body_text: str = "",
    ) -> tuple[int, dict[str, Any]]:
        self._revoke_model_surrogates_in_text(
            lease_id=lease_id,
            owner_id=owner_id,
            values=[url, body_text, *(str(v) for v in (headers or {}).values())],
            channel="http_forward",
        )
        resolved_ips = self.resolve_target_ips(url)
        rules = self.effective_policy_for_lease(lease_id)
        with self._lock:
            prepared = self.gatekeeper.authorize_and_prepare_egress(
                owner_id=owner_id,
                lease_id=lease_id,
                url=url,
                resolved_ips=resolved_ips,
                method=method,
                headers=headers,
                body_text=body_text,
                domain_rules=rules,
                default_mode=self.default_mode,
            )
        status, resp_headers, raw_body = self._upstream(
            url,
            str(method or "GET").upper(),
            prepared.outbound_headers,
            body_text.encode("utf-8"),
        )
        return status, {
            "status": status,
            "headers": resp_headers,
            "body": raw_body.decode("utf-8", errors="replace"),
            "audit_seq": prepared.audit_seq,
        }

    def _make_proxy_server(self, host: str, port: int) -> ThreadingHTTPServer:
        runtime = self

        class _ProxyHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def _send_json(self, code: int, payload: Mapping[str, Any]) -> None:
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/healthz":
                    self._send_json(200, {"status": "proxy_ready"})
                    return
                owner_id = str(self.headers.get("X-Hussh-Owner-Id") or "unknown")
                lease_id = str(self.headers.get("X-Hussh-Lease-Id") or "unknown")
                try:
                    self.runtime_ref.audit_sink.append(
                        lease_id=lease_id,
                        owner_id=owner_id,
                        event_type="EGRESS_HTTP_CLEARTEXT_DENY",
                        payload={"target": self.path},
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return
                self._send_json(
                    403,
                    {"code": "EGRESS_BLOCKED_SCHEME", "detail": "Cleartext HTTP proxy blocked"},
                )

            def do_POST(self) -> None:  # noqa: N802
                if self.path != "/v1/egress/forward":
                    self._send_json(404, {"code": "NOT_FOUND"})
                    return
                owner_id = str(self.headers.get("X-Hussh-Owner-Id") or "").strip()
                lease_id = str(self.headers.get("X-Hussh-Lease-Id") or "").strip()
                if not owner_id or not lease_id:
                    self._send_json(401, {"code": "SANDBOX_LEASE_HEADERS_REQUIRED"})
                    return
                length = int(self.headers.get("Content-Length") or "0")
                if length < 0 or length > _MAX_BODY_BYTES:
                    self._send_json(413, {"code": "PAYLOAD_TOO_LARGE"})
                    return
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
                try:
                    upstream_status, resp = runtime.handle_forward(
                        owner_id=owner_id,
                        lease_id=lease_id,
                        url=str(payload.get("url") or ""),
                        method=str(payload.get("method") or "GET"),
                        headers=payload.get("headers") or {},
                        body_text=str(payload.get("body") or ""),
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return
                self._send_json(upstream_status, resp)

            def do_CONNECT(self) -> None:  # noqa: N802
                host_port = self.path.strip()
                target_host, _, port_str = host_port.partition(":")
                target_port = int(port_str or "443")
                raw_lease = str(self.headers.get("X-Hussh-Lease-Id") or "").strip()
                raw_owner = str(self.headers.get("X-Hussh-Owner-Id") or "").strip()
                if raw_lease:
                    lease_id = raw_lease
                    owner_id = raw_owner or "sandbox"
                else:
                    bound = runtime.lease_for_ip(self.client_address[0])
                    if bound is not None:
                        lease_id, owner_id = bound
                    else:
                        lease_id = "unclaimed"
                        owner_id = raw_owner or "sandbox"
                try:
                    runtime._revoke_model_surrogates_in_text(
                        lease_id=lease_id,
                        owner_id=owner_id,
                        values=[host_port, *(str(v) for v in self.headers.values())],
                        channel="connect_tunnel",
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return
                url = f"https://{target_host}:{target_port}"
                ips = runtime.resolve_target_ips(url)
                verdict = evaluate_sandbox_egress(
                    url,
                    resolved_ips=ips,
                    method="CONNECT",
                    domain_rules=runtime.effective_policy_for_lease(lease_id),
                    default_mode=runtime.default_mode,
                )
                try:
                    runtime.audit_sink.append(
                        lease_id=lease_id,
                        owner_id=owner_id,
                        event_type=f"CONNECT_{verdict.decision.upper()}",
                        payload={"origin": verdict.normalized_origin, "code": verdict.code},
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code})
                    return
                if verdict.decision != "allow":
                    self._send_json(403, {"code": verdict.code, "detail": verdict.reason})
                    return
                try:
                    upstream = socket.create_connection((ips[0], target_port), timeout=10.0)
                except OSError as exc:
                    self._send_json(502, {"code": "UPSTREAM_CONNECT_FAILED", "detail": str(exc)})
                    return
                self.send_response(200, "Connection Established")
                self.end_headers()
                client_sock = self.connection
                try:
                    while True:
                        readable, _, _ = select.select([client_sock, upstream], [], [], 30.0)
                        if not readable:
                            break
                        for sock in readable:
                            data = sock.recv(16384)
                            if not data:
                                return
                            dest = upstream if sock is client_sock else client_sock
                            dest.sendall(data)
                finally:
                    upstream.close()

            @property
            def runtime_ref(self) -> SentinelProxyRuntime:
                return runtime

        return ThreadingHTTPServer((host, port), _ProxyHandler)

    def _make_control_server(self, host: str, port: int) -> ThreadingHTTPServer:
        runtime = self

        class _ControlHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def _send_json(self, code: int, payload: Mapping[str, Any]) -> None:
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self) -> bool:
                supplied = str(self.headers.get("X-Sentinel-Control-Token") or "")
                return hmac.compare_digest(supplied, runtime._control_token)

            def _read_json(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length > 0 else b"{}"
                loaded = json.loads(raw.decode("utf-8"))
                return dict(loaded) if isinstance(loaded, dict) else {}

            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path in {"/healthz", "/readyz"}:
                    self._send_json(
                        200, build_sentinel_readiness_payload(audit_sink=runtime.audit_sink)
                    )
                    return
                if not self._authorized():
                    self._send_json(401, {"code": "SENTINEL_CONTROL_UNAUTHORIZED"})
                    return
                if parsed.path == "/v1/audit/verify":
                    qs = urllib.parse.parse_qs(parsed.query)
                    lease_id = (qs.get("lease_id") or [None])[0]
                    entries = runtime.audit_sink.entries_for_lease(lease_id)
                    self._send_json(
                        200,
                        {"chain_valid": True, "count": len(entries), "entries": entries[-50:]},
                    )
                    return
                self._send_json(404, {"code": "NOT_FOUND"})

            def do_POST(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._send_json(401, {"code": "SENTINEL_CONTROL_UNAUTHORIZED"})
                    return
                body = self._read_json()
                if self.path == "/v1/surrogates/issue":
                    with runtime._lock:
                        token = runtime.gatekeeper.issue_surrogate(
                            owner_id=str(body["owner_id"]),
                            lease_id=str(body["lease_id"]),
                            allowed_origin=str(body["allowed_origin"]),
                            header_name=str(body["header_name"]),
                            real_secret=str(body["real_secret"]),
                            ttl_seconds=int(body.get("ttl_seconds", 300)),
                        )
                    origin_host = urllib.parse.urlsplit(str(body["allowed_origin"])).hostname or ""
                    if origin_host:
                        runtime.set_lease_policy(str(body["lease_id"]), {origin_host: "allow"})
                    self._send_json(200, {"surrogate_token": token})
                    return
                if self.path == "/v1/surrogates/revoke":
                    with runtime._lock:
                        revoked = runtime.gatekeeper.revoke_lease_surrogates(str(body["lease_id"]))
                    self._send_json(200, {"revoked": revoked})
                    return
                if self.path == "/v1/policies/set":
                    runtime.set_lease_policy(str(body["lease_id"]), body.get("domain_rules") or {})
                    self._send_json(200, {"updated": True})
                    return
                surrogate_match = _CONTROL_SURROGATE_PATH_RE.fullmatch(self.path.split("?", 1)[0])
                if surrogate_match:
                    lease_id = urllib.parse.unquote(surrogate_match.group(1)).strip()
                    owner_id = str(body.get("owner_id") or "").strip()
                    if not lease_id or not owner_id:
                        self._send_json(400, {"code": "INVALID_SURROGATE_REQUEST"})
                        return
                    try:
                        token, expires_at_s = runtime.mint_model_surrogate(
                            lease_id=lease_id,
                            owner_id=owner_id,
                            ttl_seconds=int(body.get("ttl_seconds", 3600)),
                        )
                    except SentinelEgressError as exc:
                        self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                        return
                    self._send_json(200, {"surrogate_token": token, "expires_at_s": expires_at_s})
                    return
                self._send_json(404, {"code": "NOT_FOUND"})

            def do_PUT(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._send_json(401, {"code": "SENTINEL_CONTROL_UNAUTHORIZED"})
                    return
                policy_match = _CONTROL_POLICY_PATH_RE.fullmatch(self.path.split("?", 1)[0])
                if not policy_match:
                    self._send_json(404, {"code": "NOT_FOUND"})
                    return
                lease_id = urllib.parse.unquote(policy_match.group(1)).strip()
                if not lease_id:
                    self._send_json(400, {"code": "INVALID_LEASE_ID"})
                    return
                body = self._read_json()
                owner_id = str(body.get("owner_id") or "sandbox").strip() or "sandbox"
                pod_ip = str(body.get("pod_ip") or "").strip() or None
                domain_rules = body.get("domain_rules") or {}
                runtime.set_lease_policy(
                    lease_id,
                    domain_rules,
                    owner_id=owner_id,
                    pod_ip=pod_ip,
                )
                try:
                    runtime.audit_sink.append(
                        lease_id=lease_id,
                        owner_id=owner_id,
                        event_type="LEASE_POLICY_UPDATED",
                        payload={"has_pod_ip": bool(pod_ip), "rule_count": len(domain_rules)},
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return
                self._send_json(200, {"updated": True, "lease_id": lease_id})

            def do_DELETE(self) -> None:  # noqa: N802
                if not self._authorized():
                    self._send_json(401, {"code": "SENTINEL_CONTROL_UNAUTHORIZED"})
                    return
                lease_match = _CONTROL_LEASE_PATH_RE.fullmatch(self.path.split("?", 1)[0])
                if not lease_match:
                    self._send_json(404, {"code": "NOT_FOUND"})
                    return
                lease_id = urllib.parse.unquote(lease_match.group(1)).strip()
                if not lease_id:
                    self._send_json(400, {"code": "INVALID_LEASE_ID"})
                    return
                try:
                    runtime.delete_lease(lease_id)
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return
                self._send_json(200, {"deleted": True, "lease_id": lease_id})

        return ThreadingHTTPServer((host, port), _ControlHandler)

    def _make_model_gateway_server(self, host: str, port: int) -> ThreadingHTTPServer:
        runtime = self

        class _ModelGatewayHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def _send_json(self, code: int, payload: Mapping[str, Any]) -> None:
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.close_connection = True
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def _reject_path(self, method: str) -> None:
                bound = runtime.lease_for_ip(self.client_address[0])
                lease_id, owner_id = bound if bound is not None else ("unclaimed", "sandbox")
                try:
                    runtime.audit_sink.append(
                        lease_id=lease_id,
                        owner_id=owner_id,
                        event_type="MODEL_GATEWAY_DENY",
                        payload={
                            "method": method,
                            "path": self.path.split("?", 1)[0],
                            "code": MODEL_GATEWAY_PATH_FORBIDDEN,
                        },
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return
                self._send_json(
                    403,
                    {
                        "code": MODEL_GATEWAY_PATH_FORBIDDEN,
                        "detail": "Requested model gateway endpoint is not admitted",
                    },
                )

            def do_GET(self) -> None:  # noqa: N802
                parsed_path = urllib.parse.urlsplit(self.path).path
                if parsed_path in {"/healthz", "/readyz"}:
                    self._send_json(200, {"status": "model_gateway_ready"})
                    return
                self._reject_path("GET")

            def do_PUT(self) -> None:  # noqa: N802
                self._reject_path("PUT")

            def do_DELETE(self) -> None:  # noqa: N802
                self._reject_path("DELETE")

            def do_POST(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlsplit(self.path)
                match = _VERTEX_MODEL_PATH_RE.fullmatch(parsed.path)
                if not match:
                    self._reject_path("POST")
                    return
                _api_ver, _project, location, model_name, action = match.groups()
                auth_header = str(self.headers.get("Authorization") or "").strip()
                scheme, _, token = auth_header.partition(" ")
                if scheme.lower() != "bearer" or not token.strip():
                    self._send_json(
                        401,
                        {
                            "code": MODEL_GATEWAY_AUTH_REQUIRED,
                            "detail": "Bearer surrogate required",
                        },
                    )
                    return
                try:
                    grant = runtime.authorize_model_surrogate(
                        token.strip(), client_ip=self.client_address[0]
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return

                length = int(self.headers.get("Content-Length") or "0")
                if length < 0 or length > _MAX_MODEL_BODY_BYTES:
                    self._send_json(413, {"code": "PAYLOAD_TOO_LARGE"})
                    return
                raw_body = self.rfile.read(length) if length > 0 else b""

                try:
                    gcp_token = runtime._vertex_token_provider()
                except Exception:
                    self._send_json(
                        503,
                        {
                            "code": MODEL_GATEWAY_UNAVAILABLE,
                            "detail": "Upstream model credential authority unavailable",
                        },
                    )
                    return

                upstream_host = (
                    "aiplatform.googleapis.com"
                    if location == "global"
                    else f"{location}-aiplatform.googleapis.com"
                )
                upstream_url = f"https://{upstream_host}{parsed.path}" + (
                    f"?{parsed.query}" if parsed.query else ""
                )
                upstream_headers: dict[str, str] = {
                    "Authorization": f"Bearer {gcp_token}",
                    "Content-Type": str(self.headers.get("Content-Type") or "application/json"),
                }
                accept_header = str(self.headers.get("Accept") or "").strip()
                if accept_header:
                    upstream_headers["Accept"] = accept_header

                try:
                    upstream_status, resp_headers, chunks = runtime._model_upstream(
                        upstream_url, "POST", upstream_headers, raw_body
                    )
                except Exception:
                    self._send_json(
                        502,
                        {
                            "code": MODEL_GATEWAY_UNAVAILABLE,
                            "detail": "Upstream Vertex endpoint unreachable",
                        },
                    )
                    return

                try:
                    runtime.audit_sink.append(
                        lease_id=grant.lease_id,
                        owner_id=grant.owner_id,
                        event_type="MODEL_GATEWAY_INVOKE",
                        payload={
                            "model": model_name,
                            "location": location,
                            "action": action,
                            "status": upstream_status,
                            "request_bytes": len(raw_body),
                        },
                    )
                except SentinelEgressError as exc:
                    self._send_json(exc.status, {"code": exc.code, "detail": str(exc)})
                    return

                forward_headers = {
                    k: v
                    for k, v in resp_headers.items()
                    if str(k).lower() not in _HOP_BY_HOP_HEADERS
                }
                if action == "streamGenerateContent" and upstream_status < 400:
                    self.close_connection = True
                    self.send_response(upstream_status)
                    for hk, hv in forward_headers.items():
                        self.send_header(hk, hv)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for chunk in chunks:
                        if not chunk:
                            continue
                        self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii") + chunk + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    return

                collected = bytearray()
                for chunk in chunks:
                    if not chunk:
                        continue
                    if len(collected) + len(chunk) > _MAX_MODEL_RESPONSE_BYTES:
                        self._send_json(502, {"code": "MODEL_RESPONSE_TOO_LARGE"})
                        return
                    collected.extend(chunk)
                self.close_connection = True
                self.send_response(upstream_status)
                for hk, hv in forward_headers.items():
                    self.send_header(hk, hv)
                self.send_header("Content-Length", str(len(collected)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(bytes(collected))
                self.wfile.flush()

        return ThreadingHTTPServer((host, port), _ModelGatewayHandler)

    def start_background(self) -> None:
        build_sentinel_readiness_payload(audit_sink=self.audit_sink)
        for srv, name in (
            (self.proxy_server, "sentinel-proxy"),
            (self.control_server, "sentinel-control"),
            (self.model_gateway_server, "sentinel-model-gateway"),
        ):
            thread = threading.Thread(
                target=srv.serve_forever, kwargs={"poll_interval": 0.25}, name=name, daemon=True
            )
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        for srv in (self.proxy_server, self.control_server, self.model_gateway_server):
            srv.shutdown()
            srv.server_close()


def main() -> int:
    raw_hmac = (os.environ.get("SENTINEL_AUDIT_HMAC_KEY") or "").strip().encode("utf-8")
    if len(raw_hmac) < 32:
        raise ValueError("SENTINEL_AUDIT_HMAC_KEY must be at least 32 bytes")
    control_token = (os.environ.get("SENTINEL_CONTROL_TOKEN") or "").strip()
    raw_audit = (os.environ.get("SENTINEL_AUDIT_LOG_PATH") or "").strip()
    bind_host = str(os.environ.get("SENTINEL_BIND_HOST") or "")
    raw_allow_hosts = str(os.environ.get("SENTINEL_SYSTEM_ALLOW_HOSTS") or "")
    allow_hosts = [part.strip() for part in raw_allow_hosts.split(",") if part.strip()]
    if (os.environ.get("SENTINEL_DISABLE_GOOGLE_OIDC_CERTS") or "").strip().lower() not in {
        "1",
        "true",
        "yes",
    }:
        for cert_host in ("www.googleapis.com", "oauth2.googleapis.com"):
            if cert_host not in allow_hosts:
                allow_hosts.append(cert_host)
    runtime = SentinelProxyRuntime(
        hmac_key=raw_hmac,
        control_token=control_token,
        audit_log_path=Path(raw_audit) if raw_audit else None,
        proxy_host=bind_host,
        proxy_port=int(os.environ.get("SENTINEL_PROXY_PORT", str(DEFAULT_PROXY_PORT))),
        control_host=bind_host,
        control_port=int(os.environ.get("SENTINEL_CONTROL_PORT", str(DEFAULT_CONTROL_PORT))),
        model_gateway_host=bind_host,
        model_gateway_port=int(
            os.environ.get("SENTINEL_MODEL_GATEWAY_PORT", str(DEFAULT_MODEL_GATEWAY_PORT))
        ),
        default_mode=str(os.environ.get("SENTINEL_DEFAULT_MODE", "deny")),
        system_allow_hosts=allow_hosts,
    )
    stop_event = threading.Event()
    signal.signal(signal.SIGTERM, lambda _s, _f: stop_event.set())
    signal.signal(signal.SIGINT, lambda _s, _f: stop_event.set())
    runtime.start_background()
    sys.stdout.write(
        json.dumps(
            {
                "event": "sentinel_proxy_started",
                "proxy_port": runtime.proxy_port,
                "control_port": runtime.control_port,
                "model_gateway_port": runtime.model_gateway_port,
            }
        )
        + "\n"
    )
    sys.stdout.flush()
    stop_event.wait()
    runtime.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
