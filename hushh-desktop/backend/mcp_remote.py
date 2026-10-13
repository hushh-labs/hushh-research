from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import parse_qs

from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

from api.developer_auth import remote_mcp_disabled_error, remote_mcp_enabled
from hushh_mcp.services.developer_registry_service import DeveloperRegistryService
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)
from mcp_server import server as mcp_server

logger = logging.getLogger(__name__)


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

        context_tokens = set_current_developer_principal(principal, token=raw_token)
        try:
            await self._inner(scope, receive, send)
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
