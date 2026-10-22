"""Discovery outlives HTTP, not authority; checkpoints are not owner Memory."""

import asyncio
import copy
import os
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from openai import AuthenticationError, PermissionDeniedError, RateLimitError

from hushh_mcp.services import profile_research_jobs as jobs
from hushh_mcp.services.chat_key import (
    CHAT_CIPHERTEXT_PREFIX,
    RequestChatKey,
    bind_request_chat_key,
)

RESULT = {
    "status": "offered",
    "pkm_written": False,
    "report": {
        "match_status": "no_match",
        "name": "Example Person",
        "summary": "No reliable public match.",
        "sections": [],
    },
    "search_suggestions": [],
}


class MemoryStore:
    def __init__(self):
        self.rows = {}
        self.generation = 0

    async def get(self, owner):
        return copy.deepcopy(self.rows.get(owner))

    async def write(self, owner, state, expected):
        row = self.rows.get(owner)
        if (expected is None and row is not None) or (
            expected is not None
            and (row is None or any(row[k] != expected[k] for k in ("revision", "fence")))
        ):
            return None
        self.generation += 1
        receipt = {"revision": (row["revision"] if row else 0) + 1, "fence": str(self.generation)}
        self.rows[owner] = {**copy.deepcopy(state), **receipt}
        return receipt


@pytest.fixture(autouse=True)
def authority(monkeypatch):
    from hushh_mcp.services import world_model_service

    monkeypatch.setattr(
        world_model_service,
        "preferences",
        AsyncMock(
            return_value={
                "enabled": True,
                "generation": "00000000-0000-4000-8000-000000000001",
                "auto_started_at": None,
            }
        ),
    )
    monkeypatch.setattr(jobs, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    monkeypatch.setattr(jobs, "one_profile_research_enabled", lambda: True)
    # The breaker is process-wide; one test's provider refusals must not leak.
    monkeypatch.setattr(jobs, "provider_breaker", jobs.ProviderBreaker())


def manager(store=None, offer=None, check=None, clock=None):
    return jobs.ProfileResearchJobs(
        store=store or MemoryStore(),
        offer=offer or AsyncMock(return_value=RESULT),
        check=check or AsyncMock(return_value=(None, "owner-bound-identity")),
        **({"clock": clock} if clock else {}),
    )


async def settle(instance):
    if instance.tasks:
        await asyncio.gather(*list(instance.tasks))


@pytest.mark.asyncio
async def test_start_returns_while_model_is_blocked_and_duplicate_start_is_coalesced():
    gate = asyncio.Event()

    async def offer(**kwargs):
        await gate.wait()
        return RESULT

    researcher = AsyncMock(side_effect=offer)
    first = manager(offer=researcher)
    second = manager(store=first.store, offer=researcher)
    assert (await asyncio.wait_for(first.start("owner", "fixture-token"), 0.2))[
        "status"
    ] == "pending"
    assert (await second.start("owner", "fixture-token"))["status"] == "pending"
    await asyncio.sleep(0)
    assert researcher.await_count == 1
    assert (await first.status("owner", "fixture-token"))["status"] == "pending"
    gate.set()
    await settle(first)
    assert await second.status("owner", "fresh-fixture-token") == RESULT
    assert (await second.start("owner", "fresh-fixture-token")) == RESULT
    assert researcher.await_count == 1


@pytest.mark.asyncio
async def test_poll_cancellation_does_not_cancel_background_or_repeat_model():
    gate = asyncio.Event()

    async def offer(**kwargs):
        await gate.wait()
        return RESULT

    instance = manager(offer=AsyncMock(side_effect=offer))
    await instance.start("owner", "fixture-token")
    poll_gate = asyncio.Event()

    async def validating(*args):
        await poll_gate.wait()
        return object()

    jobs.validate_first_party_owner_token.side_effect = validating
    poll = asyncio.create_task(instance.status("owner", "fixture-token"))
    await asyncio.sleep(0)
    poll.cancel()
    with pytest.raises(asyncio.CancelledError):
        await poll
    # A canceled client read owns neither worker nor research cancellation.
    jobs.validate_first_party_owner_token.side_effect = None
    gate.set()
    await settle(instance)
    restored = manager(store=instance.store)
    assert await restored.status("owner", "fresh-fixture-token") == RESULT
    restored.offer.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("refused", ["saved", "disabled", "not_ready"])
async def test_cached_result_rechecks_current_admission(refused):
    instance = manager()
    await instance.start("owner", "fixture-token")
    await settle(instance)
    instance.check = AsyncMock(return_value=({"status": refused, "pkm_written": False}, ""))
    assert (await instance.status("owner", "fixture-token"))["status"] == refused


@pytest.mark.asyncio
async def test_identity_change_cannot_release_old_report():
    instance = manager()
    await instance.start("owner", "fixture-token")
    await settle(instance)
    instance.check = AsyncMock(return_value=(None, "new-identity"))
    assert await instance.status("owner", "fixture-token") == jobs.pending(restart=True)
    jobs.validate_first_party_owner_token.return_value = None
    with pytest.raises(PermissionError):
        await instance.status("owner", "revoked-fixture-token")


async def test_low_confidence_is_reused_without_research_but_still_rechecks_owner():
    low = {
        "status": "low_confidence",
        "pkm_written": False,
        "verification": {
            "method": "model_assessment",
            "identity_score": 80,
            "facts": [],
            "attempts": 7,
        },
    }
    offer = AsyncMock(return_value=low)
    first = manager(offer=offer)
    await first.start("owner", "fixture-token")
    await settle(first)
    restored = manager(store=first.store, offer=offer)
    assert await restored.status("owner", "fresh-fixture-token") == low
    assert await restored.start("owner", "fresh-fixture-token") == low
    assert offer.await_count == 1
    restored.check = AsyncMock(return_value=({"status": "disabled", "pkm_written": False}, ""))
    assert (await restored.status("owner", "fixture-token"))["status"] == "disabled"


@pytest.mark.parametrize(
    "terminal", ["offered", "low_confidence", "exhausted", "throttled_exhausted"]
)
async def test_explicit_completed_refresh_gets_new_discovery_but_retains_hourly_limit(terminal):
    clock = [10_000.0]
    exhausted = terminal.endswith("exhausted")
    status = "unavailable" if exhausted else terminal
    result = {**RESULT, "status": status}
    if exhausted:
        result["research_exhausted"] = True
    if terminal == "throttled_exhausted":
        result["reason"] = "provider_throttled"
    offer = AsyncMock(return_value=result)
    instance = manager(offer=offer, clock=lambda: clock[0])
    instance.progressive = exhausted
    await instance.start("owner", "fixture-token")
    await settle(instance)
    prior = copy.deepcopy(instance.store.rows["owner"])
    prior["attempted_combinations"] = [1, 2]
    prior["work"] = {"old_evidence": True}
    instance.store.rows["owner"] = copy.deepcopy(prior)
    assert (await instance.start("owner", "fixture-token"))["status"] == status
    assert offer.await_count == 1

    clock[0] += 60
    assert (await instance.start("owner", "fixture-token", refresh_completed=True))[
        "status"
    ] == "pending"
    fresh = instance.store.rows["owner"]
    assert fresh["job_id"] != prior["job_id"]
    assert fresh["attempted_combinations"] == [] and "work" not in fresh
    assert fresh["discovery_started_at"] == clock[0]
    assert fresh["starts"] == prior["starts"]
    # A second click while pending coalesces, including the refresh flag.
    assert (await instance.start("owner", "fixture-token", refresh_completed=True))[
        "status"
    ] == "pending"
    await settle(instance)
    assert offer.await_count == 2
    assert len(instance.store.rows["owner"]["starts"]) == 2
    instance.store.rows["owner"]["starts"].append(clock[0] - 1)
    refused = await instance.start("owner", "fixture-token", refresh_completed=True)
    assert refused["status"] == "unavailable" and refused["retry_after_s"] > 0
    assert offer.await_count == 2


async def test_single_failed_search_is_terminal_across_remount_and_cooldown():
    from hushh_mcp.one_adk.profile_research import run_profile_discovery

    now = 10_000
    searches = AsyncMock(side_effect=RuntimeError("fixture source unavailable"))

    async def offer(**kwargs):
        result = await run_profile_discovery(
            identity={
                "full_name": "Alex Example",
                "email": "alex@example.test",
                "phone_number": "+15555550123",
            },
            require_access=AsyncMock(),
            researcher=searches,
            **kwargs,
        )
        return {"pkm_written": False, **result}

    first = manager(offer=offer, clock=lambda: now)
    await first.start("owner", "fixture-token")
    await settle(first)
    assert searches.await_count == 1
    row = first.store.rows["owner"]
    assert row["attempted_combinations"] == [1]
    assert row["result"] == {
        "status": "unavailable",
        "pkm_written": False,
        "retry_exhausted": True,
        "attempts": 1,
    }
    now += jobs.FAILURE_COOLDOWN_SECONDS + jobs.LEASE_SECONDS + 1
    restored = manager(store=first.store, offer=offer, clock=lambda: now)
    assert await restored.status("owner", "fresh-fixture-token") == row["result"]
    assert await restored.start("owner", "fresh-fixture-token") == row["result"]
    assert searches.await_count == 1 and not restored.tasks


@pytest.mark.parametrize("crash_stage", ["before_admission", "after_wave_charge"])
async def test_expired_lease_keeps_charged_masks_and_never_replays_them(crash_stage):
    now = 10_000
    store = MemoryStore()
    initial = {
        "status": "pending",
        "started_at": now - jobs.LEASE_SECONDS - 1,
        "discovery_started_at": now - 600,
        "identity_binding": "owner-bound-identity",
        "starts": [now - 600],
        "attempted_combinations": [1],
    }
    if crash_stage == "before_admission":
        initial["resume_binding"] = initial["identity_binding"]
        initial["identity_binding"] = ""
    await store.write("owner", initial, None)
    seen = []

    async def offer(**kwargs):
        assert kwargs["attempts_used"] == (1,)
        with pytest.raises(ValueError):
            await kwargs["on_attempts_start"]((1,))
        with pytest.raises(ValueError):
            await kwargs["on_attempts_start"]((2,))
        return {
            "status": "unavailable",
            "pkm_written": False,
            "retry_exhausted": True,
            "attempts": 1,
        }

    instance = manager(store=store, offer=offer, clock=lambda: now)
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert seen == []
    assert store.rows["owner"]["attempted_combinations"] == [1]
    assert store.rows["owner"]["discovery_started_at"] == initial["discovery_started_at"]


async def test_lost_wave_charge_cas_stops_before_any_provider_dispatch():
    store = MemoryStore()
    dispatched = []

    async def offer(**kwargs):
        # A competing owner-authorized lease supersedes this worker.
        store.rows["owner"]["revision"] += 1
        with pytest.raises(PermissionError):
            await kwargs["on_attempts_start"]((1,))
        assert not dispatched
        return {"status": "disabled", "pkm_written": False}

    instance = manager(store=store, offer=offer)
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert store.rows["owner"]["status"] == "pending"
    assert store.rows["owner"]["attempted_combinations"] == []


@pytest.mark.parametrize("legacy_status", ["low_confidence", "unavailable"])
async def test_single_shot_policy_accepts_legacy_budget_without_replaying_old_masks(legacy_status):
    store = MemoryStore()
    await store.write(
        "owner",
        {
            "status": legacy_status,
            "started_at": 9_000,
            "finished_at": 9_100,
            "discovery_started_at": 9_000,
            "identity_binding": "old-seven-mask-policy",
            "starts": [9_000],
            "attempted_combinations": list(range(1, 8)),
            "result": {"status": "unavailable", "retry_exhausted": True, "attempts": 7},
        },
        None,
    )

    async def offer(**kwargs):
        assert kwargs["attempts_used"] == ()
        await kwargs["on_attempts_start"]((1,))
        return RESULT

    instance = manager(store=store, offer=offer, clock=lambda: 10_000)
    assert await instance.status("owner", "fixture-token") == jobs.pending(restart=True)
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert store.rows["owner"]["result"] == RESULT
    assert store.rows["owner"]["attempted_combinations"] == [1]
    assert store.rows["owner"]["starts"] == [9_000, 10_000]


@pytest.mark.asyncio
async def test_research_policy_change_refreshes_draft_without_resetting_paid_budget(monkeypatch):
    monkeypatch.setattr(jobs, "owner_setup_resolved", AsyncMock(return_value=True))
    monkeypatch.setattr(
        jobs,
        "lookup_fresh_owner_identity",
        lambda owner: SimpleNamespace(uid=owner, disabled=False),
    )
    monkeypatch.setattr(jobs, "magic_intelligence_owner_admitted", lambda *args: True)
    monkeypatch.setattr(jobs, "magic_intelligence_saved", AsyncMock(return_value=False))
    monkeypatch.setattr(
        jobs, "resolve_profile_research_identity", AsyncMock(return_value={"full_name": "Example"})
    )
    policy = ["policy-v1"]
    monkeypatch.setattr(jobs, "profile_research_policy_fingerprint", lambda: policy[0])
    instance = manager(check=jobs.admission)
    holder = RequestChatKey(os.urandom(32))
    holder.bind_owner("owner")
    with bind_request_chat_key(holder):
        await instance.start("owner", "fixture-token")
        await settle(instance)
        assert await instance.start("owner", "fixture-token") == RESULT
        assert instance.offer.await_count == 1
        for revision in (2, 3):
            policy[0] = f"policy-v{revision}"
            assert await instance.status("owner", "fixture-token") == jobs.pending(restart=True)
            # A read does not charge or restart the model. A fresh start does.
            assert instance.offer.await_count == revision - 1
            await instance.start("owner", "fixture-token")
            await settle(instance)
            assert await instance.status("owner", "fixture-token") == RESULT
            assert len(instance.store.rows["owner"]["starts"]) == revision
        policy[0] = "policy-v4"
        assert (await instance.start("owner", "fixture-token"))["status"] == "unavailable"
        assert instance.offer.await_count == 3


@pytest.mark.asyncio
async def test_new_owner_cannot_read_old_owner_job():
    async def offer(**kwargs):
        return {**RESULT, "report": {**RESULT["report"], "name": kwargs["user_id"]}}

    instance = manager(offer=AsyncMock(side_effect=offer))
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert await instance.status("other", "fixture-token") == jobs.pending(restart=True)
    await instance.start("other", "other-fixture-token")
    await settle(instance)
    # Identical pipeline, independent durable drafts and per-owner budgets.
    for owner in ("owner", "other"):
        result = await instance.status(owner, "fresh-fixture-token")
        assert result["report"]["name"] == owner
        assert len(instance.store.rows[owner]["starts"]) == 1
    assert instance.offer.await_count == 2


@pytest.mark.asyncio
async def test_crashed_lease_resumes_only_on_fresh_start_and_fences_old_worker():
    now = [1000.0]
    gate = asyncio.Event()

    async def old_offer(**kwargs):
        await gate.wait()
        return RESULT

    first = manager(offer=AsyncMock(side_effect=old_offer), clock=lambda: now[0])
    await first.start("owner", "fixture-token")
    await asyncio.sleep(0)
    now[0] += jobs.LEASE_SECONDS + 1
    successor = manager(store=first.store, clock=lambda: now[0])
    assert await successor.status("owner", "fresh-fixture-token") == jobs.pending(restart=True)
    successor.offer.assert_not_awaited()
    await successor.start("owner", "fresh-fixture-token")
    await settle(successor)
    sealed_successor = copy.deepcopy(first.store.rows["owner"])
    gate.set()
    await settle(first)
    assert first.store.rows["owner"] == sealed_successor


@pytest.mark.asyncio
async def test_provider_failure_is_not_no_match_and_paid_runs_are_bounded(caplog):
    now = [1000.0]
    instance = manager(
        offer=AsyncMock(side_effect=ValueError("private-provider-text")), clock=lambda: now[0]
    )
    for _ in range(3):
        assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
        await settle(instance)
        assert (await instance.status("owner", "fixture-token"))["status"] == "pending"
        now[0] += jobs.FAILURE_COOLDOWN_SECONDS + 1
    assert (await instance.start("owner", "fixture-token"))["status"] == "unavailable"
    assert "private-provider-text" not in caplog.text
    assert "fixture-token" not in caplog.text
    assert "cause_origin=" in caplog.text
    assert instance.offer.await_count == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("refused", ["not_ready", "disabled", "saved"])
async def test_admission_refusals_are_terminal_and_do_not_charge_research(refused):
    instance = manager(
        check=AsyncMock(return_value=({"status": refused, "pkm_written": False}, ""))
    )
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert (await instance.status("owner", "fixture-token"))["status"] == refused
    assert instance.store.rows["owner"]["starts"] == []
    instance.offer.assert_not_awaited()


@pytest.mark.asyncio
async def test_retained_key_survives_request_until_checkpoint_then_is_released():
    gate = asyncio.Event()
    holder = RequestChatKey(os.urandom(32))
    holder.bind_owner("owner")

    async def offer(**kwargs):
        await gate.wait()
        return RESULT

    instance = manager(offer=AsyncMock(side_effect=offer))
    with bind_request_chat_key(holder):
        await instance.start("owner", "fixture-token")
    assert holder.bound
    gate.set()
    await settle(instance)
    assert not holder.bound


@pytest.mark.asyncio
async def test_shutdown_before_first_tick_releases_key_and_leaves_recoverable_lease():
    holder = RequestChatKey(os.urandom(32))
    holder.bind_owner("owner")
    instance = manager()
    with bind_request_chat_key(holder):
        await instance.start("owner", "fixture-token")
        await instance.shutdown()
    assert not holder.bound
    assert instance.active == 0
    assert instance.store.rows["owner"]["status"] == "pending"


@pytest.mark.asyncio
async def test_finite_job_budget_is_not_an_http_deadline(monkeypatch):
    monkeypatch.setattr(jobs, "JOB_SECONDS", 0.01)

    async def offer(**kwargs):
        await asyncio.Event().wait()

    instance = manager(offer=AsyncMock(side_effect=offer))
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    assert (await instance.status("owner", "fixture-token"))["status"] == "pending"


class FakeConnection:
    def __init__(self):
        self.rows = {}
        self.queries = []

    async def fetchrow(self, sql, *params, **kwargs):
        self.queries.append((sql, params))
        key = params[:3]
        row = self.rows.get(key)
        if sql.strip().startswith("SELECT"):
            return (
                copy.deepcopy(row)
                if row and row["payload_ciphertext"].startswith(params[3].removesuffix("%"))
                else None
            )
        if sql.strip().startswith("INSERT"):
            if row:
                return None
            revision = 1
        else:
            if (
                not row
                or row["revision"] != params[7]
                or row["payload_ciphertext"] != params[8]
                or not row["payload_ciphertext"].startswith(params[9].removesuffix("%"))
            ):
                return None
            revision = row["revision"] + 1
        self.rows[key] = dict(
            zip(
                ("payload_ciphertext", "payload_iv", "payload_tag", "payload_algorithm"),
                params[3:7],
                strict=True,
            )
        )
        self.rows[key]["revision"] = revision
        return {"revision": revision}

    async def execute(self, sql, *params, **kwargs):
        self.queries.append((sql, params))


class FakePool:
    def __init__(self):
        self.conn = FakeConnection()

    def acquire(self, **kwargs):
        return self

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args):
        pass


@pytest.mark.asyncio
async def test_real_store_ciphertext_cas_reload_wrong_key_and_namespace_retention():
    from hushh_mcp.one_adk.encrypted_session_service import EncryptedSessionCheckpointStore

    pool = FakePool()
    store = jobs.ProfileResearchJobStore(pool_provider=AsyncMock(return_value=pool))
    holder = RequestChatKey(os.urandom(32))
    holder.bind_owner("owner")
    state = {"status": "offered", "result": RESULT, "finished_at": 10}
    with bind_request_chat_key(holder):
        receipt = await store.write("owner", state, None)
        assert receipt
        stored = next(iter(pool.conn.rows.values()))
        # Migration 249 keeps these marked person-key rows across deployment.
        assert stored["payload_ciphertext"].startswith(CHAT_CIPHERTEXT_PREFIX)
        assert "Example Person" not in str(stored)
        assert "fixture-token" not in str(stored)
        assert (await store.get("owner"))["result"] == RESULT
        assert await store.get("other") is None
        # A copied row cannot become another owner's checkpoint.
        pool.conn.rows[(jobs.NAMESPACE, "other", jobs.SESSION)] = copy.deepcopy(stored)
        with pytest.raises(PermissionError):
            await store.get("other")
        # The same owner's key cannot open a ciphertext copied to another app.
        other_store = EncryptedSessionCheckpointStore(
            app_name="one.other.checkpoint.v1",
            session_id=jobs.SESSION,
            pool_provider=AsyncMock(return_value=pool),
        )
        pool.conn.rows[(other_store.app_name, "owner", jobs.SESSION)] = copy.deepcopy(stored)
        with pytest.raises(PermissionError):
            await other_store.get("owner")
        # Deletion/recreation at revision1 cannot admit an old generation.
        pool.conn.rows.clear()
        replacement = await store.write("owner", state, None)
        assert replacement["revision"] == receipt["revision"]
        assert await store.write("owner", state, receipt) is None
        await store.purge_expired()
        sql, params = pool.conn.queries[-1]
        assert params == (jobs.NAMESPACE, jobs.SESSION, CHAT_CIPHERTEXT_PREFIX + "%")
        assert "24 hours" in sql and "LIMIT 500" in sql
        assert "app_name=$1 AND session_id=$2 AND payload_ciphertext LIKE $3" in sql
        assert "AND payload_ciphertext LIKE $3\n" in sql
        # Legacy rows remain invisible and cannot be resealed or overwritten.
        legacy = {**stored, "payload_ciphertext": "legacy-platform-key-row", "revision": 1}
        pool.conn.rows[(jobs.NAMESPACE, "owner", jobs.SESSION)] = legacy
        assert await store.get("owner") is None
        assert await store.write("owner", state, None) is None
        assert (
            await store.write(
                "owner", state, {"revision": 1, "fence": legacy["payload_ciphertext"]}
            )
            is None
        )
        assert pool.conn.rows[(jobs.NAMESPACE, "owner", jobs.SESSION)] == legacy
        pool.conn.rows[(jobs.NAMESPACE, "owner", jobs.SESSION)] = stored
    wrong = RequestChatKey(os.urandom(32))
    wrong.bind_owner("owner")
    with bind_request_chat_key(wrong), pytest.raises(PermissionError):
        await store.get("owner")


@pytest.mark.parametrize("method", ["post", "get"])
def test_job_routes_are_private_and_owner_only(monkeypatch, method):
    from api.routes.one import profile_research as route

    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[route.require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture-token",
    }
    operation = AsyncMock(return_value=jobs.pending())
    monkeypatch.setattr(
        route.profile_research_jobs, "start" if method == "post" else "status", operation
    )
    response = getattr(TestClient(app), method)("/api/one/profile-research/jobs?user_id=other")
    assert response.status_code == 202
    assert "no-store" in response.headers["cache-control"]
    operation.assert_awaited_once_with("owner", "fixture-token")


def pwm_manager(monkeypatch, **kwargs):
    from hushh_mcp.services import world_model_service as pwm

    monkeypatch.setattr(pwm, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    return pwm.WorldModelJobs(
        store=kwargs.pop("store", MemoryStore()),
        offer=kwargs.pop("offer", AsyncMock(return_value=RESULT)),
        check=kwargs.pop("check", AsyncMock(return_value=(None, "owner-bound-identity"))),
        max_attempts=52,
        stored_attempts=52,
        review_ids=True,
        preserve_budget_on_identity_change=True,
        **kwargs,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["start", "status"])
async def test_pwm_discard_while_admission_waits_never_releases_cached_draft(
    monkeypatch, operation
):
    instance = pwm_manager(monkeypatch)
    await instance.start("owner", "token")
    await settle(instance)
    draft_id = instance.store.rows["owner"]["job_id"]
    entered, release = asyncio.Event(), asyncio.Event()

    async def check(*args):
        entered.set()
        await release.wait()
        return None, "owner-bound-identity"

    instance.check = check
    poll = asyncio.create_task(getattr(instance, operation)("owner", "token"))
    await entered.wait()
    await instance.dismiss("owner", "token", draft_id)
    release.set()
    assert "report" not in await poll
    assert "report" not in instance.store.rows["owner"]["result"]


@pytest.mark.asyncio
async def test_pwm_old_completion_cannot_discard_new_draft(monkeypatch):
    instance = pwm_manager(monkeypatch)
    await instance.start("owner", "token")
    await settle(instance)
    old = instance.store.rows["owner"]["job_id"]
    await instance.dismiss("owner", "token", old)
    await instance.start("owner", "token")
    await settle(instance)
    with pytest.raises(RuntimeError, match="Draft changed"):
        await instance.dismiss("owner", "token", old)
    assert instance.store.rows["owner"]["status"] == "offered"
    assert instance.store.rows["owner"]["result"]["draft_id"] != old


@pytest.mark.asyncio
async def test_pwm_identity_edit_preserves_durable_search_and_model_charges(monkeypatch):
    used = []

    async def research(**kwargs):
        used.append(kwargs["attempts_used"])
        if not used[0] and len(used) == 1:
            await kwargs["on_attempts_start"]((1, 33))
        return RESULT

    instance = pwm_manager(monkeypatch, offer=research)
    await instance.start("owner", "token")
    await settle(instance)
    instance.check = AsyncMock(return_value=(None, "changed-owner-name"))
    await instance.start("owner", "token")
    await settle(instance)
    assert used == [(), (1, 33)]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["start", "status", "pending_status"])
async def test_revoked_owner_during_final_checkpoint_read_is_denied(monkeypatch, operation):
    from hushh_mcp.services import world_model_service as pwm

    instance = pwm_manager(monkeypatch)
    await instance.start("owner", "token")
    await settle(instance)
    if operation == "pending_status":
        instance.store.rows["owner"]["status"] = "pending"
        instance.store.rows["owner"]["result"] = {"status": "pending", "pkm_written": False}
    original = instance.store.get
    reads = 0

    async def read(owner):
        nonlocal reads
        reads += 1
        result = await original(owner)
        if reads == (3 if operation == "pending_status" else 2):
            jobs.validate_first_party_owner_token.return_value = None
            pwm.validate_first_party_owner_token.return_value = None
        return result

    instance.store.get = read
    with pytest.raises(PermissionError):
        await getattr(instance, "status" if operation == "pending_status" else operation)(
            "owner", "token"
        )


@pytest.mark.asyncio
async def test_pwm_resume_keeps_budget_and_new_consent_clears_evidence(monkeypatch):
    import copy

    from hushh_mcp.services import world_model_service as pwm

    generation = {"id": "00000000-0000-4000-8000-000000000001"}
    monkeypatch.setattr(
        pwm,
        "preferences",
        AsyncMock(
            side_effect=lambda *a, **k: {
                "enabled": True,
                "generation": generation["id"],
                "auto_started_at": None,
            }
        ),
    )
    observed = []

    async def check(*args):
        return None, generation["id"]

    async def research(**kwargs):
        observed.append((kwargs["attempts_used"], copy.deepcopy(kwargs["work"])))
        if not kwargs["attempts_used"]:
            await kwargs["on_attempts_start"]((1, 33))
        await kwargs["on_progress"]({"evidence": "synthetic owner evidence"})
        return {"status": "paused", "pkm_written": False, "restart_required": True}

    instance = pwm_manager(monkeypatch, progressive=True, offer=research, check=check)
    await instance.start("owner", "fixture-token")
    await settle(instance)
    original = instance.store.rows["owner"]["job_id"]
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert instance.store.rows["owner"]["job_id"] == original
    generation["id"] = "00000000-0000-4000-8000-000000000002"
    await instance.start("owner", "fixture-token")
    await settle(instance)
    assert instance.store.rows["owner"]["job_id"] != original
    assert observed == [
        ((), {}),
        ((1, 33), {"evidence": "synthetic owner evidence"}),
        ((1, 33), {}),
    ]


@pytest.mark.asyncio
async def test_owner_decision_inputs_are_sealed_carried_and_never_change_reuse(monkeypatch):
    seen = []

    async def research(**kwargs):
        seen.append(kwargs.get("inputs"))
        if len(seen) == 1:
            return {"status": "paused", "pkm_written": False, "restart_required": True}
        return RESULT

    instance = pwm_manager(monkeypatch, progressive=True, offer=research)
    decisions = {"owner_decisions": {"confirmed": [], "rejected": ["Likes the color blue."]}}
    await instance.start("owner", "token", inputs=decisions)
    await settle(instance)
    draft_id = instance.store.rows["owner"]["job_id"]
    assert instance.store.rows["owner"]["inputs"] == decisions
    # A resume without new inputs keeps the owner's decisions for the model.
    await instance.start("owner", "token")
    await settle(instance)
    assert instance.store.rows["owner"]["job_id"] == draft_id
    assert seen == [decisions, decisions]
    # New decisions never invalidate a reusable draft or buy another run.
    changed = {"owner_decisions": {"confirmed": [], "rejected": ["Lives in Paris."]}}
    assert await instance.start("owner", "token", inputs=changed) == {
        **RESULT,
        "draft_id": draft_id,
    }
    assert len(seen) == 2
    # Legacy Magic research without inputs keeps its exact call and state shape.
    legacy = manager()
    await legacy.start("owner", "fixture-token")
    await settle(legacy)
    assert "inputs" not in legacy.offer.await_args.kwargs
    assert "inputs" not in legacy.store.rows["owner"]


@pytest.mark.asyncio
async def test_public_profile_scope_carries_coalesces_and_refreshes_without_reusing_work(
    monkeypatch,
):
    from hushh_mcp.services import world_model_service as pwm

    monkeypatch.setitem(pwm.POLICY, "provider", "azure_openai_web_search")
    monkeypatch.setattr(pwm, "azure_bing_consented", lambda _: True)
    seen = []
    gate = asyncio.Event()

    async def research(**kwargs):
        seen.append(copy.deepcopy(kwargs))
        if len(seen) == 1:
            await kwargs["on_attempts_start"]((1, 33))
            await kwargs["on_progress"]({"evidence": "prior profile"})
            await gate.wait()
            return {"status": "paused", "pkm_written": False, "restart_required": True}
        return RESULT

    instance = pwm_manager(monkeypatch, progressive=True, offer=research)
    profiles = {
        "urls": ["https://example.test/me", "https://github.com/example"],
        "permitted_public_sources": True,
    }
    await instance.start(
        "owner", "token", inputs={"public_profiles": profiles}, refresh_completed=True
    )
    await asyncio.sleep(0)
    original = instance.store.rows["owner"]["job_id"]
    reordered = {**profiles, "urls": list(reversed(profiles["urls"]))}
    assert (
        await instance.start(
            "owner", "token", inputs={"public_profiles": reordered}, refresh_completed=True
        )
        == jobs.pending()
    )
    changed = {**profiles, "urls": ["https://example.test/another"]}
    with pytest.raises(pwm.PublicProfilesChanged):
        await instance.start(
            "owner", "token", inputs={"public_profiles": changed}, refresh_completed=True
        )
    assert instance.store.rows["owner"]["job_id"] == original
    gate.set()
    await settle(instance)
    decisions = {"owner_decisions": {"confirmed": [], "rejected": ["Not me."]}}
    await instance.start("owner", "token", inputs=decisions)
    await settle(instance)
    assert seen[1]["inputs"] == {**decisions, "public_profiles": profiles}
    assert seen[1]["work"] == {"evidence": "prior profile"}
    assert instance.store.rows["owner"]["job_id"] == original
    with pytest.raises(pwm.PublicProfilesChanged):
        await instance.start("owner", "token", inputs={"public_profiles": changed})
    prior_starts = instance.store.rows["owner"]["starts"]
    await instance.start(
        "owner", "token", inputs={"public_profiles": changed}, refresh_completed=True
    )
    await settle(instance)
    state = instance.store.rows["owner"]
    assert state["job_id"] != original
    assert state["starts"][:-1] == prior_starts
    assert seen[-1]["work"] == {} and seen[-1]["attempts_used"] == ()
    assert seen[-1]["inputs"] == {**decisions, "public_profiles": changed}
    # A changed profile never bypasses the owner-wide hourly paid-start limit.
    state["starts"] = [instance.clock()] * 3
    third = {**profiles, "urls": ["https://example.test/third"]}
    count = len(seen)
    refused = await instance.start(
        "owner", "token", inputs={"public_profiles": third}, refresh_completed=True
    )
    assert refused["status"] == "unavailable" and refused["retry_after_s"] > 0
    assert len(seen) == count


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", ["missing", "opted_out", "setup_pending"])
async def test_ensure_enrolls_default_research_but_never_overrides_opt_out(monkeypatch, existing):
    from hushh_mcp.services import world_model_service as pwm

    rows = {}
    if existing == "opted_out":
        rows["owner"] = {
            "enabled": False,
            "email_enabled": False,
            "generation": "00000000-0000-4000-8000-000000000001",
            "auto_started_at": None,
        }

    async def read(user_id, **kwargs):
        return copy.deepcopy(rows.get(user_id))

    async def enroll(user_id, token):
        rows.setdefault(
            user_id,
            {
                "enabled": True,
                "email_enabled": True,
                "generation": "00000000-0000-4000-8000-000000000002",
                "auto_started_at": None,
            },
        )

    enroll_default = AsyncMock(side_effect=enroll)
    monkeypatch.setattr(pwm, "preferences", read)
    monkeypatch.setattr(pwm, "enroll_default", enroll_default)
    monkeypatch.setattr(
        pwm, "owner_setup_resolved", AsyncMock(return_value=existing != "setup_pending")
    )
    monkeypatch.setattr(
        pwm,
        "owner_identity",
        AsyncMock(return_value={"full_name": "Example", "email": "a@example.test"}),
    )
    monkeypatch.setattr(pwm, "one_profile_research_enabled", lambda: True)
    monkeypatch.setattr(
        pwm, "get_chat_key_provider", lambda: SimpleNamespace(current_key=lambda _: b"k" * 32)
    )
    instance = pwm_manager(monkeypatch)
    result = await instance.ensure("owner", "token")
    await settle(instance)
    if existing == "missing":
        assert result["status"] == "pending"
        enroll_default.assert_awaited_once_with("owner", "token")
        assert rows["owner"]["enabled"] and rows["owner"]["email_enabled"]
        instance.offer.assert_awaited_once()
        return
    # Negative control: an explicit opt-out stays off, and nothing is enrolled
    # before setup resolves. No research state is written either way.
    assert result == {"status": "consent_required", "pkm_written": False}
    enroll_default.assert_not_awaited()
    assert rows.get("owner", {}).get("enabled") in (None, False)
    assert instance.store.rows == {}
    instance.offer.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "age_days,active_draft,completed,unpurged,expected",
    [
        (2, None, False, False, "saved"),
        (8, None, False, False, "pending"),
        # The purge removed a run that never finished: it is prepared again now.
        (2, "00000000-0000-4000-8000-0000000000d1", False, False, "pending"),
        # A finished draft that aged out waits for the re-preparation interval.
        (2, "00000000-0000-4000-8000-0000000000d1", True, False, "saved"),
        # Past retention but not purged yet: same rule, no new paid run.
        (2, "00000000-0000-4000-8000-0000000000d1", True, True, "saved"),
    ],
)
async def test_ensure_prepares_again_after_checkpoint_purge_once_last_run_is_old(
    monkeypatch, age_days, active_draft, completed, unpurged, expected
):
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.services import world_model_service as pwm

    now = datetime(2026, 10, 15, tzinfo=UTC)
    monkeypatch.setattr(
        pwm,
        "preferences",
        AsyncMock(
            return_value={
                "enabled": True,
                "email_enabled": True,
                "generation": "00000000-0000-4000-8000-000000000001",
                "auto_started_at": now - timedelta(days=age_days),
                "active_draft_id": active_draft,
            }
        ),
    )
    finished = AsyncMock(return_value=completed)
    monkeypatch.setattr(pwm, "draft_completed", finished)
    monkeypatch.setattr(pwm, "admission", AsyncMock(return_value=(None, "owner-bound-identity")))
    instance = pwm_manager(monkeypatch, clock=now.timestamp)
    if unpurged:
        instance.store.rows["owner"] = {
            "job_id": active_draft,
            "status": "offered",
            "started_at": now.timestamp() - 25 * 3600,
            "finished_at": now.timestamp() - 25 * 3600,
            "consent_generation": "00000000-0000-4000-8000-000000000001",
            "identity_binding": "owner-bound-identity",
            "result": RESULT,
        }
    # No live checkpoint; the last run's age and outcome decide.
    assert (await instance.ensure("owner", "token"))["status"] == expected
    await settle(instance)
    assert instance.offer.await_count == (1 if expected == "pending" else 0)
    if active_draft is not None:
        finished.assert_awaited_once_with("owner", active_draft)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["saved", "offered"])
@pytest.mark.parametrize("changed_binding", [False, True])
async def test_ensure_reuses_completed_state_only_for_current_identity_policy(
    monkeypatch, status, changed_binding
):
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.services import world_model_service as pwm

    now = datetime(2026, 10, 20, tzinfo=UTC)
    current = "new-owner-policy" if changed_binding else "owner-bound-identity"
    monkeypatch.setattr(pwm, "admission", AsyncMock(return_value=(None, current)))
    monkeypatch.setattr(
        pwm,
        "preferences",
        AsyncMock(
            return_value={
                "enabled": True,
                "generation": "00000000-0000-4000-8000-000000000001",
                "auto_started_at": now - timedelta(days=2),
                "active_draft_id": None,
            }
        ),
    )
    instance = pwm_manager(
        monkeypatch, clock=now.timestamp, check=AsyncMock(return_value=(None, current))
    )
    await instance.store.write(
        "owner",
        {
            "job_id": "00000000-0000-4000-8000-0000000000d1",
            "status": status,
            "identity_binding": "owner-bound-identity",
            "consent_generation": "00000000-0000-4000-8000-000000000001",
            "started_at": now.timestamp() - 60,
            "finished_at": now.timestamp() - jobs.TTL_SECONDS - 1,
            "starts": [now.timestamp() - 60],
            "attempted_combinations": [1],
            "budget_scope": instance.budget_scope(),
            "result": {"status": "saved", "pkm_written": False} if status == "saved" else RESULT,
        },
        None,
    )
    result = await instance.ensure("owner", "token")
    assert result["status"] == ("pending" if changed_binding else "saved")
    await settle(instance)
    assert instance.offer.await_count == int(changed_binding)
    if changed_binding:
        assert instance.offer.call_args.kwargs["attempts_used"] == (1,)
        assert instance.store.rows["owner"]["starts"] == [now.timestamp() - 60, now.timestamp()]


class ProviderDenied(Exception):
    """Shape of google.genai ClientError: numeric code and status enum."""

    code = 403
    status = "PERMISSION_DENIED"


class ProviderThrottled(Exception):
    code = 429
    status = "RESOURCE_EXHAUSTED"


def openai_rate_limit_error():
    return RateLimitError(
        "private provider detail",
        response=httpx.Response(
            429,
            request=httpx.Request("POST", "https://example.test/openai/v1/responses"),
        ),
        body={"code": "rate_limit_exceeded"},
    )


@pytest.mark.parametrize(
    ("error_type", "status_code"),
    [(AuthenticationError, 401), (PermissionDeniedError, 403)],
)
def test_openai_auth_refusals_use_http_status_code(error_type, status_code):
    error = error_type(
        "private provider detail",
        response=httpx.Response(
            status_code,
            request=httpx.Request("POST", "https://example.test/openai/v1/responses"),
        ),
        body={"code": "provider_refusal"},
    )
    code, status = jobs.provider_error(error)
    assert (code, status) == (status_code, None)
    assert jobs.provider_rejected(code, status)


def test_application_http_error_is_not_a_provider_refusal():
    assert jobs.provider_error(HTTPException(status_code=403)) == (None, None)


class TurnFailed(RuntimeError):
    pass


def failing_provider_research(calls, cause=ProviderDenied):
    async def research(**kwargs):
        calls.append(kwargs["attempts_used"])
        await kwargs["on_attempts_start"]((33 + len(calls),))
        try:
            raise cause("private provider text for alex@example.test")
        except cause as failure:
            raise TurnFailed("turn failed") from failure

    return research


def paused_with_evidence(now):
    return {
        "job_id": "00000000-0000-4000-8000-0000000000aa",
        "status": "paused",
        "started_at": now - 300,
        "finished_at": now - 30,
        "identity_binding": "owner-bound-identity",
        "starts": [now - 300],
        "attempted_combinations": [1, 33],
        "discovery_started_at": now - 300,
        "work": {"attempts": {"1": {"state": "received"}}},
        "consent_generation": "00000000-0000-4000-8000-000000000001",
        "result": {"status": "paused", "pkm_written": False, "restart_required": True},
        "revision": 1,
        "fence": "seed",
    }


@pytest.mark.asyncio
async def test_pwm_repeated_429_waits_then_resumes_saved_work_without_new_hourly_starts(
    monkeypatch,
):
    now = [10_000.0]
    calls = []
    instance = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research(calls, cause=ProviderThrottled),
        clock=lambda: now[0],
    )
    instance.store.rows["owner"] = paused_with_evidence(now[0])
    original_job = instance.store.rows["owner"]["job_id"]
    for failure in range(3):
        assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
        await settle(instance)
        row = instance.store.rows["owner"]
        assert row["status"] == "unavailable"
        assert row["result"]["reason"] == "provider_throttled"
        assert row["job_id"] == original_job
        assert row["work"] == {"attempts": {"1": {"state": "received"}}}
        assert row["starts"] == [10_000.0 - 300]
        assert row["attempted_combinations"][:2] == [1, 33]
        assert len(row["attempted_combinations"]) == 3 + failure
        assert (await instance.start("owner", "fixture-token"))["retry_after_s"] == 900
        assert len(calls) == failure + 1
        now[0] += jobs.PROVIDER_THROTTLE_COOLDOWN_SECONDS + 1
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_pwm_429_before_first_checkpoint_reuses_paid_start_without_work(monkeypatch):
    now = [10_000.0]
    calls = []
    instance = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research(calls, cause=ProviderThrottled),
        clock=lambda: now[0],
    )
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    first = instance.store.rows["owner"]
    assert first["starts"] == [now[0]] and "work" not in first
    now[0] += jobs.PROVIDER_THROTTLE_COOLDOWN_SECONDS + 1
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    second = instance.store.rows["owner"]
    assert second["starts"] == [10_000.0]
    assert second["job_id"] == first["job_id"]
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_pwm_openai_rate_limit_uses_throttle_cooldown_and_reuses_paid_start(monkeypatch):
    now = [10_000.0]
    calls = []

    async def research(**kwargs):
        calls.append(kwargs["attempts_used"])
        await kwargs["on_attempts_start"]((33 + len(calls),))
        raise openai_rate_limit_error()

    instance = pwm_manager(monkeypatch, progressive=True, offer=research, clock=lambda: now[0])
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    first = instance.store.rows["owner"]
    assert first["result"]["reason"] == "provider_throttled"
    assert first["starts"] == [now[0]]
    assert (await instance.start("owner", "fixture-token"))["retry_after_s"] == 900
    assert len(calls) == 1

    now[0] += jobs.PROVIDER_THROTTLE_COOLDOWN_SECONDS + 1
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    second = instance.store.rows["owner"]
    assert second["job_id"] == first["job_id"]
    assert second["starts"] == [10_000.0]
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_pwm_first_openai_429_with_unknown_bing_spend_is_terminal_for_the_day(monkeypatch):
    calls = []

    async def research(**kwargs):
        calls.append(kwargs["attempts_used"])
        await kwargs["on_attempts_start"]((1,))
        await kwargs["on_progress"](
            {
                "azure_work_version": 1,
                "sources": {},
                "attempts": {"1": {"state": "started", "observed": False}},
            }
        )
        await kwargs["on_attempts_start"]((33,))
        raise openai_rate_limit_error()

    instance = pwm_manager(monkeypatch, progressive=True, offer=research, clock=lambda: 10_000.0)
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    row = instance.store.rows["owner"]
    assert row["attempted_combinations"] == [1, 33]
    assert row["work"]["attempts"]["1"] == {"state": "started", "observed": False}
    assert row["result"] == {
        "status": "unavailable",
        "pkm_written": False,
        "reason": "provider_throttled",
        "research_exhausted": True,
        "draft_id": row["job_id"],
    }
    assert await instance.start("owner", "fixture-token") == row["result"]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_pwm_legacy_429_checkpoint_reports_terminal_without_another_paid_call(monkeypatch):
    calls = []

    async def research(**kwargs):
        calls.append(kwargs["attempts_used"])
        await kwargs["on_attempts_start"]((1,))
        await kwargs["on_progress"](
            {
                "azure_work_version": 1,
                "sources": {},
                "attempts": {"1": {"state": "started", "observed": False}},
            }
        )
        await kwargs["on_attempts_start"]((33,))
        raise RuntimeError("synthetic old provider failure")

    instance = pwm_manager(monkeypatch, progressive=True, offer=research, clock=lambda: 10_000.0)
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    legacy = instance.store.rows["owner"]
    assert legacy["result"] == {
        "status": "unavailable",
        "pkm_written": False,
        "draft_id": legacy["job_id"],
    }
    expected = {**legacy["result"], "research_exhausted": True}
    status = await instance.status("owner", "fixture-token")
    assert {key: status[key] for key in expected} == expected
    assert status["validated_facts"] == []
    assert await instance.start("owner", "fixture-token") == expected
    assert instance.store.rows["owner"] == legacy
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_pwm_failed_retries_with_saved_evidence_spend_the_hourly_start_budget(
    monkeypatch, caplog
):
    # UAT: one search had been saved, then every run failed. Saved evidence
    # exempted every retry from the 3-an-hour start budget, so a run was bought
    # every cooldown for hours. (A provider refusal returns its start instead:
    # see the refund test below.)
    caplog.set_level("INFO")
    now = [10_000.0]
    calls = []
    instance = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research(calls, cause=RuntimeError),
        clock=lambda: now[0],
    )
    instance.store.rows["owner"] = paused_with_evidence(now[0])
    # Continuing the paused slice is free and keeps the draft.
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    row = instance.store.rows["owner"]
    assert row["status"] == "unavailable"
    assert row["job_id"] == "00000000-0000-4000-8000-0000000000aa"
    assert row["starts"] == [now[0] - 300]
    results = []
    for _ in range(3):
        now[0] += jobs.FAILURE_COOLDOWN_SECONDS + 10
        results.append(await instance.start("owner", "fixture-token"))
        await settle(instance)
    assert len(calls) == 3
    # The refusal says when the oldest counted start ages out of the hour.
    assert results[2] == {"status": "unavailable", "pkm_written": False, "retry_after_s": 3090}
    assert len(instance.store.rows["owner"]["starts"]) == 3
    assert "provider_code=None provider_status=None provider_rejected=False" in caplog.text
    assert "one.pwm_decision op=start decision=budget_starts" in caplog.text
    # Match the event and flag, not the full line: the CI worker's log
    # formatting of the job id differs from a local run.
    started = [r.getMessage() for r in caplog.records if "pwm_started" in r.getMessage()]
    assert any("resumed=True" in message for message in started), started
    for private in ("alex@example.test", "private provider text", "fixture-token"):
        assert private not in caplog.text


@pytest.mark.asyncio
async def test_hourly_start_budget_refusal_says_when_a_start_is_accepted_again():
    # Three starts in the hour: the refusal is not persisted, so it is the only
    # place the owner can learn the wait. It ends when the oldest start ages out.
    now = [10_000.0]
    offer = AsyncMock(return_value=RESULT)
    instance = manager(offer=offer, clock=lambda: now[0])
    spent = {
        "job_id": "00000000-0000-4000-8000-0000000000bb",
        "status": "unavailable",
        "started_at": now[0] - 500,
        "finished_at": now[0] - 500,
        "identity_binding": "owner-bound-identity",
        "starts": [now[0] - 3000, now[0] - 2000, now[0] - 1000],
        "attempted_combinations": [],
        "result": {"status": "unavailable", "pkm_written": False},
        "revision": 1,
        "fence": "seed",
    }
    instance.store.rows["owner"] = copy.deepcopy(spent)
    assert await instance.start("owner", "fixture-token") == {
        "status": "unavailable",
        "pkm_written": False,
        "retry_after_s": 600,
    }
    offer.assert_not_awaited()
    assert instance.store.rows["owner"] == spent
    # Never zero: a start that ages out this very second is still counted.
    now[0] += 599.5
    assert (await instance.start("owner", "fixture-token"))["retry_after_s"] == 1
    # Once it is out of the hour, a start is accepted and bought.
    now[0] += 1
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    assert len(instance.store.rows["owner"]["starts"]) == 3
    assert instance.store.rows["owner"]["starts"][0] == spent["starts"][1]


@pytest.mark.asyncio
async def test_provider_rejected_runs_return_their_start_so_an_outage_never_locks_the_owner_out(
    monkeypatch, caplog
):
    # UAT: a project-wide 403 failed every run before inference, and each one
    # still bought an hourly start. Once billing was restored the owner was
    # refused for the rest of the hour. A refused run bought nothing: the start
    # goes back, the 15-minute cooldown stays. Any other failure keeps its start.
    now = [10_000.0]
    calls = []
    instance = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research(calls),
        clock=lambda: now[0],
    )
    for _ in range(3):
        assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
        await settle(instance)
        row = instance.store.rows["owner"]
        assert row["status"] == "unavailable"
        assert row["result"]["reason"] == "provider_unavailable"
        assert row["starts"] == []
        now[0] += jobs.PROVIDER_FAILURE_COOLDOWN_SECONDS + 10
    assert len(calls) == 3
    assert "provider_code=403 provider_status=PERMISSION_DENIED provider_rejected=True" in (
        caplog.text
    )
    # The provider is back: the budget is intact and a fourth run is accepted.
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    assert len(calls) == 4
    assert "decision=budget_starts" not in caplog.text
    # A failure of our own, not the provider's refusal, still spends a start.
    other = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research([], cause=RuntimeError),
        clock=lambda: now[0],
    )
    assert (await other.start("owner", "fixture-token"))["status"] == "pending"
    await settle(other)
    assert other.store.rows["owner"]["starts"] == [now[0]]
    for private in ("alex@example.test", "private provider text", "fixture-token"):
        assert private not in caplog.text


@pytest.mark.asyncio
async def test_pwm_failure_is_reported_not_masked_as_pending_restart(monkeypatch):
    # UAT: GET /jobs answered a failed run with pending, then restart_required,
    # so every open client restarted research after each cooldown, forever.
    now = [10_000.0]
    calls = []
    instance = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research(calls),
        clock=lambda: now[0],
    )
    await instance.start("owner", "fixture-token")
    await settle(instance)
    draft_id = instance.store.rows["owner"]["job_id"]
    failed = {
        "status": "unavailable",
        "pkm_written": False,
        "reason": "provider_unavailable",
        "draft_id": draft_id,
    }
    cooling = {**failed, "retry_after_s": jobs.PROVIDER_FAILURE_COOLDOWN_SECONDS}
    observed = await instance.status("owner", "fixture-token")
    assert {key: observed[key] for key in cooling} == cooling
    assert observed["validated_facts"] == [] and "progress" in observed
    # A second client inside the cooldown is told the outcome, not pending.
    assert await instance.start("owner", "fixture-token") == cooling
    now[0] += jobs.PROVIDER_FAILURE_COOLDOWN_SECONDS + 1
    observed = await instance.status("owner", "fixture-token")
    assert {key: observed[key] for key in failed} == failed
    assert observed["validated_facts"] == [] and "progress" in observed
    assert len(calls) == 1
    # A fresh owner request after the cooldown may still retry.
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_provider_breaker_refuses_every_owner_without_a_run_until_the_window_passes(
    monkeypatch, caplog
):
    # UAT: a project-wide 403 failed every owner's run in under a second, and
    # each failed run still bought a model slot and a paid start.
    import logging

    now = [10_000.0]
    calls = []
    instance = pwm_manager(
        monkeypatch,
        progressive=True,
        offer=failing_provider_research(calls),
        clock=lambda: now[0],
    )
    for owner in ("owner-a", "owner-b", "owner-c"):
        assert (await instance.start(owner, "fixture-token"))["status"] == "pending"
        await settle(instance)
        now[0] += 60
    assert len(calls) == 3
    refused = {
        "status": "unavailable",
        "pkm_written": False,
        "reason": "provider_unavailable",
        "retry_after_s": jobs.PROVIDER_BREAKER_SECONDS - 180,
    }
    assert await instance.start("owner-d", "fixture-token") == refused
    # Process-wide: the legacy discovery manager shares the same breaker.
    legacy = manager(clock=lambda: now[0])
    assert await legacy.start("owner-e", "fixture-token") == refused
    assert "owner-d" not in instance.store.rows and not instance.tasks
    legacy.offer.assert_not_awaited()
    breaker = [
        record
        for record in caplog.records
        if "decision=provider_breaker" in record.getMessage() and record.levelno == logging.WARNING
    ]
    assert len(breaker) == 2
    now[0] += jobs.PROVIDER_BREAKER_SECONDS - 180
    assert (await instance.start("owner-d", "fixture-token"))["status"] == "pending"
    await settle(instance)
    assert len(calls) == 4
    for private in ("alex@example.test", "private provider text", "fixture-token"):
        assert private not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("rejected", [True, False])
async def test_provider_rejection_before_inference_refunds_only_that_runs_last_charge(
    monkeypatch, rejected
):
    now = 10_000.0

    async def research(**kwargs):
        await kwargs["on_attempts_start"]((2,))
        await kwargs["on_attempts_start"]((34,))
        if rejected:
            raise TurnFailed("turn failed") from ProviderDenied("private provider text")
        raise TurnFailed("turn failed") from RuntimeError("private provider text")

    instance = pwm_manager(monkeypatch, progressive=True, offer=research, clock=lambda: now)
    instance.store.rows["owner"] = paused_with_evidence(now)
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    row = instance.store.rows["owner"]
    assert row["status"] == "unavailable"
    # Earlier charges of this run and of past runs stay paid; only the model
    # slot the provider refused before inference is returned.
    assert row["attempted_combinations"] == ([1, 33, 2] if rejected else [1, 33, 2, 34])
    assert row["result"].get("reason") == ("provider_unavailable" if rejected else None)


@pytest.mark.asyncio
@pytest.mark.parametrize("rejected", [True, False])
async def test_failure_cooldown_is_fifteen_minutes_for_provider_refusals(monkeypatch, rejected):
    now = [10_000.0]
    calls = []
    offer = (
        failing_provider_research(calls)
        if rejected
        else AsyncMock(side_effect=RuntimeError("private provider text"))
    )
    instance = pwm_manager(monkeypatch, progressive=True, offer=offer, clock=lambda: now[0])
    await instance.start("owner", "fixture-token")
    await settle(instance)
    cooldown = jobs.PROVIDER_FAILURE_COOLDOWN_SECONDS if rejected else jobs.FAILURE_COOLDOWN_SECONDS
    now[0] += 30
    for operation in (instance.status, instance.start):
        result = await operation("owner", "fixture-token")
        assert result["status"] == "unavailable"
        assert result["retry_after_s"] == cooldown - 30
        assert result.get("reason") == ("provider_unavailable" if rejected else None)
    before = copy.deepcopy(instance.store.rows["owner"])
    explicit = await instance.start("owner", "fixture-token", refresh_completed=True)
    assert explicit["status"] == "unavailable"
    assert explicit["retry_after_s"] == cooldown - 30
    assert instance.store.rows["owner"] == before
    assert instance.offer.await_count == 1 if not rejected else len(calls) == 1
    now[0] += cooldown - 30
    assert (await instance.start("owner", "fixture-token"))["status"] == "pending"
    await settle(instance)
    assert instance.offer.await_count == 2 if not rejected else len(calls) == 2


@pytest.mark.asyncio
async def test_search_attempt_records_wall_clock_time_at_start_and_completion(monkeypatch):
    import copy
    import json

    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    import hushh_mcp.runtime_providers as providers
    from hushh_mcp.one_adk import world_model as pwm

    plan = {
        "purpose": "identity",
        "seed_fields": ["full_name", "email"],
        "anchor_ids": [],
        "candidate_id": None,
        "topics": ["career"],
        "question": "Find the supplied owner's public work.",
    }
    responses = [
        LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name="search_public_web", args={"plan_json": json.dumps(plan)}
                        )
                    )
                ],
            )
        ),
        LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="Builds software.")]),
            grounding_metadata=types.GroundingMetadata(
                web_search_queries=["Alex Example"],
                grounding_chunks=[{"web": {"title": "Bio", "uri": "https://example.test/alex"}}],
            ),
        ),
    ]

    class FakeModel(BaseLlm):
        model: str = "gemini-3.6-flash"

        async def generate_content_async(self, llm_request, stream=False):
            if not responses:
                raise pwm.ResearchSliceComplete()
            yield responses.pop(0)

    monkeypatch.setattr(
        providers, "build_managed_regional_gemini_adk_model", lambda *_: FakeModel()
    )
    snapshots = []

    async def progress(value):
        snapshots.append(copy.deepcopy(value))

    before = time.time()
    result = await pwm.run_world_model(
        identity={"full_name": "Alex Example", "email": "alex@example.test", "phone_number": None},
        user_id="owner",
        consent_token="fixture",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=AsyncMock(),
        on_progress=progress,
    )
    assert result["status"] == "paused"
    # The search's start is activity too: a long first answer must not read as idle.
    started = next(
        s["attempts"]["1"] for s in snapshots if s["attempts"]["1"]["state"] == "started"
    )
    assert isinstance(started["at"], float) and before <= started["at"] <= time.time()
    attempt = snapshots[-1]["attempts"]["1"]
    assert attempt["state"] == "received"
    assert isinstance(attempt["at"], float) and started["at"] <= attempt["at"] <= time.time()
