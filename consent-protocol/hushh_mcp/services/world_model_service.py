"""Personal World Model uses existing owner authority and encrypted checkpoints."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re

from starlette.concurrency import run_in_threadpool

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.encrypted_session_service import EncryptedSessionCheckpointStore
from hushh_mcp.one_adk.world_model import policy_fingerprint, run_world_model
from hushh_mcp.runtime_settings import one_profile_research_enabled
from hushh_mcp.services.chat_key import get_chat_key_provider
from hushh_mcp.services.one_owner_admission import lookup_fresh_owner_identity, owner_setup_resolved
from hushh_mcp.services.owner_placement_guard import hub_content_check
from hushh_mcp.services.profile_research_jobs import ProfileResearchJobs
from hushh_mcp.services.profile_research_service import resolve_profile_research_identity

NAMESPACE = "one.personal_world_model.v1"


def content_access(user_id, consent_token):
    async def check_owner():
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")

    return hub_content_check(user_id, check_owner)


async def owner_identity(user_id, consent_token, *, conn=None):
    if (
        await validate_first_party_owner_token(
            user_id, consent_token, **({"conn": conn} if conn is not None else {})
        )
        is None
    ):
        raise PermissionError("Owner session ended")
    record = await asyncio.wait_for(run_in_threadpool(lookup_fresh_owner_identity, user_id), 5)
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise PermissionError("Owner identity changed")
    identity = await resolve_profile_research_identity(
        user_id, record, **({"conn": conn} if conn is not None else {})
    )
    name, email, phone = (identity[key] for key in ("full_name", "email", "phone_number"))
    if (
        not name
        or len(name) > 160
        or any(ord(c) < 32 for c in name)
        or (email is not None and (not isinstance(email, str) or len(email) > 320))
        or (phone is not None and not re.fullmatch(r"\+[1-9]\d{7,14}", phone))
        or not (email or phone)
    ):
        return None
    if (
        await validate_first_party_owner_token(
            user_id, consent_token, **({"conn": conn} if conn is not None else {})
        )
        is None
    ):
        raise PermissionError("Owner session ended")
    return identity


async def admission(user_id, consent_token):
    require_access = content_access(user_id, consent_token)
    await require_access()
    identity = await owner_identity(user_id, consent_token)
    await require_access()
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}, ""
    setup_ready = await asyncio.wait_for(owner_setup_resolved(user_id), 5)
    await require_access()
    if not setup_ready:
        return {"status": "not_ready", "pkm_written": False}, ""
    if identity is None:
        return {"status": "insufficient_identity", "pkm_written": False}, ""
    binding = hmac.new(
        get_chat_key_provider().current_key(user_id),
        json.dumps([user_id, identity, policy_fingerprint()], sort_keys=True).encode(),
        hashlib.sha256,
    ).hexdigest()
    await require_access()
    return None, binding


async def offer(*, user_id, consent_token, attempts_used=(), on_attempts_start=None):
    refused, original = await admission(user_id, consent_token)
    if refused:
        return refused
    identity = await owner_identity(user_id, consent_token)

    async def check_owner():
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if not one_profile_research_enabled():
            raise PermissionError("Research disabled")

    require_access = hub_content_check(user_id, check_owner)
    await require_access()
    result = await run_world_model(
        identity=identity,
        user_id=user_id,
        consent_token=consent_token,
        require_access=require_access,
        attempts_used=attempts_used,
        on_attempts_start=on_attempts_start,
    )
    await require_access()
    refused, current = await admission(user_id, consent_token)
    if refused:
        return refused
    if original != current:
        raise PermissionError("Owner identity changed")
    return result


class WorldModelJobs(ProfileResearchJobs):
    async def start(self, user_id, consent_token):
        require_access = content_access(user_id, consent_token)
        await require_access()
        result = await super().start(user_id, consent_token)
        await require_access()
        return result

    async def status(self, user_id, consent_token):
        require_access = content_access(user_id, consent_token)
        await require_access()
        result = await super().status(user_id, consent_token)
        await require_access()
        return result

    async def dismiss(self, user_id, consent_token, draft_id=None):
        require_access = content_access(user_id, consent_token)
        await require_access()
        state = await self.store.get(user_id)
        await require_access()
        if state is None:
            return
        if (draft_id is not None and state.get("job_id") != draft_id) or (
            draft_id is None
            and state["status"]
            not in {"saved", "unavailable", "disabled", "not_ready", "insufficient_identity"}
        ):
            raise RuntimeError("Draft changed; refresh before discarding")
        # A tombstone removes content and changes the CAS fence. A worker already
        # running cannot resurrect it; budget counters survive a manual retry.
        tombstone = {
            key: value for key, value in state.items() if key not in {"result", "fence", "revision"}
        }
        tombstone.update(
            status="saved",
            finished_at=self.clock(),
            result={"status": "saved", "pkm_written": False},
        )
        await require_access()
        written = await self.store.write(user_id, tombstone, state)
        await require_access()
        if written is None:
            raise RuntimeError("Draft changed; retry discard")


world_model_jobs = WorldModelJobs(
    store=EncryptedSessionCheckpointStore(app_name=NAMESPACE, session_id="profile"),
    offer=offer,
    check=admission,
    max_attempts=52,
    stored_attempts=52,
    job_seconds=270,
    lease_seconds=300,
    preserve_budget_on_identity_change=True,
    review_ids=True,
)
