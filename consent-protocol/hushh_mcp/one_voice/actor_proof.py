"""Actor proof at the mutation boundary of the people/profile plane.

A ``firebase_plane`` tool (send / answer / withdraw a connection request,
disconnect, profile writes) changes a relationship the vault-owner token alone
does not vouch for. Session auth verifies a Firebase proof once, at connect;
tokens expire and can be revoked, and a tap can arrive with any string. So
the proof is verified again -- signature, expiry, revocation, and that it
names the signed-in user -- immediately before a confirmation is accepted,
for spoken and tapped approval alike. A string being non-empty is not proof.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Literal

ProofOutcome = Literal["ok", "missing", "invalid", "mismatch"]
ActorProof = Callable[[str | None, str], Awaitable[ProofOutcome]]


async def verify_firebase_actor(token: str | None, expected_user_id: str) -> ProofOutcome:
    """Verify ``token`` names ``expected_user_id``. Never raises."""
    clean = str(token or "").strip()
    if not clean:
        return "missing"
    from api.utils.firebase_auth import verify_firebase_bearer

    try:
        uid = await asyncio.to_thread(verify_firebase_bearer, f"Bearer {clean}", check_revoked=True)
    except Exception:  # noqa: BLE001 - any verification failure is "not proven"
        return "invalid"
    return "ok" if str(uid or "") == str(expected_user_id or "") else "mismatch"


__all__ = ["ActorProof", "ProofOutcome", "verify_firebase_actor"]
