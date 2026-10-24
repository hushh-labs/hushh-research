"""Bounded Magic discovery, detached from HTTP; encrypted owner checkpoints.

Execution is not autonomous: a fresh owner request claims an expired lease after
a worker restart. Completed drafts survive reloads in the existing person-key
session store, never in PKM. Credentials and keys are never persisted.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import re
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from openai import APIStatusError
from starlette.concurrency import run_in_threadpool

from db.connection import get_pool
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.encrypted_session_service import EncryptedSessionCheckpointStore
from hushh_mcp.one_adk.profile_research import (
    MAX_DISCOVERY_ATTEMPTS,
    MAX_STORED_COMBINATIONS,
    profile_research_policy_fingerprint,
)
from hushh_mcp.runtime_settings import one_profile_research_enabled
from hushh_mcp.services.chat_key import get_chat_key_provider, retain_request_chat_key
from hushh_mcp.services.magic_intelligence_admission import magic_intelligence_owner_admitted
from hushh_mcp.services.magic_intelligence_completion import magic_intelligence_saved
from hushh_mcp.services.one_owner_admission import lookup_fresh_owner_identity, owner_setup_resolved
from hushh_mcp.services.owner_placement_guard import admit_hub_content
from hushh_mcp.services.profile_research_service import (
    offer_profile_research,
    resolve_profile_research_identity,
)
from hushh_mcp.services.research_job_budget import refund_refused_charge

logger = logging.getLogger(__name__)
NAMESPACE = "one.magic.discovery.v1"
SESSION = "profile"
JOB_SECONDS = 200
LEASE_SECONDS = 240
TTL_SECONDS = 86400
FAILURE_COOLDOWN_SECONDS = 60
#: A provider that refuses credentials or billing refuses every owner: no run
#: can succeed until the project is repaired, so retries wait much longer.
PROVIDER_FAILURE_COOLDOWN_SECONDS = 900
PROVIDER_THROTTLE_COOLDOWN_SECONDS = 900
PROVIDER_BREAKER_FAILURES = 3
PROVIDER_BREAKER_SECONDS = 600
MAX_LOCAL_JOBS = 8


def pending(*, restart: bool = False) -> dict[str, Any]:
    return {"status": "pending", "pkm_written": False, "restart_required": restart}


def provider_error(error: BaseException) -> tuple[int | None, str | None]:
    """HTTP code and API status enum of a provider error; never its message."""
    seen: BaseException | None = error
    for _ in range(8):
        if seen is None:
            break
        code = getattr(seen, "code", None)
        if not (type(code) is int and 100 <= code < 600) and isinstance(seen, APIStatusError):
            code = seen.status_code
        if type(code) is int and 100 <= code < 600:
            status = getattr(seen, "status", None)
            safe = isinstance(status, str) and re.fullmatch(r"[A-Z][A-Z_]{0,63}", status)
            return code, status if safe else None
        seen = seen.__cause__ or seen.__context__
    return None, None


def provider_rejected(code: int | None, status: str | None) -> bool:
    """The provider refused the request before inference; no owner can fix it."""
    return code in {401, 403} or status in {"PERMISSION_DENIED", "UNAUTHENTICATED"}


def provider_throttled(code: int | None, status: str | None) -> bool:
    """A provider quota refusal is owner-retryable after a bounded wait."""
    return code == 429 or status == "RESOURCE_EXHAUSTED"


def _azure_search_without_receipt(work: Any) -> bool:
    """No received search can be resumed after an unknown Azure Bing charge."""
    if not isinstance(work, dict) or type(work.get("azure_work_version")) is not int:
        return False
    attempts = work.get("attempts")
    if not isinstance(attempts, dict) or not attempts:
        return False
    rows = list(attempts.values())
    return (
        all(isinstance(row, dict) for row in rows)
        and not any(row.get("observed") is True for row in rows)
        and any(row.get("state") == "started" and row.get("bing_requests") is None for row in rows)
    )


class ProviderBreaker:
    """Process-wide memory of recent provider credential/billing refusals.

    Holds timestamps only: never an owner, a job or provider text. Open after
    ``failures`` refusals inside ``window`` seconds, closed once they age out.
    """

    def __init__(self, *, failures=PROVIDER_BREAKER_FAILURES, window=PROVIDER_BREAKER_SECONDS):
        self.failures = failures
        self.window = window
        self.failed_at: list[float] = []

    def recent(self, now: float) -> list[float]:
        return [at for at in self.failed_at if at > now - self.window]

    def record(self, now: float) -> None:
        self.failed_at = [*self.recent(now), now][-self.failures :]

    def retry_after(self, now: float) -> int:
        """Seconds until the breaker closes again, or 0 while it is closed."""
        recent = self.recent(now)
        if len(recent) < self.failures:
            return 0
        return max(1, math.ceil(recent[0] + self.window - now))


provider_breaker = ProviderBreaker()


async def admission(user_id: str, consent_token: str) -> tuple[dict[str, Any] | None, str]:
    """Fresh, fail-closed authority for both dispatch and cached draft release."""
    await admit_hub_content(user_id, "profile_research")
    if await validate_first_party_owner_token(user_id, consent_token) is None:
        raise PermissionError("Owner session ended")
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}, ""
    if not await asyncio.wait_for(owner_setup_resolved(user_id), 5):
        return {"status": "not_ready", "pkm_written": False}, ""
    record = await asyncio.wait_for(run_in_threadpool(lookup_fresh_owner_identity, user_id), 5)
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise PermissionError("Account identity changed")
    if not magic_intelligence_owner_admitted(user_id, record):
        return {"status": "disabled", "pkm_written": False}, ""
    if await asyncio.wait_for(magic_intelligence_saved(user_id), 5):
        return {"status": "saved", "pkm_written": False}, ""
    # New research policy must not silently reuse an older, shallower draft.
    # Binding stays encrypted; changing it never clears the paid-start budget.
    identity = [
        user_id,
        await resolve_profile_research_identity(user_id, record),
        profile_research_policy_fingerprint(),
    ]
    binding = hmac.new(
        get_chat_key_provider().current_key(user_id), json.dumps(identity).encode(), hashlib.sha256
    ).hexdigest()
    if await validate_first_party_owner_token(user_id, consent_token) is None:
        raise PermissionError("Owner session ended")
    if not one_profile_research_enabled():
        return {"status": "disabled", "pkm_written": False}, ""
    await admit_hub_content(user_id, "profile_research")
    return None, binding


class ProfileResearchJobStore(EncryptedSessionCheckpointStore):
    """Bind discovery to its dedicated checkpoint; storage stays canonical."""

    def __init__(self, *, pool_provider=get_pool, cipher=None):
        super().__init__(
            app_name=NAMESPACE, session_id=SESSION, pool_provider=pool_provider, cipher=cipher
        )


class ProfileResearchJobs:
    #: Lifecycle log event prefix. Fields are codes and counts only: never
    #: names, contacts, statements, provider text, tokens or keys.
    log_event = "one.magic_discovery_"
    #: Attempt indices up to this are searches; the rest are model calls.
    search_slots = 0

    def __init__(
        self,
        *,
        store=None,
        offer=None,
        check=None,
        clock=time.time,
        max_attempts=MAX_DISCOVERY_ATTEMPTS,
        stored_attempts=MAX_STORED_COMBINATIONS,
        job_seconds=None,
        lease_seconds=None,
        preserve_budget_on_identity_change=False,
        review_ids=False,
        progressive=False,
        breaker=None,
    ):
        self.store = store or ProfileResearchJobStore()
        self.breaker = breaker or provider_breaker
        self.offer = offer or offer_profile_research
        self.check = check or admission
        self.review_ids = review_ids
        self.progressive = progressive
        self.clock = clock
        self.preserve_budget_on_identity_change = preserve_budget_on_identity_change
        self.max_attempts = max_attempts
        self.stored_attempts = stored_attempts
        self.job_seconds = job_seconds
        self.lease_seconds = lease_seconds
        self.tasks: set[asyncio.Task] = set()
        self.active = 0
        self.retention_task: asyncio.Task | None = None

    def start_retention(self) -> None:
        if self.retention_task is None or self.retention_task.done():
            self.retention_task = asyncio.create_task(
                self._retain(), name="magic-checkpoint-retention"
            )

    async def _retain(self) -> None:
        while True:
            await asyncio.sleep(3600)
            try:
                await self.purge_expired()
            except Exception:
                logger.warning("one.magic_discovery_retention_unavailable")

    async def purge_expired(self) -> None:
        await self.store.purge_expired()

    def checkpoint_retained(self, since: float) -> bool:
        return self.clock() - since < TTL_SECONDS

    def reusable(self, state: dict[str, Any]) -> bool:
        now = self.clock()
        if state["status"] == "pending":
            return now < state["started_at"] + (self.lease_seconds or LEASE_SECONDS)
        age = now - state["finished_at"]
        if state["status"] in {"offered", "low_confidence"} or self.exhausted(state):
            return self.checkpoint_retained(state["finished_at"])
        return state["status"] == "unavailable" and age < self.cooldown(state)

    @staticmethod
    def exhausted(state: dict[str, Any]) -> bool:
        return state["status"] == "unavailable" and (
            state.get("result", {}).get("retry_exhausted") is True
            or state.get("result", {}).get("research_exhausted") is True
            or _azure_search_without_receipt(state.get("work"))
        )

    @staticmethod
    def cooldown(state: dict[str, Any]) -> int:
        if state.get("result", {}).get("reason") == "provider_unavailable":
            return PROVIDER_FAILURE_COOLDOWN_SECONDS
        if state.get("result", {}).get("reason") == "provider_throttled":
            return PROVIDER_THROTTLE_COOLDOWN_SECONDS
        return FAILURE_COOLDOWN_SECONDS

    def reported(self, state: dict[str, Any]) -> dict[str, Any]:
        """A finished run's result; a cooling failure also says when a retry is accepted."""
        result = state["result"]
        if state["status"] != "unavailable":
            return result
        if _azure_search_without_receipt(state.get("work")):
            # Older UAT checkpoints persisted a generic unavailable result
            # before the SDK 429 was recognized. Correct the public readout
            # without changing the sealed ledger or dispatching another search.
            return {**result, "research_exhausted": True}
        if self.exhausted(state):
            return result
        remaining = state["finished_at"] + self.cooldown(state) - self.clock()
        return {**result, "retry_after_s": math.ceil(remaining)} if remaining > 0 else result

    def usage(self, attempted: Any) -> tuple[int, int]:
        rows = [index for index in attempted or [] if type(index) is int]
        searches = sum(1 for index in rows if index <= self.search_slots)
        return searches, len(rows) - searches

    def decision(
        self,
        op: str,
        decision: str,
        result: dict[str, Any] | None,
        state: dict | None,
        *,
        level: int = logging.INFO,
    ) -> None:
        searches, calls = self.usage((state or {}).get("attempted_combinations"))
        logger.log(
            level,
            "%sdecision op=%s decision=%s status=%s job=%s prior=%s starts_hour=%s searches_used=%s model_calls_used=%s",
            self.log_event,
            op,
            decision,
            (result or {}).get("status", "-"),
            (state or {}).get("job_id", "-"),
            (state or {}).get("status", "-"),
            len([at for at in (state or {}).get("starts", []) if at > self.clock() - 3600]),
            searches,
            calls,
        )

    async def status(self, user_id: str, consent_token: str) -> dict[str, Any]:
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if not one_profile_research_enabled():
            return {"status": "disabled", "pkm_written": False}
        state = await self.store.get(user_id)
        if state is None:
            return pending(restart=True)
        if state["status"] == "pending":
            return pending(restart=not self.reusable(state))
        refused, binding = await self.check(user_id, consent_token)
        if refused:
            return refused
        current = await self.store.get(user_id)
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if current is None or any(
            current.get(key) != state.get(key) for key in ("revision", "fence")
        ):
            return pending(restart=True)
        if state.get("identity_binding") != binding:
            return pending(restart=True)
        if state["status"] in {"disabled", "not_ready", "saved", "insufficient_identity"}:
            return state["result"]
        if self.progressive and state["status"] in {"paused", "unavailable"}:
            # A failed run is reported as failed. Reporting it as pending made
            # every observer restart it after each cooldown, forever. A new
            # run needs a fresh owner request (mount, retry), never a poll.
            return self.reported(state)
        if not self.reusable(state):
            return pending(restart=True)
        # A failed dependency gets a bounded cooldown and fresh-authority retry,
        # not a sticky failure cached in the mounted chat controller.
        return (
            pending()
            if state["status"] == "unavailable" and not self.exhausted(state)
            else state["result"]
        )

    async def start(
        self,
        user_id: str,
        consent_token: str,
        *,
        inputs: dict | None = None,
        refresh_completed: bool = False,
    ) -> dict[str, Any]:
        # Slow setup/identity/provider admission belongs to the bounded worker,
        # not the initiating exchange. Exact owner authority still gates even
        # the encrypted checkpoint claim; no model runs before full admission.
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if not one_profile_research_enabled():
            return {"status": "disabled", "pkm_written": False}
        context = await self.job_context(user_id, consent_token)
        state = self.prepare_start_state(await self.store.get(user_id), context=context)
        carried, same_inputs = self.prepare_inputs(state, inputs, refresh_completed)
        same_context = all((state or {}).get(key) == value for key, value in context.items())
        fresh_discovery = bool(
            refresh_completed
            and state
            and (
                not same_inputs
                or state["status"] in {"offered", "low_confidence"}
                or self.exhausted(state)
            )
        )
        if state and same_context and same_inputs and self.reusable(state) and not fresh_discovery:
            if state["status"] == "pending":
                self.decision("start", "reused_pending", None, state)
                return pending()
            # Database waits must not turn a pre-read admission into stale
            # authority to release a completed draft.
            refused, current_binding = await self.check(user_id, consent_token)
            if refused:
                self.decision("start", "refused", refused, state)
                return refused
            current = await self.store.get(user_id)
            if await validate_first_party_owner_token(user_id, consent_token) is None:
                raise PermissionError("Owner session ended")
            if current is None or any(
                current.get(key) != state.get(key) for key in ("revision", "fence")
            ):
                self.decision("start", "changed", None, state)
                return pending(restart=True)
            if state.get("identity_binding") == current_binding:
                cooling = state["status"] == "unavailable" and not self.exhausted(state)
                result = pending() if cooling and not self.progressive else self.reported(state)
                self.decision("start", "cooldown" if cooling else "reused", result, state)
                return result
        # The provider is refusing every owner: a new run would only fail and
        # spend the budget. Nothing is dispatched or charged until it reopens.
        retry_after = self.breaker.retry_after(self.clock())
        if retry_after:
            refused = {
                "status": "unavailable",
                "pkm_written": False,
                "reason": "provider_unavailable",
                "retry_after_s": retry_after,
            }
            self.decision("start", "provider_breaker", refused, state, level=logging.WARNING)
            return refused
        if self.active >= MAX_LOCAL_JOBS:
            self.decision("start", "capacity_busy", None, state)
            raise RuntimeError("Discovery capacity is temporarily busy")
        throttle_resume = bool(
            self.progressive
            and not fresh_discovery
            and state
            and same_context
            and same_inputs
            and state.get("status") == "unavailable"
            and state.get("result", {}).get("reason") == "provider_throttled"
            and self.checkpoint_retained(state.get("discovery_started_at", state["started_at"]))
        )
        if throttle_resume:
            refused, binding = await self.check(user_id, consent_token)
            if refused:
                return refused
            current = await self.store.get(user_id)
            if current is None or any(
                current.get(key) != state.get(key) for key in ("revision", "fence")
            ):
                return pending(restart=True)
            throttle_resume = state.get("identity_binding") == binding
        starts = [at for at in (state or {}).get("starts", []) if at > self.clock() - 3600]
        if len(starts) >= 3 and not throttle_resume:
            # Nothing is persisted for this refusal, so the only way the owner
            # learns how long to wait is here: a start is accepted again once
            # the oldest counted start ages out of the hour.
            refused = {
                "status": "unavailable",
                "pkm_written": False,
                "retry_after_s": max(1, math.ceil(min(starts) + 3600 - self.clock())),
            }
            self.decision("start", "budget_starts", refused, state)
            return refused
        prior_attempts = (state or {}).get("attempted_combinations", [])
        if (
            not isinstance(prior_attempts, list)
            or len(set(prior_attempts)) != len(prior_attempts)
            or any(
                type(index) is not int or not 1 <= index <= self.stored_attempts
                for index in prior_attempts
            )
        ):
            raise RuntimeError("Invalid discovery attempt budget")
        next_state = {
            "job_id": str(uuid.uuid4()),
            "status": "pending",
            "started_at": self.clock(),
            "identity_binding": "",
            "starts": starts,
            "resume_binding": (state or {}).get("identity_binding")
            or (state or {}).get("resume_binding", ""),
            "attempted_combinations": list(prior_attempts)
            if state
            and self.checkpoint_retained(state.get("discovery_started_at", state["started_at"]))
            else [],
            "discovery_started_at": (state or {}).get(
                "discovery_started_at", (state or {}).get("started_at", self.clock())
            ),
        }
        if fresh_discovery:
            # Explicit refresh buys a new bounded discovery, not another slice
            # with the completed run's spent slots. Validate the prior ledger
            # above and retain hourly starts plus the original CAS fence.
            next_state["attempted_combinations"] = []
            next_state["discovery_started_at"] = self.clock()
            next_state["resume_binding"] = ""
        # Only continuing a paused or lease-expired slice is free. A retry after
        # a failure is a new paid start even when it reuses saved evidence;
        # otherwise any saved evidence lifted the hourly start budget for the
        # whole day and a failing provider was retried every cooldown.
        resumed = False
        if (
            self.progressive
            and not fresh_discovery
            and same_context
            and same_inputs
            and state
            and (
                self.checkpoint_retained(state.get("discovery_started_at", state["started_at"]))
                and state["status"] in {"pending", "paused", "unavailable"}
            )
        ):
            next_state["work"] = state.get("work", {})
            next_state["job_id"] = state["job_id"]
            resumed = state["status"] in {"pending", "paused"} or throttle_resume
        # Feature-specific public inputs may bind discovery; private decisions
        # remain sealed, nonbinding model context.
        if carried:
            next_state["inputs"] = carried
        # Reserve before the awaited CAS, including contenders for other owners.
        next_state.update(context)
        self.active += 1
        dispatched = False
        try:
            revision = await self.store.write(user_id, next_state, state if state else None)
            if revision is None:
                self.decision("start", "lost_race", None, state)
                return pending()
            # Retain synchronously BEFORE the response exits. Only the derived
            # chat key is retained, with its existing absolute 300s ceiling.
            retained = retain_request_chat_key()
            retained.__enter__()
            released = False

            def release_key() -> None:
                nonlocal released
                if not released:
                    released = True
                    retained.__exit__(None, None, None)

            coroutine = self._run(
                user_id,
                consent_token,
                next_state,
                revision,
                release_key,
                resumed=resumed,
                paid_start_reusable=throttle_resume,
            )
            try:
                task = asyncio.create_task(coroutine, name="magic-discovery")
            except BaseException:
                coroutine.close()
                release_key()
                raise
            self.tasks.add(task)
            # Also release if shutdown cancels the task before its first tick.
            task.add_done_callback(lambda completed: (release_key(), self._finished(completed)))
            dispatched = True
            self.decision(
                "start",
                "refreshed" if fresh_discovery else "resumed" if resumed else "started",
                pending(),
                next_state,
            )
        finally:
            if not dispatched:
                self.active -= 1
        return pending()

    def _finished(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        self.active -= 1

    async def job_context(self, user_id, consent_token):
        return {}

    def prepare_inputs(self, state, inputs, refresh_completed):
        return ((state or {}).get("inputs") if inputs is None else inputs), True

    def prepare_start_state(
        self, state: dict[str, Any] | None, *, context=None
    ) -> dict[str, Any] | None:
        """Allow a feature to translate an older checkpoint before budget validation.

        The returned state retains its revision and fence for the store's CAS.
        Generic research never changes its paid attempt ledger.
        """
        return state

    def prepare_bound_inputs(self, state, binding):
        return state.get("inputs")

    def committed(self):
        pass

    async def _run(
        self,
        user_id: str,
        consent_token: str,
        state: dict[str, Any],
        revision: dict,
        release_key: Callable[[], None],
        *,
        resumed: bool = False,
        paid_start_reusable: bool = False,
    ) -> None:
        stage = "admission"
        began = time.monotonic()
        before = self.usage(state.get("attempted_combinations"))
        charges: list[tuple[int, ...]] = []  # this run's own charges, newest last
        charged_start: float | None = None  # the hourly start this run bought
        try:
            try:
                async with asyncio.timeout(self.job_seconds or JOB_SECONDS):
                    refused, original_binding = await self.check(user_id, consent_token)
                    used = (
                        state.get("attempted_combinations", [])
                        if self.preserve_budget_on_identity_change
                        or state.get("resume_binding") == original_binding
                        else []
                    )
                    state = {
                        **state,
                        "identity_binding": original_binding,
                        "attempted_combinations": used,
                    }
                    if self.progressive and state.get("resume_binding") != original_binding:
                        # Paid slots survive identity changes, private evidence does not.
                        state.pop("work", None)
                    bound_inputs = self.prepare_bound_inputs(state, original_binding)
                    if bound_inputs:
                        state["inputs"] = bound_inputs
                    else:
                        state.pop("inputs", None)
                    if not used:
                        state["discovery_started_at"] = self.clock()
                    if refused:
                        result = refused
                    else:
                        # Charge only research, not setup/policy reads. Commit
                        # that charge before the provider call, under this lease.
                        if not (
                            self.progressive
                            and resumed
                            and (
                                state.get("work")
                                or (
                                    paid_start_reusable
                                    and state.get("resume_binding") == original_binding
                                )
                            )
                        ):
                            charged_start = self.clock()
                            state = {**state, "starts": [*state["starts"], charged_start]}
                        charged = await self.store.write(user_id, state, revision)
                        if charged is None:
                            return
                        revision = charged
                        stage = "research"
                        before = self.usage(state["attempted_combinations"])
                        logger.info(
                            "%sstarted job=%s resumed=%s starts_hour=%s searches_used=%s model_calls_used=%s",
                            self.log_event,
                            state["job_id"],
                            bool(resumed and state.get("work")),
                            len([at for at in state["starts"] if at > self.clock() - 3600]),
                            *before,
                        )

                        async def charge_combinations(indices: tuple[int, ...]) -> None:
                            nonlocal state, revision
                            if (
                                await validate_first_party_owner_token(user_id, consent_token)
                                is None
                            ):
                                raise PermissionError("Owner session ended")
                            prior = state["attempted_combinations"]
                            if len(set(indices)) != len(indices) or any(
                                type(index) is not int
                                or not 1 <= index <= self.max_attempts
                                or index in prior
                                for index in indices
                            ):
                                raise ValueError("Combination budget already consumed")
                            charged_state = {**state, "attempted_combinations": [*prior, *indices]}
                            charged_revision = await self.store.write(
                                user_id, charged_state, revision
                            )
                            if charged_revision is None:
                                raise PermissionError("Discovery lease changed")
                            state, revision = charged_state, charged_revision
                            charges.append(tuple(indices))

                        async def checkpoint_progress(work: dict) -> None:
                            nonlocal state, revision
                            if (
                                await validate_first_party_owner_token(user_id, consent_token)
                                is None
                            ):
                                raise PermissionError("Owner session ended")
                            # Detached snapshot: later tool mutations cannot alter the
                            # state associated with an already-issued CAS revision.
                            progressed = {**state, "work": json.loads(json.dumps(work))}
                            next_revision = await self.store.write(user_id, progressed, revision)
                            if next_revision is None:
                                raise PermissionError("Discovery lease changed")
                            state, revision = progressed, next_revision

                        result = await self.offer(
                            user_id=user_id,
                            consent_token=consent_token,
                            attempts_used=tuple(used),
                            on_attempts_start=charge_combinations,
                            **(
                                {"work": state.get("work", {}), "on_progress": checkpoint_progress}
                                if self.progressive
                                else {}
                            ),
                            **({"inputs": state["inputs"]} if state.get("inputs") else {}),
                        )
                        stage = "release"
                        refused, binding = await self.check(user_id, consent_token)
                        if refused:
                            result = refused
                        elif binding != original_binding:
                            result = {"status": "disabled", "pkm_written": False}
            except PermissionError:
                result = {"status": "disabled", "pkm_written": False}
            except Exception as error:
                # Exception class metadata only: provider messages/prompts and
                # identifiers must never enter diagnostic output.
                cause = error.__cause__ or error
                partial = getattr(error, "partial_turn", None)
                # Only authored code coordinates, never exception messages or
                # frame locals containing identifiers, findings or credentials.
                origin = "unknown"
                frame = cause.__traceback__
                while frame is not None:
                    code = frame.tb_frame.f_code
                    origin = f"{Path(code.co_filename).name}:{code.co_name}:{frame.tb_lineno}"
                    frame = frame.tb_next
                provider_code, provider_status = provider_error(error)
                rejected = provider_rejected(provider_code, provider_status)
                throttled = provider_throttled(provider_code, provider_status)
                if rejected:
                    self.breaker.record(self.clock())
                state, refund = refund_refused_charge(
                    state, charges, charged_start, rejected=rejected
                )
                logger.warning(
                    "%sfailed stage=%s job=%s error_type=%s cause_type=%s cause_origin=%s provider_code=%s provider_status=%s provider_rejected=%s provider_throttled=%s refunded=%s provider_failures=%s llm_calls=%s elapsed_ms=%s duration_ms=%s",
                    self.log_event,
                    stage,
                    state.get("job_id"),
                    type(error).__name__,
                    type(cause).__name__,
                    origin,
                    provider_code,
                    provider_status,
                    rejected,
                    throttled,
                    len(refund),
                    len(self.breaker.recent(self.clock())),
                    getattr(partial, "llm_calls", None),
                    getattr(partial, "elapsed_ms", None),
                    int((time.monotonic() - began) * 1000),
                )
                result = {"status": "unavailable", "pkm_written": False}
                if rejected:
                    result["reason"] = "provider_unavailable"
                elif throttled:
                    # 429 may arrive after a partial response; keep every paid
                    # provider slot unless the provider proved it did no work.
                    result["reason"] = "provider_throttled"
                    if _azure_search_without_receipt(state.get("work")):
                        # The unknown Bing spend uses the entire search cap.
                        # Retain the checkpoint, but do not promise a retry
                        # that can only return unavailable again.
                        result["research_exhausted"] = True
            # Never persist token/key. A lost CAS means a new lease superseded
            # this run; discard the draft rather than overwriting its result.
            if self.review_ids and (
                result["status"] == "offered"
                or (
                    self.progressive
                    and result["status"] in {"unavailable", "insufficient_identity"}
                )
            ):
                result = {**result, "draft_id": state["job_id"]}
            terminal = {
                **state,
                "status": result["status"],
                "result": result,
                "finished_at": self.clock(),
            }
            committed = await self.store.write(user_id, terminal, revision)
            after = self.usage(state.get("attempted_combinations"))
            logger.info(
                "%sfinished status=%s job=%s committed=%s research_exhausted=%s duration_ms=%s searches=%s model_calls=%s searches_used=%s model_calls_used=%s",
                self.log_event,
                result["status"],
                state.get("job_id"),
                committed is not None,
                result.get("research_exhausted") is True or result.get("retry_exhausted") is True,
                int((time.monotonic() - began) * 1000),
                after[0] - before[0],
                after[1] - before[1],
                *after,
            )
            if committed is not None:
                self.committed()
        except asyncio.CancelledError:
            # The checkpoint remains pending. Fresh owner auth can reclaim its
            # expired lease; never resume automatically with saved credentials.
            raise
        except Exception as error:
            logger.warning(
                "%scheckpoint_unavailable job=%s error_type=%s",
                self.log_event,
                state.get("job_id"),
                type(error).__name__,
            )
        finally:
            consent_token = ""
            release_key()

    async def shutdown(self) -> None:
        tasks = list(self.tasks)
        if self.retention_task is not None:
            tasks.append(self.retention_task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


profile_research_jobs = ProfileResearchJobs()
