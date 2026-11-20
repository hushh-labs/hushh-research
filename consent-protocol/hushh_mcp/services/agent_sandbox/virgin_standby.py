# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Non-root virgin warm-pool standby HTTP readiness daemon and lease handoff (#9744)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import signal
import sys
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

_VALID_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_X25519_RAW_LEN = 32
_MAX_ACTIVATION_BYTES = 16 * 1024


def build_readiness_payload(*, uid: int | None = None) -> dict[str, Any]:
    """Return virgin warm-pool readiness telemetry after verifying non-root UID."""
    effective_uid = os.getuid() if uid is None else int(uid)
    effective_euid = os.geteuid() if uid is None else int(uid)
    if effective_uid == 0 or effective_euid == 0:
        raise PermissionError("VIRGIN_STANDBY_ROOT_FORBIDDEN: sandbox process cannot run as root")
    return {
        "status": "virgin_ready",
        "uid": effective_uid,
        "profile": str(os.environ.get("HUSSH_SANDBOX_PROFILE") or "virgin_pool_v1"),
    }


def _decode_x25519_b64(encoded: str) -> bytes:
    cleaned = str(encoded or "").strip()
    if not cleaned:
        raise ValueError("pod_private_key_b64 is required")
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(cleaned + "=" * (-len(cleaned) % 4))
            if len(raw) == _X25519_RAW_LEN:
                return raw
        except Exception:  # noqa: BLE001 - try alternate base64 encoding
            continue
    raise ValueError("pod_private_key_b64 must decode to 32 raw bytes")


def _derive_public_descriptor(raw_priv: bytes) -> tuple[str, str]:
    priv = X25519PrivateKey.from_private_bytes(raw_priv)
    pub_b64 = base64.b64encode(
        priv.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    ).decode("ascii")
    kid = f"podk_{hashlib.sha256(pub_b64.encode('utf-8')).hexdigest()[:32]}"
    return pub_b64, kid


def prewarm_runtime_imports() -> None:
    """Pre-import heavy SDK modules during warm-pool standby to cut activation latency."""
    import anthropic  # noqa: F401,PLC0415
    import cryptography.hazmat.primitives.asymmetric.ed25519  # noqa: F401,PLC0415
    import fastapi  # noqa: F401,PLC0415
    import google.adk  # noqa: F401,PLC0415
    import google.adk.agents  # noqa: F401,PLC0415
    import google.adk.apps  # noqa: F401,PLC0415
    import google.adk.models  # noqa: F401,PLC0415
    import google.adk.runners  # noqa: F401,PLC0415
    import google.adk.sessions.in_memory_session_service  # noqa: F401,PLC0415
    import google.genai  # noqa: F401,PLC0415
    import httpx  # noqa: F401,PLC0415
    import openai  # noqa: F401,PLC0415
    import pydantic  # noqa: F401,PLC0415
    import requests  # noqa: F401,PLC0415
    import starlette  # noqa: F401,PLC0415
    import uvicorn  # noqa: F401,PLC0415
    import websockets  # noqa: F401,PLC0415

    import api.middlewares.observability  # noqa: F401,PLC0415
    import api.middlewares.pod_ingress  # noqa: F401,PLC0415
    import api.routes.health  # noqa: F401,PLC0415


def _default_asgi_launcher(bind_host: str, port: int) -> None:
    """Load owner durable identity into RAM, unlink key file, and launch pod_server."""
    import uvicorn  # noqa: PLC0415

    from hushh_mcp.consent.token_signing import reset_caches as reset_token_caches  # noqa: PLC0415
    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
        clear_runtime_settings_caches,
    )

    reset_token_caches()
    clear_runtime_settings_caches()

    # Import pod_server AFTER activation env vars are written so middleware (CORS) sees them.
    import pod_server  # noqa: PLC0415
    from hushh_mcp.services.pod_self_registration import (  # noqa: PLC0415
        pod_public_key_payload,
        reset_pod_keypair_cache_for_tests,
    )

    reset_pod_keypair_cache_for_tests()
    pod_public_key_payload()

    config = uvicorn.Config(
        pod_server.app,
        host=bind_host,
        port=port,
        log_level="warning",
        workers=1,
    )
    uvicorn.Server(config).run()


class VirginStandbyRuntime:
    """Single-use standby listener that accepts one lease activation then yields the port."""

    def __init__(
        self,
        *,
        bind_host: str = "",
        port: int = 8080,
        activation_guard: str | None = None,
        tmp_dir: Path | None = None,
        asgi_launcher: Callable[[str, int], None] | None = None,
        uid: int | None = None,
    ) -> None:
        if not 0 <= int(port) <= 65535:
            raise ValueError("PORT must be between 0 and 65535")
        self.bind_host = str(bind_host or "")
        self.requested_port = int(port)
        self._guard = (
            (os.environ.get("HUSSH_SANDBOX_ACTIVATION_TOKEN") or "").strip()
            if activation_guard is None
            else str(activation_guard).strip()
        )
        self.tmp_dir = tmp_dir or Path(os.environ.get("TMPDIR") or "/run/hussh-tmp")
        self._asgi_launcher = asgi_launcher or _default_asgi_launcher
        self._uid = uid
        self._lock = threading.Lock()
        self._activated = False
        self.activation_info: dict[str, Any] | None = None
        self.server = self._make_server()
        self._serve_thread: threading.Thread | None = None
        self._asgi_thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def activated(self) -> bool:
        with self._lock:
            return self._activated

    def _make_server(self) -> ThreadingHTTPServer:
        runtime = self

        class _StandbyHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return None

            def _send_json(self, code: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.close_connection = True
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                if self.path not in {"/healthz", "/readyz", "/"}:
                    self._send_json(404, {"code": "NOT_FOUND"})
                    return
                self._send_json(200, build_readiness_payload(uid=runtime._uid))

            def do_POST(self) -> None:  # noqa: N802
                if self.path != "/internal/v1/activate-lease":
                    self._send_json(404, {"code": "NOT_FOUND"})
                    return
                if runtime._guard:
                    supplied = str(self.headers.get("X-Sandbox-Activation-Token") or "").strip()
                    if not hmac.compare_digest(supplied, runtime._guard):
                        self._send_json(401, {"code": "SANDBOX_ACTIVATION_UNAUTHORIZED"})
                        return
                length = int(self.headers.get("Content-Length") or "0")
                if length <= 0 or length > _MAX_ACTIVATION_BYTES:
                    self._send_json(400, {"code": "INVALID_ACTIVATION_PAYLOAD"})
                    return
                raw = self.rfile.read(length)
                try:
                    payload = json.loads(raw.decode("utf-8"))
                    hushh_id = str(payload.get("hushh_id") or "").strip()
                    owner_id = str(payload.get("owner_id") or "").strip()
                    lease_id = str(payload.get("lease_id") or "").strip()
                    key_b64 = str(payload.get("pod_private_key_b64") or "").strip()
                    if not _VALID_ID_RE.fullmatch(hushh_id) or not owner_id or not lease_id:
                        raise ValueError("hushh_id, owner_id, and lease_id are required")
                    raw_priv = _decode_x25519_b64(key_b64)
                    pub_b64, kid = _derive_public_descriptor(raw_priv)
                except Exception as exc:  # noqa: BLE001 - fail closed on malformed payload
                    self._send_json(400, {"code": "INVALID_ACTIVATION_PAYLOAD", "detail": str(exc)})
                    return

                with runtime._lock:
                    if runtime._activated:
                        self._send_json(409, {"code": "SANDBOX_LEASE_ALREADY_BOUND"})
                        return
                    runtime.tmp_dir.mkdir(parents=True, exist_ok=True)
                    key_file = runtime.tmp_dir / ".pod_key_once"
                    fd = os.open(
                        str(key_file),
                        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                        0o600,
                    )
                    try:
                        os.write(fd, key_b64.encode("ascii"))
                    finally:
                        os.close(fd)

                    os.environ["HUSSH_POD_MODE"] = "1"
                    os.environ["HUSSH_ID"] = hushh_id
                    os.environ["HUSSH_POD_ID"] = hushh_id
                    os.environ["HUSSH_OWNER_ID"] = owner_id
                    os.environ["HUSSH_LEASE_ID"] = lease_id
                    os.environ["HUSSH_POD_PRIVATE_KEY_FILE"] = str(key_file)
                    os.environ["HUSSH_UNLINK_POD_PRIVATE_KEY_AFTER_LOAD"] = "1"
                    os.environ.setdefault("HUSSH_POD_TURN_ENABLED", "true")
                    os.environ.setdefault("POD_AGENT_MEMORY_ENABLED", "true")
                    os.environ.setdefault("POD_DIRECTIVE_TRANSPORT_ENABLED", "true")
                    os.environ.setdefault("HUSSH_POD_BROWSER_ENABLED", "true")
                    os.environ.setdefault("POD_DATA_DOOR_ENABLED", "true")
                    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "false")
                    from hushh_mcp.consent.token_signing import (  # noqa: PLC0415
                        reset_caches as reset_token_caches,
                    )
                    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
                        clear_runtime_settings_caches,
                        ensure_pod_sandbox_signing_key,
                    )

                    ensure_pod_sandbox_signing_key()
                    for opt_field, env_names in (
                        ("pod_url", ("POD_URL",)),
                        ("hub_url", ("HUSSH_HUB_URL", "HUSSH_HUB_BASE_URL")),
                        (
                            "scheduler_caller_emails",
                            ("HUSHH_SCHEDULER_CALLER_EMAILS", "HUSSH_POD_HUB_CALLER_EMAILS"),
                        ),
                        ("consent_ed25519_public_keys", ("CONSENT_ED25519_PUBLIC_KEYS",)),
                        ("hub_public_key", ("CONSENT_ED25519_PUBLIC_KEYS",)),
                        (
                            "owner_feed_ed25519_public_keys",
                            ("OWNER_FEED_ED25519_PUBLIC_KEYS",),
                        ),
                        ("allowed_app_origins", ("CORS_ALLOWED_ORIGINS",)),
                        ("model_gateway_url", ("HUSSH_MODEL_GATEWAY_URL",)),
                        ("model_gateway_token", ("HUSSH_MODEL_GATEWAY_TOKEN",)),
                        ("sentinel_vertex_project", ("HUSSH_SENTINEL_VERTEX_PROJECT",)),
                        ("sentinel_vertex_location", ("HUSSH_SENTINEL_VERTEX_LOCATION",)),
                        ("sandbox_name", ("ACE_SANDBOX_ID",)),
                    ):
                        raw_val = payload.get(opt_field)
                        val = (
                            json.dumps(raw_val, separators=(",", ":"))
                            if isinstance(raw_val, dict)
                            else str(raw_val or "").strip()
                        )
                        if val:
                            for env_name in env_names:
                                os.environ[env_name] = val

                    prefix_url = str(payload.get("pod_storage_prefix_token_url") or "").strip()
                    if prefix_url:
                        os.environ["POD_STORAGE_PREFIX_TOKEN_URL"] = prefix_url
                        os.environ["POD_STORAGE_BACKEND"] = "commit_log"
                        os.environ["HUSSH_POD_CUSTODY_MODE"] = "hub_broker"
                        os.environ["POD_DURABLE_IDENTITY_ENABLED"] = "1"
                        os.environ.setdefault("HUSSH_POD_METADATA_IDENTITY_DISABLED", "1")
                        os.environ.setdefault("POD_HOST_KIND", "gcp_ace")
                        os.environ.setdefault("POD_FILES_ENABLED", "true")
                        os.environ.setdefault("HUSSH_POD_FILES_ENABLED", "true")
                    elif not (os.environ.get("POD_STORAGE_BACKEND") or "").strip():
                        os.environ.setdefault("POD_DURABLE_IDENTITY_ENABLED", "0")
                    if str(payload.get("sandbox_name") or "").strip():
                        os.environ.setdefault("HUSSH_POD_METADATA_IDENTITY_DISABLED", "1")
                        os.environ.setdefault("POD_HOST_KIND", "gcp_ace")

                    deploy_env = str(payload.get("deploy_env") or "").strip().lower()
                    if deploy_env in {"dev", "development", "uat"}:
                        os.environ["HUSHH_DEPLOY_ENV"] = deploy_env
                        if not (os.environ.get("ENVIRONMENT") or "").strip():
                            os.environ["ENVIRONMENT"] = (
                                "uat" if deploy_env == "uat" else "development"
                            )

                    reset_token_caches()
                    clear_runtime_settings_caches()

                    runtime._activated = True
                    runtime.activation_info = {
                        "hushh_id": hushh_id,
                        "owner_id": owner_id,
                        "lease_id": lease_id,
                        "podKeyId": kid,
                        "publicKey": pub_b64,
                    }

                self._send_json(
                    200,
                    {
                        "status": "activating",
                        "hushh_id": hushh_id,
                        "lease_id": lease_id,
                        "podKeyId": kid,
                        "publicKey": pub_b64,
                    },
                )
                threading.Thread(
                    target=runtime.server.shutdown,
                    name="standby-shutdown",
                    daemon=True,
                ).start()

        return ThreadingHTTPServer((self.bind_host, self.requested_port), _StandbyHandler)

    def serve_and_handoff(self) -> None:
        """Serve virgin standby until lease activation or SIGTERM, then run ASGI app."""
        build_readiness_payload(uid=self._uid)
        target_port = self.port
        try:
            self.server.serve_forever(poll_interval=0.05)
        finally:
            self.server.server_close()
        if self.activated:
            self._asgi_launcher(self.bind_host, target_port)

    def start_background(self) -> None:
        """Start standby + ASGI handoff on daemon thread (for in-process tests)."""
        self._serve_thread = threading.Thread(
            target=self.serve_and_handoff,
            name="virgin-standby-runtime",
            daemon=True,
        )
        self._serve_thread.start()

    def stop(self) -> None:
        try:
            self.server.shutdown()
        except Exception:  # noqa: BLE001 - safe shutdown
            pass
        if self._serve_thread is not None:
            self._serve_thread.join(timeout=3.0)


def main() -> int:
    payload = build_readiness_payload()
    raw_port = int(os.environ.get("PORT", "8080"))
    if not 1 <= raw_port <= 65535:
        raise ValueError("PORT must be between 1 and 65535")
    bind_host = str(os.environ.get("VIRGIN_STANDBY_BIND_HOST") or "")
    runtime = VirginStandbyRuntime(bind_host=bind_host, port=raw_port)
    threading.Thread(
        target=prewarm_runtime_imports,
        name="standby-prewarm",
        daemon=True,
    ).start()

    def _handle_signal(_signum: int, _frame: Any) -> None:
        threading.Thread(target=runtime.server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    sys.stdout.write(json.dumps({"event": "virgin_standby_started", **payload}) + "\n")
    sys.stdout.flush()
    runtime.serve_and_handoff()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
