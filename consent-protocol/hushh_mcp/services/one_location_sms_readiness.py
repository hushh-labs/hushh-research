"""Repair absent account projections before the existing SMS policy gates.

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
    def missing_recipients() -> list[str]:
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
        missing = []
        for uid in dict.fromkeys(ids):
            if uid == owner_user_id:
                continue
            if not service._identity_row(uid):
                missing.append(uid)
        return missing

    ids = await asyncio.to_thread(missing_recipients)
    if not ids:
        return
    identity_service = ActorIdentityService()

    async def refresh(uid: str) -> None:
        try:
            await identity_service.sync_from_firebase(uid, force=True, require_success=True)
        except Exception:
            # A provider/cache outage cannot prevent other contacts from
            # being attempted. Unrepaired recipients still fail the original
            # identity/key/relationship gates; never fabricate an identity.
            logger.warning("one.location.sms_identity_refresh_unavailable")

    async def repair_known_actors() -> None:
        # Reuse canonical profile admission and the tombstone-fenced identity
        # writer. A stale roster must never manufacture a new account spine.
        known = await identity_service._known_actor_ids(ids)
        # Start every member of this owner-scoped SMS roster together. A slow
        # provider lookup must not consume the budget before later members start.
        # Existing projected accounts, including phone-less accounts, never
        # depend on this provider recovery or its deadline.
        await asyncio.gather(*(refresh(uid) for uid in ids if uid in known))

    try:
        await asyncio.wait_for(repair_known_actors(), timeout=3)
    except TimeoutError:
        logger.warning("one.location.sms_identity_refresh_deadline")
    except Exception:
        logger.warning("one.location.sms_identity_refresh_unavailable")
