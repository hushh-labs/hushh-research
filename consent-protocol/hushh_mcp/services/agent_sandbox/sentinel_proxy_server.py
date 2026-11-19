# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Out-of-sandbox Sentinel HTTP/CONNECT proxy daemon and durable audit sink (#9744)."""

from __future__ import annotations

import hmac
import http.client
import json
import os
import select
import signal
import socket
import ssl
import sys
import threading
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import asdict
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
    SentinelEgressError,
    SentinelEgressGatekeeper,
)

UpstreamTransport = Callable[
    [str, str, Mapping[str, str], bytes], tuple[int, dict[str, str], bytes]
]
DnsResolver = Callable[[str, int], list[str]]

DEFAULT_PROXY_PORT = 3128
DEFAULT_CONTROL_PORT = 8081
SENTINEL_ROOT_FORBIDDEN = "SENTINEL_ROOT_FORBIDDEN"
_MAX_BODY_BYTES = 2 * 1024 * 1024


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
    """Dual-port out-of-sandbox proxy (:3128) and Hub control API (:8081)."""

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
        default_mode: str = "deny",
        upstream_transport: UpstreamTransport | None = None,
        dns_resolver: DnsResolver | None = None,
    ) -> None:
        clean_token = str(control_token or "").strip()
        if len(clean_token) < 16:
            raise ValueError("control_token must be at least 16 characters")
        self.audit_sink = DurableAuditSink(hmac_key, audit_log_path=audit_log_path)
        self.gatekeeper = SentinelEgressGatekeeper(self.audit_sink)
        self._control_token = clean_token
        self.default_mode = "deny" if default_mode == "deny" else "ask"
        self._upstream = upstream_transport or _default_https_transport
        self._dns = dns_resolver or _default_dns_resolver
        self._lock = threading.Lock()
        self._lease_policies: dict[str, dict[str, DomainRuleMode]] = {}
        self.proxy_server = self._make_proxy_server(proxy_host, proxy_port)
        self.control_server = self._make_control_server(control_host, control_port)
        self._threads: list[threading.Thread] = []

    @property
    def proxy_port(self) -> int:
        return int(self.proxy_server.server_address[1])

    @property
    def control_port(self) -> int:
        return int(self.control_server.server_address[1])

    def set_lease_policy(self, lease_id: str, rules: Mapping[str, DomainRuleMode]) -> None:
        with self._lock:
            current = dict(self._lease_policies.get(lease_id, {}))
            for host, mode in rules.items():
                clean_host = str(host or "").strip().lower().rstrip(".")
                if clean_host and mode in {"allow", "ask", "deny"}:
                    current[clean_host] = mode
            self._lease_policies[lease_id] = current

    def policy_for_lease(self, lease_id: str) -> dict[str, DomainRuleMode]:
        with self._lock:
            return dict(self._lease_policies.get(lease_id, {}))

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
        resolved_ips = self.resolve_target_ips(url)
        rules = self.policy_for_lease(lease_id)
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
                owner_id = str(self.headers.get("X-Hussh-Owner-Id") or "sandbox")
                lease_id = str(self.headers.get("X-Hussh-Lease-Id") or "unclaimed")
                url = f"https://{target_host}:{target_port}"
                ips = runtime.resolve_target_ips(url)
                verdict = evaluate_sandbox_egress(
                    url,
                    resolved_ips=ips,
                    method="CONNECT",
                    domain_rules=runtime.policy_for_lease(lease_id),
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
                self._send_json(404, {"code": "NOT_FOUND"})

        return ThreadingHTTPServer((host, port), _ControlHandler)

    def start_background(self) -> None:
        build_sentinel_readiness_payload(audit_sink=self.audit_sink)
        for srv, name in (
            (self.proxy_server, "sentinel-proxy"),
            (self.control_server, "sentinel-control"),
        ):
            thread = threading.Thread(
                target=srv.serve_forever, kwargs={"poll_interval": 0.25}, name=name, daemon=True
            )
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        for srv in (self.proxy_server, self.control_server):
            srv.shutdown()
            srv.server_close()


def main() -> int:
    raw_hmac = (os.environ.get("SENTINEL_AUDIT_HMAC_KEY") or "").strip().encode("utf-8")
    if len(raw_hmac) < 32:
        raise ValueError("SENTINEL_AUDIT_HMAC_KEY must be at least 32 bytes")
    control_token = (os.environ.get("SENTINEL_CONTROL_TOKEN") or "").strip()
    raw_audit = (os.environ.get("SENTINEL_AUDIT_LOG_PATH") or "").strip()
    bind_host = str(os.environ.get("SENTINEL_BIND_HOST") or "")
    runtime = SentinelProxyRuntime(
        hmac_key=raw_hmac,
        control_token=control_token,
        audit_log_path=Path(raw_audit) if raw_audit else None,
        proxy_host=bind_host,
        proxy_port=int(os.environ.get("SENTINEL_PROXY_PORT", str(DEFAULT_PROXY_PORT))),
        control_host=bind_host,
        control_port=int(os.environ.get("SENTINEL_CONTROL_PORT", str(DEFAULT_CONTROL_PORT))),
        default_mode=str(os.environ.get("SENTINEL_DEFAULT_MODE", "deny")),
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
