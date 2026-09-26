"""Bind the ``X-Hussh-Chat-Key`` header to one HTTP exchange, then drop it.

Pure ASGI rather than ``BaseHTTPMiddleware`` so the binding is set in the request's
own context: every task the request spawns (Starlette's stream task, the ag_ui_adk
background run, ``asyncio.to_thread``) copies the same holder, and releasing it here
reaches all of them. The header is removed from the scope before anything else can
read it, so no handler, SDK, tracer or logger downstream ever sees the key.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from api.middleware import require_vault_owner_token
from hushh_mcp.services.chat_key import (
    CHAT_KEY_HEADER,
    CHAT_KEY_RECOVERY_MESSAGE,
    ChatKeyMismatchError,
    ChatKeyUnavailableError,
    RequestChatKey,
    bind_request_chat_key,
    parse_chat_key_header,
    request_has_chat_key,
)

_HEADER_BYTES = CHAT_KEY_HEADER.encode("latin-1")
CHAT_KEY_REQUIRED_DETAIL = CHAT_KEY_RECOVERY_MESSAGE
CHAT_KEY_MISMATCH_DETAIL = "Your chat history did not open with this vault. Unlock again."
_MALFORMED_DETAIL = "Chat key is invalid. Unlock your vault and try again."


class ChatKeyMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = list(scope.get("headers") or [])
        values = [value for name, value in headers if name.lower() == _HEADER_BYTES]
        holder: RequestChatKey | None = None
        if values:
            try:
                if len(values) != 1:
                    raise ChatKeyUnavailableError("Chat key is malformed.")
                holder = RequestChatKey(parse_chat_key_header(values[0].decode("latin-1")))
            except (ChatKeyUnavailableError, UnicodeDecodeError):
                response = JSONResponse(
                    {"detail": _MALFORMED_DETAIL, "code": "CHAT_KEY_INVALID"},
                    status_code=400,
                    headers={"Cache-Control": "no-store"},
                )
                await response(scope, receive, send)
                return
            scope = {
                **scope,
                "headers": [
                    (name, value) for name, value in headers if name.lower() != _HEADER_BYTES
                ],
            }
        with bind_request_chat_key(holder):
            await self.app(scope, receive, send)


async def chat_key_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Refuse, never degrade: no route may answer chat history without the key."""
    mismatch = isinstance(exc, ChatKeyMismatchError)
    return JSONResponse(
        {
            "detail": CHAT_KEY_MISMATCH_DETAIL if mismatch else CHAT_KEY_REQUIRED_DETAIL,
            "code": "CHAT_KEY_MISMATCH" if mismatch else "CHAT_KEY_REQUIRED",
        },
        status_code=403,
        headers={"Cache-Control": "no-store"},
    )


async def require_vault_owner_chat_key(
    token: dict = Depends(require_vault_owner_token),
) -> dict:
    """Vault-owner token plus that owner's chat key, or a 403 before any read."""
    if not request_has_chat_key(str(token.get("user_id") or "")):
        raise HTTPException(
            status_code=403,
            detail={"message": CHAT_KEY_REQUIRED_DETAIL, "code": "CHAT_KEY_REQUIRED"},
        )
    return token


__all__ = [
    "CHAT_KEY_MISMATCH_DETAIL",
    "CHAT_KEY_REQUIRED_DETAIL",
    "ChatKeyMiddleware",
    "chat_key_error_handler",
    "require_vault_owner_chat_key",
]
