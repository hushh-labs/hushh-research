"""Owner-bound onboarding research; returns a draft and never persists findings."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from starlette.concurrency import run_in_threadpool

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.profile_research import ProfileReport, run_profile_discovery
from hushh_mcp.runtime_settings import one_profile_research_enabled
from hushh_mcp.services.magic_intelligence_admission import (
    magic_intelligence_owner_admitted,
    magic_intelligence_rollout_enabled,
)
from hushh_mcp.services.magic_intelligence_completion import magic_intelligence_saved
from hushh_mcp.services.one_owner_admission import (
    lookup_fresh_owner_identity,
    owner_setup_resolved,
)
from hushh_mcp.services.owner_placement_guard import hub_content_check

logger = logging.getLogger(__name__)


async def resolve_profile_research_identity(user_id: str, record, *, conn=None) -> dict[str, Any]:
    name = str(getattr(record, "display_name", None) or "").strip()
    email = getattr(record, "email", None) if getattr(record, "email_verified", False) else None
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    # Firebase may retain a phone after a new OTP owner has claimed it. The
    # canonical verified binding is the current phone authority; a held claim
    # transaction also locks this row until the invitation update commits.
    identities = await asyncio.wait_for(
        ActorIdentityService().get_many([user_id], **({"conn": conn} if conn is not None else {})),
        5,
    )
    identity = identities.get(user_id, {})
    if not name and isinstance(identity.get("display_name"), str):
        name = identity["display_name"].strip()
    phone = identity.get("phone_number") if identity.get("phone_verified") is True else None
    return {"full_name": name, "email": email, "phone_number": phone}


async def offer_profile_research(
    *,
    user_id: str,
    consent_token: str,
    researcher=run_profile_discovery,
    owner_check=validate_first_party_owner_token,
    identity_lookup=lookup_fresh_owner_identity,
    setup_check=owner_setup_resolved,
    saved_check=None,
    attempts_used=(),
    on_attempts_start=None,
) -> dict[str, Any]:
    async def check_owner() -> None:
        if await owner_check(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")

    require_access = hub_content_check(user_id, check_owner)
    await require_access()
    if not one_profile_research_enabled() or not magic_intelligence_rollout_enabled():
        return {"status": "disabled", "pkm_written": False}
    if not await asyncio.wait_for(setup_check(user_id), 5):
        return {"status": "not_ready", "pkm_written": False}
    record = await asyncio.wait_for(run_in_threadpool(identity_lookup, user_id), 5)
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise PermissionError("Account identity changed")
    if not magic_intelligence_owner_admitted(user_id, record):
        return {"status": "disabled", "pkm_written": False}
    check_saved = saved_check or magic_intelligence_saved
    if await asyncio.wait_for(check_saved(user_id), 5):
        return {"status": "saved", "pkm_written": False}
    admitted_email = record.email
    identity = await resolve_profile_research_identity(user_id, record)
    name, email, phone = identity["full_name"], identity["email"], identity["phone_number"]
    await require_access()
    if not name or len(name) > 160 or any(ord(char) < 32 for char in name):
        return {"status": "insufficient_identity", "pkm_written": False}
    if (email is not None and (not isinstance(email, str) or len(email) > 320)) or (
        phone is not None and (not isinstance(phone, str) or len(phone) > 64)
    ):
        return {"status": "insufficient_identity", "pkm_written": False}
    result = await researcher(
        identity=identity,
        user_id=user_id,
        consent_token=consent_token,
        require_access=require_access,
        **(
            {"attempts_used": attempts_used, "on_attempts_start": on_attempts_start}
            if attempts_used or on_attempts_start is not None
            else {}
        ),
    )
    await require_access()
    # Re-check the rollout switch before releasing an in-flight result.
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}
    current_record = await asyncio.wait_for(run_in_threadpool(identity_lookup, user_id), 5)
    await require_access()
    if (
        not one_profile_research_enabled()
        or not magic_intelligence_owner_admitted(user_id, current_record)
        or getattr(current_record, "email", None) != admitted_email
    ):
        return {"status": "disabled", "pkm_written": False}
    if await resolve_profile_research_identity(user_id, current_record) != identity:
        return {"status": "disabled", "pkm_written": False}
    if await asyncio.wait_for(check_saved(user_id), 5):
        return {"status": "saved", "pkm_written": False}
    await require_access()
    if not one_profile_research_enabled() or not magic_intelligence_owner_admitted(
        user_id, current_record
    ):
        return {"status": "disabled", "pkm_written": False}
    if result.get("status") == "unavailable":
        return {"pkm_written": False, **result}
    report = ProfileReport.model_validate(result["report"])
    logger.info(
        "one.profile_research_complete match=%s sections=%d",
        report.match_status,
        len(report.sections),
    )
    return {"status": "offered", "pkm_written": False, **result}
