"""Final publication gate for an owner pod's conversational memory."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from hushh_mcp.constants import ConsentScope

logger = logging.getLogger(__name__)


async def memory_commit_allowed() -> bool:
    """A replaced or uncertain pod incarnation cannot publish to memory."""
    from hushh_mcp.services.pod_session_authority import (  # noqa: PLC0415
        active_session_authority,
    )

    authority = active_session_authority()
    if authority is None:
        return True
    return (await authority.lease.is_current()) is True


def commit_gate(
    consent_token: str, verifier: Any, session: dict | None, user_id: str
) -> Callable[[], Awaitable[bool]]:
    """Bind the live app-session verdict to this turn's final memory write."""

    async def allowed() -> bool:
        if not await memory_commit_allowed():
            return False
        # Hub-relayed turns retain the original incarnation fence. Direct turns
        # must also survive a fresh tombstone, expiry and binding-version check.
        if session is None:
            return True
        if verifier is None:
            return False
        try:
            verdict = await verifier(consent_token, expected_scope=ConsentScope.PKM_READ.value)
            return (
                verdict.available is True
                and verdict.valid is True
                and verdict.user_id == user_id
                and verdict.hushh_id == str(session.get("hushh_id") or "")
            )
        except Exception:  # noqa: BLE001 - uncertain write authority fails closed
            logger.warning("pod_turn.memory_authority_unavailable")
            return False

    return allowed
