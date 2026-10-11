"""Owner-bound onboarding research; returns a draft and never persists findings."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from starlette.concurrency import run_in_threadpool

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.profile_research import ProfileReport, run_profile_research
from hushh_mcp.runtime_settings import one_profile_research_enabled
from hushh_mcp.services.one_owner_admission import (
    lookup_fresh_owner_identity,
    owner_setup_resolved,
)

logger = logging.getLogger(__name__)


async def offer_profile_research(
    *,
    user_id: str,
    consent_token: str,
    researcher=run_profile_research,
    owner_check=validate_first_party_owner_token,
    identity_lookup=lookup_fresh_owner_identity,
    setup_check=owner_setup_resolved,
) -> dict[str, Any]:
    async def require_access() -> None:
        if await owner_check(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")

    await require_access()
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}
    if not await asyncio.wait_for(setup_check(user_id), 5):
        return {"status": "not_ready", "pkm_written": False}
    record = await asyncio.wait_for(run_in_threadpool(identity_lookup, user_id), 5)
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise PermissionError("Account identity changed")
    name = str(getattr(record, "display_name", None) or "").strip()
    email = getattr(record, "email", None) if getattr(record, "email_verified", False) else None
    phone = getattr(record, "phone_number", None)
    if not name or not phone:
        from hushh_mcp.services.actor_identity_service import ActorIdentityService

        identities = await asyncio.wait_for(ActorIdentityService().get_many([user_id]), 5)
        identity = identities.get(user_id, {})
        # Gmail onboarding seeds the canonical owner name without rewriting Firebase.
        if not name and isinstance(identity.get("display_name"), str):
            name = identity["display_name"].strip()
        if not phone and identity.get("phone_verified") is True:
            phone = identity.get("phone_number")
    await require_access()
    if not name or len(name) > 160 or any(ord(char) < 32 for char in name):
        return {"status": "insufficient_identity", "pkm_written": False}
    if (email is not None and (not isinstance(email, str) or len(email) > 320)) or (
        phone is not None and (not isinstance(phone, str) or len(phone) > 64)
    ):
        return {"status": "insufficient_identity", "pkm_written": False}
    result = await researcher(
        identity={"full_name": name, "email": email, "phone_number": phone},
        user_id=user_id,
        consent_token=consent_token,
        require_access=require_access,
    )
    await require_access()
    # Re-check the rollout switch before releasing an in-flight result.
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}
    report = ProfileReport.model_validate(result["report"])
    logger.info(
        "one.profile_research_complete match=%s sections=%d",
        report.match_status,
        len(report.sections),
    )
    return {"status": "offered", "pkm_written": False, **result}
