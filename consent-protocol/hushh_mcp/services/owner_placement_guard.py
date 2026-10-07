"""The one hub content guard: only Shared owners' content may reach the hub runtime.

The hub is the control plane. A person whose agent runs anywhere else (their own
cloud, a Hussh pod, a setup still in progress, or no placement chosen yet) talks to
that agent directly, so their messages, records and prompts must never be accepted
by a hub route. Every hub route classified ``CONTENT`` in
``api/hub_route_classes.py`` admits its caller through this module, and
``tests/test_hub_content_routes_guarded.py`` proves each one does.

Decisions, all fail closed:

* anonymous caller: admitted (the intro tier only; it carries no owner content)
* ``shared``: admitted
* ``unknown``, an unreadable placement, or any value this module does not
  recognise: 503 ``AGENT_HOSTING_UNAVAILABLE`` (ask again shortly)
* every private placement (``byoc``, ``pending``, ``hussh_pods``, ``unplaced``):
  409 ``AGENT_PRIVATE_RUNTIME_REQUIRED`` with the ``hostingMode``

Inside a pod process the routes that share these modules run in the owner's own
agent, which is where the content belongs, so the guard admits there.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Depends, HTTPException

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.middlewares.chat_key import require_vault_owner_chat_key
from hushh_mcp.runtime_settings import pod_mode
from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode

logger = logging.getLogger(__name__)

ModeResolver = Callable[[str], Awaitable[str]]

SHARED_MODE = "shared"
PRIVATE_MODES = frozenset({"byoc", "pending", "hussh_pods", "unplaced"})
PRIVATE_RUNTIME_REQUIRED = "AGENT_PRIVATE_RUNTIME_REQUIRED"
HOSTING_UNAVAILABLE = "AGENT_HOSTING_UNAVAILABLE"
INLINE_GUARD_ATTRIBUTE = "__hub_content_guard__"


def private_runtime_required(mode: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": PRIVATE_RUNTIME_REQUIRED,
            "hostingMode": mode,
            "message": "Your agent runs privately. Open it directly to continue.",
        },
    )


def hosting_unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": HOSTING_UNAVAILABLE,
            "message": "Your agent hosting could not be verified. Try again shortly.",
        },
    )


async def _read_mode(user_id: str, resolve_mode: ModeResolver | None) -> str:
    resolver = resolve_mode or get_owner_hosting_mode
    try:
        mode = await resolver(user_id)
    except Exception as exc:  # noqa: BLE001 - an unreadable placement is never permission
        logger.warning("hub_content_admission.placement_unreadable reason=%s", type(exc).__name__)
        return "unknown"
    return mode if isinstance(mode, str) else "unknown"


async def admit_hub_content(
    user_id: str | None,
    surface: str,
    *,
    resolve_mode: ModeResolver | None = None,
) -> str:
    """Admit a caller to a hub content surface, or raise before any content is read.

    Returns the placement that was admitted (``anonymous``, ``shared`` or
    ``pod_process``). ``resolve_mode`` lets a route module keep its own imported
    placement reader as the seam; it defaults to ``get_owner_hosting_mode``.
    """
    if pod_mode():
        return "pod_process"
    owner = str(user_id or "").strip()
    if not owner:
        logger.info("hub_content_admission.admitted surface=%s mode=%s", surface, "anonymous")
        return "anonymous"
    mode = await _read_mode(owner, resolve_mode)
    if mode == SHARED_MODE:
        logger.info("hub_content_admission.admitted surface=%s mode=%s", surface, mode)
        return mode
    logger.info("hub_content_admission.refused surface=%s mode=%s", surface, mode)
    if mode in PRIVATE_MODES:
        raise private_runtime_required(mode)
    raise hosting_unavailable()


async def hub_content_owner(token: dict = Depends(require_vault_owner_token)) -> dict:
    """Vault-owner token, admitted to hub content only for a Shared owner."""
    await admit_hub_content(str(token.get("user_id") or ""), "vault_owner")
    return token


async def hub_content_chat_owner(token: dict = Depends(require_vault_owner_chat_key)) -> dict:
    """Vault-owner token plus chat key, admitted to hub content only for a Shared owner."""
    await admit_hub_content(str(token.get("user_id") or ""), "vault_owner_chat")
    return token


async def hub_content_firebase(user_id: str = Depends(require_firebase_auth)) -> str:
    """Firebase sign-in, admitted to hub content only for a Shared owner."""
    await admit_hub_content(user_id, "firebase")
    return user_id


# Route-level form for a chat-key route that keeps ``require_vault_owner_chat_key`` as its
# own parameter: FastAPI resolves the shared dependency once per request, and the guard runs
# before the handler.
HUB_CHAT_GUARD = (Depends(hub_content_chat_owner),)

HUB_CONTENT_DEPENDENCIES: tuple[Callable[..., Any], ...] = (
    hub_content_owner,
    hub_content_chat_owner,
    hub_content_firebase,
)


def hub_content_inline(surface: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a websocket, ticket or streaming handler that calls ``admit_hub_content``
    itself (it has no dependency to carry the guard). The route-inventory test still
    calls it as a private owner and requires a refusal, so the mark is never enough
    on its own."""

    def mark(handler: Callable[..., Any]) -> Callable[..., Any]:
        setattr(handler, INLINE_GUARD_ATTRIBUTE, surface)
        return handler

    return mark


def mark_inline_routes(router: Any, path: str, surface: str) -> None:
    """Apply ``hub_content_inline`` to every route of ``router`` served at ``path``."""
    for route in getattr(router, "routes", ()):
        if getattr(route, "path", "") == path:
            hub_content_inline(surface)(route.endpoint)


__all__ = [
    "HOSTING_UNAVAILABLE",
    "HUB_CHAT_GUARD",
    "HUB_CONTENT_DEPENDENCIES",
    "INLINE_GUARD_ATTRIBUTE",
    "PRIVATE_MODES",
    "PRIVATE_RUNTIME_REQUIRED",
    "admit_hub_content",
    "hub_content_chat_owner",
    "hub_content_firebase",
    "hub_content_inline",
    "hub_content_owner",
    "mark_inline_routes",
    "require_vault_owner_chat_key",
]
