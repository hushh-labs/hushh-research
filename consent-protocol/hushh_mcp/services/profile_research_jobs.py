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
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

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
from hushh_mcp.services.profile_research_service import (
    offer_profile_research,
    resolve_profile_research_identity,
)

logger = logging.getLogger(__name__)
NAMESPACE = "one.magic.discovery.v1"
SESSION = "profile"
JOB_SECONDS = 200
LEASE_SECONDS = 240
TTL_SECONDS = 86400
FAILURE_COOLDOWN_SECONDS = 60
MAX_LOCAL_JOBS = 8


def pending(*, restart: bool = False) -> dict[str, Any]:
    return {"status": "pending", "pkm_written": False, "restart_required": restart}


async def admission(user_id: str, consent_token: str) -> tuple[dict[str, Any] | None, str]:
    """Fresh, fail-closed authority for both dispatch and cached draft release."""
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
    return None, binding


class ProfileResearchJobStore(EncryptedSessionCheckpointStore):
    """Bind discovery to its dedicated checkpoint; storage stays canonical."""

    def __init__(self, *, pool_provider=get_pool, cipher=None):
        super().__init__(
            app_name=NAMESPACE, session_id=SESSION, pool_provider=pool_provider, cipher=cipher
        )


class ProfileResearchJobs:
    def __init__(self, *, store=None, offer=None, check=None, clock=time.time):
        self.store = store or ProfileResearchJobStore()
        self.offer = offer or offer_profile_research
        self.check = check or admission
        self.clock = clock
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
                await self.store.purge_expired()
            except Exception:
                logger.warning("one.magic_discovery_retention_unavailable")

    def reusable(self, state: dict[str, Any]) -> bool:
        now = self.clock()
        if state["status"] == "pending":
            return now < state["started_at"] + LEASE_SECONDS
        age = now - state["finished_at"]
        if state["status"] in {"offered", "low_confidence"} or self.exhausted(state):
            return age < TTL_SECONDS
        return state["status"] == "unavailable" and age < FAILURE_COOLDOWN_SECONDS

    @staticmethod
    def exhausted(state: dict[str, Any]) -> bool:
        return (
            state["status"] == "unavailable"
            and state.get("result", {}).get("retry_exhausted") is True
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
        if state.get("identity_binding") != binding:
            return pending(restart=True)
        if state["status"] in {"disabled", "not_ready", "saved", "insufficient_identity"}:
            return state["result"]
        if not self.reusable(state):
            return pending(restart=True)
        # A failed dependency gets a bounded cooldown and fresh-authority retry,
        # not a sticky failure cached in the mounted chat controller.
        return (
            pending()
            if state["status"] == "unavailable" and not self.exhausted(state)
            else state["result"]
        )

    async def start(self, user_id: str, consent_token: str) -> dict[str, Any]:
        # Slow setup/identity/provider admission belongs to the bounded worker,
        # not the initiating exchange. Exact owner authority still gates even
        # the encrypted checkpoint claim; no model runs before full admission.
        if await validate_first_party_owner_token(user_id, consent_token) is None:
            raise PermissionError("Owner session ended")
        if not one_profile_research_enabled():
            return {"status": "disabled", "pkm_written": False}
        state = await self.store.get(user_id)
        if state and self.reusable(state):
            if state["status"] == "pending":
                return pending()
            # Database waits must not turn a pre-read admission into stale
            # authority to release a completed draft.
            refused, current_binding = await self.check(user_id, consent_token)
            if refused:
                return refused
            if state.get("identity_binding") == current_binding:
                return (
                    pending()
                    if state["status"] == "unavailable" and not self.exhausted(state)
                    else state["result"]
                )
        if self.active >= MAX_LOCAL_JOBS:
            raise RuntimeError("Discovery capacity is temporarily busy")
        starts = [at for at in (state or {}).get("starts", []) if at > self.clock() - 3600]
        if len(starts) >= 3:
            return {"status": "unavailable", "pkm_written": False}
        prior_attempts = (state or {}).get("attempted_combinations", [])
        if (
            not isinstance(prior_attempts, list)
            or len(set(prior_attempts)) != len(prior_attempts)
            or any(
                type(index) is not int or not 1 <= index <= MAX_STORED_COMBINATIONS
                for index in prior_attempts
            )
        ):
            raise RuntimeError("Invalid discovery attempt budget")
        next_state = {
            "status": "pending",
            "started_at": self.clock(),
            "identity_binding": "",
            "starts": starts,
            "resume_binding": (state or {}).get("identity_binding")
            or (state or {}).get("resume_binding", ""),
            "attempted_combinations": list(prior_attempts)
            if state
            and self.clock() - state.get("discovery_started_at", state["started_at"]) < TTL_SECONDS
            else [],
            "discovery_started_at": (state or {}).get(
                "discovery_started_at", (state or {}).get("started_at", self.clock())
            ),
        }
        # Reserve before the awaited CAS, including contenders for other owners.
        self.active += 1
        dispatched = False
        try:
            revision = await self.store.write(user_id, next_state, state if state else None)
            if revision is None:
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

            coroutine = self._run(user_id, consent_token, next_state, revision, release_key)
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
        finally:
            if not dispatched:
                self.active -= 1
        return pending()

    def _finished(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        self.active -= 1

    async def _run(
        self,
        user_id: str,
        consent_token: str,
        state: dict[str, Any],
        revision: dict,
        release_key: Callable[[], None],
    ) -> None:
        stage = "admission"
        try:
            try:
                async with asyncio.timeout(JOB_SECONDS):
                    refused, original_binding = await self.check(user_id, consent_token)
                    used = (
                        state.get("attempted_combinations", [])
                        if state.get("resume_binding") == original_binding
                        else []
                    )
                    state = {
                        **state,
                        "identity_binding": original_binding,
                        "attempted_combinations": used,
                    }
                    if not used:
                        state["discovery_started_at"] = self.clock()
                    if refused:
                        result = refused
                    else:
                        # Charge only research, not setup/policy reads. Commit
                        # that charge before the provider call, under this lease.
                        state = {**state, "starts": [*state["starts"], self.clock()]}
                        charged = await self.store.write(user_id, state, revision)
                        if charged is None:
                            return
                        revision = charged
                        stage = "research"

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
                                or not 1 <= index <= MAX_DISCOVERY_ATTEMPTS
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

                        result = await self.offer(
                            user_id=user_id,
                            consent_token=consent_token,
                            attempts_used=tuple(used),
                            on_attempts_start=charge_combinations,
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
                logger.warning(
                    "one.magic_discovery_failed stage=%s error_type=%s cause_type=%s cause_origin=%s llm_calls=%s elapsed_ms=%s",
                    stage,
                    type(error).__name__,
                    type(cause).__name__,
                    origin,
                    getattr(partial, "llm_calls", None),
                    getattr(partial, "elapsed_ms", None),
                )
                result = {"status": "unavailable", "pkm_written": False}
            # Never persist token/key. A lost CAS means a new lease superseded
            # this run; discard the draft rather than overwriting its result.
            terminal = {
                **state,
                "status": result["status"],
                "result": result,
                "finished_at": self.clock(),
            }
            await self.store.write(user_id, terminal, revision)
            logger.info("one.magic_discovery_finished status=%s", result["status"])
        except asyncio.CancelledError:
            # The checkpoint remains pending. Fresh owner auth can reclaim its
            # expired lease; never resume automatically with saved credentials.
            raise
        except Exception:
            logger.warning("one.magic_discovery_checkpoint_unavailable")
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
