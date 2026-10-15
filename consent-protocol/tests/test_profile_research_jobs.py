"""Discovery outlives HTTP, not authority; checkpoints are not owner Memory."""

import asyncio
import copy
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hushh_mcp.services import profile_research_jobs as jobs
from hushh_mcp.services.chat_key import (
    CHAT_CIPHERTEXT_PREFIX,
    RequestChatKey,
    bind_request_chat_key,
)
from tests.fixtures.profile_research_store import FakePool, MemoryStore

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


@pytest.fixture(autouse=True)
def authority(monkeypatch):
    from hushh_mcp.services import owner_placement_guard

    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value="shared")
    )
    monkeypatch.setattr(jobs, "admit_hub_content", AsyncMock())
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
@pytest.mark.parametrize("change_during_identity", [False, True])
async def test_cached_draft_cannot_cross_private_placement(monkeypatch, change_during_identity):
    from fastapi import HTTPException

    private = False

    async def placement(*args):
        if private:
            raise HTTPException(409, "Use your private agent")

    async def identity(*args):
        nonlocal private
        if change_during_identity:
            private = True
        return {"full_name": "Example"}

    monkeypatch.setattr(jobs, "admit_hub_content", placement)
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
    monkeypatch.setattr(jobs, "profile_research_policy_fingerprint", lambda: "test-policy")
    instance = manager(check=jobs.admission)
    holder = RequestChatKey(os.urandom(32))
    holder.bind_owner("owner")
    with bind_request_chat_key(holder):
        await instance.start("owner", "fixture-token")
        await settle(instance)
        assert await instance.status("owner", "fixture-token") == RESULT
        if change_during_identity:
            monkeypatch.setattr(jobs, "resolve_profile_research_identity", identity)
        else:
            private = True
        with pytest.raises(HTTPException) as error:
            await instance.status("owner", "fixture-token")
        assert error.value.status_code == 409
        assert instance.offer.await_count == 1


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
    app.dependency_overrides[route.hub_content_chat_owner] = lambda: {
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
@pytest.mark.parametrize("operation", ["start", "status"])
async def test_revoked_owner_during_final_checkpoint_read_is_denied(monkeypatch, operation):
    instance = pwm_manager(monkeypatch)
    await instance.start("owner", "token")
    await settle(instance)
    original = instance.store.get
    reads = 0

    async def read(owner):
        nonlocal reads
        reads += 1
        result = await original(owner)
        if reads == 2:
            jobs.validate_first_party_owner_token.return_value = None
        return result

    instance.store.get = read
    with pytest.raises(PermissionError):
        await getattr(instance, operation)("owner", "token")


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["start", "status"])
@pytest.mark.parametrize("transition", ["shared", "private", "during_read"])
async def test_pwm_checkpoint_admission_and_release(monkeypatch, operation, transition):
    from fastapi import HTTPException

    from hushh_mcp.services import owner_placement_guard as placement

    instance = pwm_manager(monkeypatch)
    await instance.start("owner", "token")
    await settle(instance)
    original = instance.store.get
    reads = 0

    async def read(owner):
        nonlocal reads
        reads += 1
        result = await original(owner)
        if transition == "during_read" and reads == 2:
            placement.get_owner_hosting_mode.return_value = "byoc"
        return result

    instance.store.get = read
    if transition == "private":
        placement.get_owner_hosting_mode.return_value = "byoc"
    if transition == "shared":
        assert "report" in await getattr(instance, operation)("owner", "token")
    else:
        with pytest.raises(HTTPException) as error:
            await getattr(instance, operation)("owner", "token")
        assert error.value.status_code == 409
        assert reads == (0 if transition == "private" else 2)
    assert instance.offer.await_count == 1


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
@pytest.mark.parametrize("existing", ["missing", "opted_out", "setup_pending", "private"])
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
    owner_decisions = {"confirmed": ["Synthetic owner declaration"], "rejected": []}
    if existing == "private":
        from fastapi import HTTPException

        from hushh_mcp.services import owner_placement_guard as placement

        placement.get_owner_hosting_mode.return_value = "byoc"
        with pytest.raises(HTTPException) as error:
            await instance.ensure("owner", "token", owner_decisions=owner_decisions)
        assert error.value.status_code == 409
        enroll_default.assert_not_awaited()
        instance.offer.assert_not_awaited()
        return
    result = await instance.ensure("owner", "token", owner_decisions=owner_decisions)
    await settle(instance)
    if existing == "missing":
        assert result["status"] == "pending"
        enroll_default.assert_awaited_once_with("owner", "token")
        assert rows["owner"]["enabled"] and rows["owner"]["email_enabled"]
        instance.offer.assert_awaited_once()
        assert instance.offer.await_args.kwargs["inputs"] == {"owner_decisions": owner_decisions}
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
            "result": RESULT,
        }
    # No live checkpoint; the last run's age and outcome decide.
    assert (await instance.ensure("owner", "token"))["status"] == expected
    await settle(instance)
    assert instance.offer.await_count == (1 if expected == "pending" else 0)
    if active_draft is not None:
        finished.assert_awaited_once_with("owner", active_draft)
