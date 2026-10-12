"""Refresh incomplete SMS identity shadows before the existing policy gates.

Membership authorizes the lookup, never phone verification or location access.
The canonical identity writer preserves app-verified claims and phone uniqueness.
Keep this async: its asyncpg pool belongs to the request event loop.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from hushh_mcp.services.actor_identity_service import ActorIdentityService

if TYPE_CHECKING:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

logger = logging.getLogger(__name__)


async def refresh_sms_recipient_identities(
    service: OneLocationAgentService,
    *,
    owner_user_id: str,
    recipient_user_id: str | None = None,
    adding_contact: bool = False,
) -> None:
    def incomplete_recipients() -> list[str]:
        if adding_contact and recipient_user_id:
            ids = (
                [recipient_user_id]
                if service._is_location_peer_eligible(
                    owner_user_id=owner_user_id, other_user_id=recipient_user_id
                )
                else []
            )
        else:
            ids = service.list_sms_contact_ids(owner_user_id=owner_user_id)
            if recipient_user_id is not None:
                ids = [uid for uid in ids if uid == recipient_user_id]
        incomplete = []
        for uid in dict.fromkeys(ids):
            if uid == owner_user_id:
                continue
            identity = service._identity_row(uid) or {}
            if not (identity.get("phone_verified") and identity.get("phone_number")):
                incomplete.append(uid)
        return incomplete

    ids = await asyncio.to_thread(incomplete_recipients)
    if not ids:
        return
    identity_service = ActorIdentityService()

    async def refresh(uid: str) -> None:
        try:
            await identity_service.sync_verified_phone_from_firebase(uid)
        except Exception:
            # A provider/cache outage cannot prevent other contacts from
            # being attempted. Unrepaired recipients still fail the original
            # phone/key/relationship gate; never fabricate verification.
            logger.warning("one.location.sms_identity_refresh_unavailable")

    try:
        # Start every member of this owner-scoped SMS roster together. A slow
        # provider lookup must not consume the budget before later members start.
        # The shared deadline bounds waiting without fabricating verification.
        await asyncio.wait_for(asyncio.gather(*(refresh(uid) for uid in ids)), timeout=3)
    except TimeoutError:
        logger.warning("one.location.sms_identity_refresh_deadline")
