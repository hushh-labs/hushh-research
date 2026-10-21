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
from hushh_mcp.one_adk.world_model_contracts import validated_facts_from_work
from hushh_mcp.runtime_settings import get_app_runtime_settings, one_profile_research_enabled
from hushh_mcp.services.chat_key import get_chat_key_provider
from hushh_mcp.services.one_owner_admission import lookup_fresh_owner_identity, owner_setup_resolved
from hushh_mcp.services.profile_research_jobs import TTL_SECONDS, ProfileResearchJobs
from hushh_mcp.services.profile_research_service import resolve_profile_research_identity
from hushh_mcp.services.world_model_preferences import (
    azure_bing_consented,
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
    if (
        POLICY["provider"] == "azure_openai_web_search"
        and get_app_runtime_settings().environment != "uat"
    ):
        # Only the UAT Cloud Run service identity is federated into Azure.
        return {"status": "disabled", "pkm_written": False}, ""
    identity = await owner_identity(user_id, consent_token)
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}, ""
    consent = await preferences(user_id)
    if not consent or not consent["enabled"]:
        return {"status": "consent_required", "pkm_written": False}, ""
    if POLICY["provider"] == "azure_openai_web_search" and not azure_bing_consented(consent):
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
            or (
                POLICY["provider"] == "azure_openai_web_search"
                and not azure_bing_consented(consent)
            )
            or str(consent["generation"]) != authorized_generation
        ):
            raise PermissionError("Research authority changed")

    runner = run_world_model
    provider_args = {}
    if POLICY["provider"] == "azure_openai_web_search":
        from hushh_mcp.one_adk.azure_workload_identity import azure_openai_token_provider
        from hushh_mcp.one_adk.world_model_azure import run_world_model_azure

        config = POLICY["azure"]
        token_provider = azure_openai_token_provider(
            tenant_id=config["tenant_id"], client_id=config["client_id"]
        )
        runner = run_world_model_azure
        provider_args = {
            "primary_endpoint": config["primary_endpoint"],
            "primary_deployment": config["primary_deployment"],
            "primary_token_supplier": token_provider,
        }
    result = await runner(
        identity=identity,
        user_id=user_id,
        consent_token=consent_token,
        require_access=require_access,
        attempts_used=attempts_used,
        on_attempts_start=on_attempts_start,
        work=work,
        on_progress=on_progress,
        owner_decisions=(inputs or {}).get("owner_decisions"),
        owner_public_profiles=(inputs or {}).get("public_profiles"),
        **provider_args,
    )
    refused, current = await admission(user_id, consent_token)
    if refused:
        return refused
    if original != current:
        raise PermissionError("Owner identity changed")
    return result


class PublicProfilesChanged(ValueError):
    """A different public seed requires an explicit, non-overlapping discovery."""


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

    def budget_scope(self) -> str:
        # Slot numbers are meaningful only within a provider's ledger layout.
        version = 1
        if POLICY["provider"] == "azure_openai_web_search":
            from hushh_mcp.one_adk.world_model_azure import AZURE_WORK_VERSION

            version = AZURE_WORK_VERSION
        return (
            f"{POLICY['provider']}:v{version}:"
            f"{self.search_slots}:{self.stored_attempts - self.search_slots}"
        )

    def prepare_start_state(self, state):
        if state is None:
            return state
        from hushh_mcp.one_adk.world_model_azure import AZURE_WORK_VERSION

        scope = self.budget_scope()
        prior_scope = state.get("budget_scope")
        if prior_scope == scope:
            return state
        work = state.get("work")
        if isinstance(work, dict) and "azure_work_version" in work:
            if (
                type(work["azure_work_version"]) is not int
                or work["azure_work_version"] != AZURE_WORK_VERSION
            ):
                raise RuntimeError("Unsupported discovery work version")
        if prior_scope is not None:
            # A same-provider layout change needs its own migration, even if
            # every old slot index happens to fit the new range.
            known_limits = {
                "vertex_google_search:v1:32:128": 160,
                "azure_openai_web_search:v1:8:16": 24,
            }
            prior_limit = known_limits.get(prior_scope) if isinstance(prior_scope, str) else None
            if prior_limit is None:
                raise RuntimeError("Unsupported discovery budget scope")
            prior_provider = prior_scope.split(":", 1)[0]
            if prior_provider == POLICY["provider"]:
                raise RuntimeError("Unsupported discovery budget scope")
            prior = state.get("attempted_combinations", [])
            if (
                not isinstance(prior, list)
                or any(type(index) is not int or not 1 <= index <= prior_limit for index in prior)
                or len(set(prior)) != len(prior)
            ):
                raise RuntimeError("Invalid discovery attempt budget")
            incompatible = True
        elif POLICY["provider"] == "vertex_google_search":
            incompatible = isinstance(work, dict) and "azure_work_version" in work
        elif isinstance(work, dict) and "azure_work_version" in work:
            # Azure checkpoints written before the scope marker shipped.
            return {**state, "budget_scope": scope}
        else:
            prior = state.get("attempted_combinations", [])
            valid_vertex_slots = (
                isinstance(prior, list)
                and all(type(index) is int and 1 <= index <= 160 for index in prior)
                and len(set(prior)) == len(prior)
            )
            incompatible = valid_vertex_slots and (
                work or any(index > self.stored_attempts for index in prior)
            )

        if incompatible:
            # A provider switch gets a fresh provider ledger and private work.
            # Hourly starts survive so switching cannot evade start limits.
            return {
                **{key: value for key, value in state.items() if key not in {"work", "inputs"}},
                "budget_scope": prior_scope or "legacy-provider-checkpoint",
                "identity_binding": "",
                "resume_binding": "",
                "attempted_combinations": [],
                "discovery_started_at": self.clock(),
            }
        # No incompatible evidence exists. Carry ambiguous paid slots rather
        # than granting a second Azure budget after an early provider failure.
        return {**state, "budget_scope": scope}

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
        if result["status"] not in {"pending", "paused", "unavailable"}:
            self.activity.pop(user_id, None)
            return result
        state = await self.store.get(user_id)
        if state is None or state.get("status") != result["status"]:
            return result
        if not state.get("identity_binding"):
            # The detached worker has not finished admission yet. No private
            # checkpoint exists to expose; keep the original pending signal.
            return result
        # Base status only checks the owner token while a job is pending. The
        # sealed checkpoint also needs current consent and the exact identity
        # binding before releasing titles, citations or provisional statements.
        refused, binding = await self.check(user_id, consent_token)
        if refused:
            return refused
        if state.get("identity_binding") != binding:
            return {"status": "pending", "pkm_written": False, "restart_required": True}
        current = await self.store.get(user_id)
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if current is None or any(
            current.get(key) != state.get(key) for key in ("revision", "fence")
        ):
            return {"status": "pending", "pkm_written": False, "restart_required": True}
        progress = derive_progress(
            state, now=self.clock(), revision_at=self.activity_at(user_id, state)
        )
        facts = validated_facts_from_work(state.get("work"))
        if POLICY["provider"] == "azure_openai_web_search":
            from hushh_mcp.one_adk.world_model_azure import checkpoint_usage

            usage = checkpoint_usage(state.get("work"), state.get("attempted_combinations", []))
            if usage is not None:
                result = {**result, "_provider_usage": usage}
        return {**result, "progress": progress, "validated_facts": facts}

    def committed(self):
        from hushh_mcp.services.world_model_notifications import world_model_notification_worker

        world_model_notification_worker.wake()

    async def job_context(self, user_id, consent_token):
        consent = await preferences(user_id)
        if (
            not consent
            or not consent["enabled"]
            or (
                POLICY["provider"] == "azure_openai_web_search"
                and not azure_bing_consented(consent)
            )
        ):
            raise PermissionError("Research consent required")
        return {
            "consent_generation": str(consent["generation"]),
            "budget_scope": self.budget_scope(),
        }

    def prepare_inputs(self, state, inputs, refresh_completed):
        from hushh_mcp.one_adk.public_sources import OwnerPublicProfiles

        prior = (state or {}).get("inputs") or {}
        carried = dict(prior if inputs is None else inputs)
        for field in ("public_profiles", "owner_decisions"):
            if field not in carried and field in prior:
                carried[field] = prior[field]
        profiles = carried.get("public_profiles")
        if profiles is not None:
            if POLICY["provider"] != "azure_openai_web_search":
                raise PublicProfilesChanged("Public profile discovery requires Azure consent")
            profiles = OwnerPublicProfiles.model_validate(profiles).model_dump()
            carried["public_profiles"] = profiles
        same = sorted((prior.get("public_profiles") or {}).get("urls", [])) == sorted(
            (profiles or {}).get("urls", [])
        )
        if not same and (
            not refresh_completed
            or (state and state["status"] == "pending" and self.reusable(state))
        ):
            raise PublicProfilesChanged("Public profiles changed")
        return carried or None, same

    async def ensure(self, user_id, consent_token, *, owner_decisions=None):
        # Azure/Bing needs a fresh owner opt-in; existing Vertex preferences
        # and default enrollment never grant it.
        enrolled = False
        if (
            POLICY["provider"] != "azure_openai_web_search"
            and one_profile_research_enabled()
            and await preferences(user_id) is None
            and await asyncio.wait_for(owner_setup_resolved(user_id), 5)
        ):
            await enroll_default(user_id, consent_token)
            enrolled = True
        refused, binding = await admission(user_id, consent_token)
        if refused:
            self.decision("ensure", "refused", refused, None)
            return refused
        consent = await preferences(user_id)
        state = await self.store.get(user_id)
        current_binding = state is not None and state.get("identity_binding") == binding
        if (
            state is not None
            and current_binding
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
            and current_binding
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
