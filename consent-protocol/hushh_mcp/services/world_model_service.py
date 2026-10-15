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
from hushh_mcp.one_adk.world_model import (
    MAX_MODEL_CALLS,
    MAX_SEARCHES,
    POLICY,
    policy_fingerprint,
    run_world_model,
)
from hushh_mcp.runtime_settings import one_profile_research_enabled
from hushh_mcp.services.chat_key import get_chat_key_provider
from hushh_mcp.services.one_owner_admission import lookup_fresh_owner_identity, owner_setup_resolved
from hushh_mcp.services.profile_research_jobs import TTL_SECONDS, ProfileResearchJobs
from hushh_mcp.services.profile_research_service import resolve_profile_research_identity
from hushh_mcp.services.world_model_preferences import (
    checkpoint_before_write,
    checkpoint_committed,
    draft_completed,
    enroll_default,
    preferences,
)
from hushh_mcp.services.world_model_progress import derive_progress

NAMESPACE = "one.personal_world_model.v1"
# A finished model is prepared again once its latest run is this old.
PWM_REPREPARE_AFTER_SECONDS = 7 * 86400


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
    identity = await owner_identity(user_id, consent_token)
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}, ""
    consent = await preferences(user_id)
    if not consent or not consent["enabled"]:
        return {"status": "consent_required", "pkm_written": False}, ""
    if not await asyncio.wait_for(owner_setup_resolved(user_id), 5):
        return {"status": "not_ready", "pkm_written": False}, ""
    if identity is None:
        return {"status": "insufficient_identity", "pkm_written": False}, ""
    binding = hmac.new(
        get_chat_key_provider().current_key(user_id),
        json.dumps(
            [user_id, identity, policy_fingerprint(), str(consent["generation"])], sort_keys=True
        ).encode(),
        hashlib.sha256,
    ).hexdigest()
    if await validate_first_party_owner_token(user_id, consent_token) is None:
        raise PermissionError("Owner session ended")
    return None, binding


async def offer(
    *,
    user_id,
    consent_token,
    attempts_used=(),
    on_attempts_start=None,
    work=None,
    on_progress=None,
    inputs=None,
):
    refused, original = await admission(user_id, consent_token)
    if refused:
        return refused
    identity = await owner_identity(user_id, consent_token)
    authorized_generation = str((await preferences(user_id))["generation"])

    async def require_access():
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if not one_profile_research_enabled():
            raise PermissionError("Research disabled")
        consent = await preferences(user_id)
        if (
            not consent
            or not consent["enabled"]
            or str(consent["generation"]) != authorized_generation
        ):
            raise PermissionError("Research authority changed")

    result = await run_world_model(
        identity=identity,
        user_id=user_id,
        consent_token=consent_token,
        require_access=require_access,
        attempts_used=attempts_used,
        on_attempts_start=on_attempts_start,
        work=work,
        on_progress=on_progress,
        owner_decisions=(inputs or {}).get("owner_decisions"),
    )
    refused, current = await admission(user_id, consent_token)
    if refused:
        return refused
    if original != current:
        raise PermissionError("Owner identity changed")
    return result


class WorldModelJobs(ProfileResearchJobs):
    log_event = "one.pwm_"
    search_slots = MAX_SEARCHES
    #: Owners whose last-seen checkpoint revision this process remembers.
    activity_capacity = 1024

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # user_id -> (revision, when this process first saw it). The store does
        # not return a write time; this is the best per-process stand-in.
        self.activity: dict[str, tuple[int, float]] = {}

    def activity_at(self, user_id, state):
        revision = state.get("revision")
        seen = self.activity.get(user_id)
        if seen is None or seen[0] != revision:
            if len(self.activity) >= self.activity_capacity:
                self.activity.pop(next(iter(self.activity)))
            seen = self.activity[user_id] = (revision, self.clock())
        return seen[1]

    async def status(self, user_id, consent_token):
        result = await super().status(user_id, consent_token)
        if result["status"] not in {"pending", "paused"}:
            self.activity.pop(user_id, None)
            return result
        # Progress is additive and derived from the sealed checkpoint only;
        # the key that opens it is the same request-bound key as the status.
        state = await self.store.get(user_id)
        if state is None:
            return result
        progress = derive_progress(
            state, now=self.clock(), revision_at=self.activity_at(user_id, state)
        )
        return {**result, "progress": progress}

    def committed(self):
        from hushh_mcp.services.world_model_notifications import world_model_notification_worker

        world_model_notification_worker.wake()

    async def job_context(self, user_id, consent_token):
        consent = await preferences(user_id)
        if not consent or not consent["enabled"]:
            raise PermissionError("Research consent required")
        return {"consent_generation": str(consent["generation"])}

    async def ensure(self, user_id, consent_token, *, owner_decisions=None):
        # Research is on by default once setup disclosed it. An existing row,
        # including an explicit opt-out, is never changed here.
        enrolled = False
        if (
            one_profile_research_enabled()
            and await preferences(user_id) is None
            and await asyncio.wait_for(owner_setup_resolved(user_id), 5)
        ):
            await enroll_default(user_id, consent_token)
            enrolled = True
        refused, _ = await admission(user_id, consent_token)
        if refused:
            self.decision("ensure", "refused", refused, None)
            return refused
        consent = await preferences(user_id)
        state = await self.store.get(user_id)
        if (
            state is not None
            and state.get("status") in {"offered", "low_confidence", "saved"}
            and self.clock() - state.get("finished_at", self.clock()) >= TTL_SECONDS
        ):
            # Past retention but not yet purged: decide as if it is already gone,
            # so an aged-out draft never buys a new run before the interval.
            state = None
        last_run = consent["auto_started_at"]
        active_draft = consent.get("active_draft_id")
        if (
            state is None
            and last_run is not None
            and self.clock() - last_run.timestamp() < PWM_REPREPARE_AFTER_SECONDS
            and (active_draft is None or await draft_completed(user_id, active_draft))
        ):
            # The latest run finished recently and its draft aged out. A run the
            # retention purge removed before it finished is prepared again.
            result = {"status": "saved", "pkm_written": False}
            self.decision("ensure", "recently_prepared", result, None)
            return result
        if (
            state
            and state["status"] == "saved"
            and state.get("consent_generation") == str(consent["generation"])
        ):
            self.decision("ensure", "saved", state["result"], state)
            return state["result"]
        self.decision("ensure", "enrolled_start" if enrolled else "start", None, state)
        inputs = None if owner_decisions is None else {"owner_decisions": owner_decisions}
        return await self.start(user_id, consent_token, inputs=inputs)

    async def dismiss(self, user_id, consent_token, draft_id=None):
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        state = await self.store.get(user_id)
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
            key: value
            for key, value in state.items()
            if key not in {"result", "work", "fence", "revision"}
        }
        tombstone.update(
            status="saved",
            finished_at=self.clock(),
            result={"status": "saved", "pkm_written": False},
        )
        if await self.store.write(user_id, tombstone, state) is None:
            raise RuntimeError("Draft changed; retry discard")


world_model_jobs = WorldModelJobs(
    store=EncryptedSessionCheckpointStore(
        app_name=NAMESPACE,
        session_id="profile",
        on_commit=checkpoint_committed,
        before_write=checkpoint_before_write,
    ),
    offer=offer,
    check=admission,
    max_attempts=MAX_SEARCHES + MAX_MODEL_CALLS,
    stored_attempts=MAX_SEARCHES + MAX_MODEL_CALLS,
    job_seconds=POLICY["job_seconds"],
    lease_seconds=POLICY["lease_seconds"],
    preserve_budget_on_identity_change=True,
    review_ids=True,
    progressive=True,
)
