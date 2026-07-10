from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any
from urllib.parse import parse_qs

from limits import parse as parse_rate_limit
from limits.storage import storage_from_string
from limits.strategies import MovingWindowRateLimiter
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

from api.developer_auth import remote_mcp_disabled_error, remote_mcp_enabled
from hushh_mcp.services.developer_registry_service import DeveloperRegistryService
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)
from mcp_server import server as mcp_server

logger = logging.getLogger(__name__)

# The `/mcp` mount is a raw ASGI sub-app (app.mount("/mcp", remote_mcp_app) in
# server.py), so slowapi's route-decorator rate limiting (api/middlewares/
# rate_limit.py, used everywhere else in the FastAPI app) never applies to
# it. This is a genuinely unbounded surface today: a hosted CRM integration
# (Salesforce Agentforce/FSC via Named Credential, Mulesoft-fronted
# connectors) calling at scale, or a runaway retry loop, has no rate limit,
# timeout, or concurrency cap protecting it. This module implements a manual
# per-developer-app limiter directly using the `limits` library (already a
# slowapi dependency), reusing the same RATE_LIMIT_STORAGE_URI seam
# documented in api/middlewares/rate_limit.py (Postgres now, Redis/Memorystore
# later; in-memory when unset - single-process-scoped like the rest of the
# app's rate limiting).
_MCP_REMOTE_RATE_LIMIT = str(os.environ.get("MCP_REMOTE_RATE_LIMIT", "") or "120/minute").strip()
_MCP_REMOTE_REQUEST_TIMEOUT_SECONDS = float(
    os.environ.get("MCP_REMOTE_REQUEST_TIMEOUT_SECONDS", "") or "120"
)
_rate_limit_item = parse_rate_limit(_MCP_REMOTE_RATE_LIMIT)
_rate_limit_storage = storage_from_string(
    os.environ.get("RATE_LIMIT_STORAGE_URI", "") or "memory://"
)
_rate_limiter = MovingWindowRateLimiter(_rate_limit_storage)


def _header_value(scope: dict[str, Any], header_name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() == header_name:
            return value.decode("utf-8").strip()
    return None


def _client_ip(scope: dict[str, Any]) -> str | None:
    client = scope.get("client")
    if isinstance(client, tuple) and client:
        return str(client[0])
    return None


def _parse_query_token(scope: dict[str, Any]) -> str:
    query_string = scope.get("query_string", b"")
    if isinstance(query_string, bytes):
        parsed = parse_qs(query_string.decode("utf-8"), keep_blank_values=False)
        values = parsed.get("token") or []
        return str(values[0]).strip() if values else ""
    return ""


async def _send_json(send, status_code: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    await send({"type": "http.response.start", "status": status_code, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


class _StreamableHTTPASGIApp:
    def __init__(self, session_manager: StreamableHTTPSessionManager):
        self.session_manager = session_manager

    async def __call__(self, scope, receive, send) -> None:
        await self.session_manager.handle_request(scope, receive, send)


class AuthenticatedRemoteMCPApp:
    def __init__(self, session_manager: StreamableHTTPSessionManager):
        self._registry = DeveloperRegistryService()
        self._inner = _StreamableHTTPASGIApp(session_manager)

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await _send_json(send, 404, {"detail": "Not found"})
            return

        if not remote_mcp_enabled():
            exc = remote_mcp_disabled_error()
            await _send_json(send, exc.status_code, exc.detail)
            return

        bearer_header = (_header_value(scope, b"authorization") or "").strip()
        bearer_token = ""
        if bearer_header.lower().startswith("bearer "):
            bearer_token = bearer_header[7:].strip()

        query_token = _parse_query_token(scope)

        # Prefer the Authorization header. Tokens carried in URLs leak via
        # Referer headers, server access logs, browser history, and CDN/proxy
        # logs (CWE-598). Query parameters remain accepted for backward
        # compatibility with existing MCP clients that cannot set headers.
        raw_token = bearer_token or query_token

        if not raw_token:
            await _send_json(
                send,
                401,
                {
                    "error_code": "DEVELOPER_TOKEN_REQUIRED",
                    "message": (
                        "Developer token is required for remote MCP. Pass it as "
                        "'Authorization: Bearer <token>' (preferred) or '?token=<token>' (legacy)."
                    ),
                },
            )
            return

        if not bearer_token and query_token:
            logger.warning(
                "Remote MCP token received via query parameter; prefer Authorization: Bearer "
                "header to avoid URL-leak vectors.",
                extra={
                    "event_type": "developer_token_query_param_use",
                    "transport": "remote_mcp",
                    "client_ip": _client_ip(scope) or "",
                },
            )

        principal = self._registry.authenticate_token(
            raw_token,
            ip_address=_client_ip(scope),
            user_agent=_header_value(scope, b"user-agent"),
        )
        if principal is None:
            await _send_json(
                send,
                403,
                {
                    "error_code": "DEVELOPER_TOKEN_INVALID",
                    "message": "Developer token is invalid or revoked.",
                },
            )
            return

        # Per-developer-app rate limit. Keyed by app_id (not IP) so a single
        # hosted CRM integration's own traffic is bounded regardless of how
        # many IPs/instances it fans out from, and so one noisy app can never
        # starve another app's quota.
        if not _rate_limiter.hit(_rate_limit_item, "mcp_remote", principal.app_id):
            logger.warning(
                "Remote MCP rate limit exceeded",
                extra={"event_type": "mcp_remote_rate_limited", "app_id": principal.app_id},
            )
            await _send_json(
                send,
                429,
                {
                    "error_code": "RATE_LIMIT_EXCEEDED",
                    "message": (
                        f"Remote MCP rate limit exceeded ({_MCP_REMOTE_RATE_LIMIT} per developer "
                        "app). Retry with standard backoff."
                    ),
                },
            )
            return

        context_tokens = set_current_developer_principal(principal, token=raw_token)
        try:
            await asyncio.wait_for(
                self._inner(scope, receive, send),
                timeout=_MCP_REMOTE_REQUEST_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "Remote MCP request timed out",
                extra={"event_type": "mcp_remote_request_timeout", "app_id": principal.app_id},
            )
            await _send_json(
                send,
                504,
                {
                    "error_code": "REQUEST_TIMEOUT",
                    "message": (
                        f"Remote MCP request exceeded the {_MCP_REMOTE_REQUEST_TIMEOUT_SECONDS:.0f}s "
                        "timeout."
                    ),
                },
            )
        finally:
            reset_current_developer_principal(context_tokens)


_session_manager = StreamableHTTPSessionManager(
    app=mcp_server,
    json_response=False,
    stateless=True,
)
remote_mcp_app = AuthenticatedRemoteMCPApp(_session_manager)
_session_manager_lifespan = None


async def startup_remote_mcp() -> None:
    global _session_manager_lifespan
    if _session_manager_lifespan is not None:
        return
    _session_manager_lifespan = _session_manager.run()
    await _session_manager_lifespan.__aenter__()


async def shutdown_remote_mcp() -> None:
    global _session_manager_lifespan
    if _session_manager_lifespan is None:
        return
    await _session_manager_lifespan.__aexit__(None, None, None)
    _session_manager_lifespan = None
