"""Bind the ``X-Hussh-Chat-Key`` header to one HTTP exchange, then drop it.

Pure ASGI rather than ``BaseHTTPMiddleware`` so the binding is set in the request's
own context: every task the request spawns (Starlette's stream task, the ag_ui_adk
background run, ``asyncio.to_thread``) copies the same holder, and releasing it here
reaches all of them. The header is removed from the scope before anything else can
read it, so no handler, SDK, tracer or logger downstream ever sees the key.
"""

from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from api.middleware import require_vault_owner_token
from hushh_mcp.services.chat_history_rollout import (
    CHAT_HISTORY_UPGRADING,
    CHAT_HISTORY_UPGRADING_MESSAGE,
    ChatHistoryUpdatingError,
    holds_chat_history_request,
)
from hushh_mcp.services.chat_key import (
    CHAT_KEY_HEADER,
    CHAT_KEY_RECOVERY_MESSAGE,
    ChatKeyMismatchError,
    ChatKeyUnavailableError,
    RequestChatKey,
    bind_request_chat_key,
    parse_chat_key_header,
    request_chat_key_state,
    request_has_chat_key,
)

logger = logging.getLogger(__name__)

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
            if holds_chat_history_request(scope.get("method", ""), scope.get("path", "")):
                response = _history_upgrading_response()
                await response(scope, receive, send)
                return
            await self.app(scope, receive, send)


def _history_upgrading_response() -> JSONResponse:
    return JSONResponse(
        {"code": CHAT_HISTORY_UPGRADING, "detail": CHAT_HISTORY_UPGRADING_MESSAGE},
        status_code=503,
        headers={"Cache-Control": "no-store", "Retry-After": "60"},
    )


def log_chat_key_refusal(
    request: Request | None, code: str, *, owner_id: str | None = None
) -> None:
    """Record a chat-key refusal as metadata: which code, where, and what key arrived.

    ``key_state`` separates a request that carried no key (``absent``) from one whose
    key was released, never bound to an owner, bound to another owner, or bound and
    still refused (a record that would not open). It never carries the key, the
    owner id, or the raw path, which can hold a user id.
    """
    scope = request.scope if request is not None else {}
    logger.warning(
        "chat_key.refused code=%s method=%s route=%s key_state=%s",
        code,
        scope.get("method", ""),
        getattr(scope.get("route"), "path", None) or "unmatched",
        request_chat_key_state(owner_id),
    )


async def chat_key_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Refuse, never degrade: no route may answer chat history without the key."""
    if isinstance(exc, ChatHistoryUpdatingError):
        return _history_upgrading_response()
    mismatch = isinstance(exc, ChatKeyMismatchError)
    log_chat_key_refusal(request, "CHAT_KEY_MISMATCH" if mismatch else "CHAT_KEY_REQUIRED")
    return JSONResponse(
        {
            "detail": CHAT_KEY_MISMATCH_DETAIL if mismatch else CHAT_KEY_REQUIRED_DETAIL,
            "code": "CHAT_KEY_MISMATCH" if mismatch else "CHAT_KEY_REQUIRED",
        },
        status_code=403,
        headers={"Cache-Control": "no-store"},
    )


async def require_vault_owner_chat_key(
    request: Request,
    token: dict = Depends(require_vault_owner_token),
) -> dict:
    """Vault-owner token plus that owner's chat key, or a 403 before any read."""
    owner_id = str(token.get("user_id") or "")
    if not request_has_chat_key(owner_id):
        log_chat_key_refusal(request, "CHAT_KEY_REQUIRED", owner_id=owner_id)
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
    "log_chat_key_refusal",
    "require_vault_owner_chat_key",
]
