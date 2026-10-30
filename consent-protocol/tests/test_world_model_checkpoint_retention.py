"""Retained owner research, consent, lineage and paid-budget regression contracts."""

import copy
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import profile_research_jobs as jobs
from hushh_mcp.services.chat_key import RequestChatKey, bind_request_chat_key
from hushh_mcp.services.world_model_checkpoints import carry_legacy_starts
from tests.fixtures.profile_research_jobs import RESULT, pwm_manager, settle
from tests.fixtures.profile_research_jobs import authority as authority
from tests.fixtures.profile_research_store import FakePool, MemoryStore


@asynccontextmanager
async def value_scope(value):
    yield value


@pytest.mark.asyncio
async def test_storage_permitted_checkpoint_survives_aging_restart_and_keeps_legacy_cleanup(
    monkeypatch,
):
    from hushh_mcp.one_adk.encrypted_session_service import EncryptedSessionCheckpointStore
    from hushh_mcp.services import world_model_service as pwm

    pool = FakePool()
    durable = EncryptedSessionCheckpointStore(
        app_name=pwm.NAMESPACE,
        session_id="tavily-profile-v1",
        durable=True,
        pool_provider=AsyncMock(return_value=pool),
    )
    legacy = EncryptedSessionCheckpointStore(
        app_name=pwm.NAMESPACE, session_id="profile", pool_provider=AsyncMock(return_value=pool)
    )
    key = RequestChatKey(os.urandom(32))
    key.bind_owner("owner")
    with bind_request_chat_key(key):
        assert await durable.write("owner", {"status": "offered", "result": RESULT}, None)
        before = len(pool.conn.queries)
        await durable.purge_expired()
        assert len(pool.conn.queries) == before
        assert (await durable.get("owner"))["result"] == RESULT
        assert await legacy.get("owner") is None
        # Copying a retained result into the legacy AAD cannot expose it there.
        pool.conn.rows[(pwm.NAMESPACE, "owner", "profile")] = copy.deepcopy(
            pool.conn.rows[(pwm.NAMESPACE, "owner", "tavily-profile-v1")]
        )
        with pytest.raises(PermissionError):
            await legacy.get("owner")
    instance = pwm_manager(monkeypatch, clock=lambda: 10 * jobs.TTL_SECONDS)
    instance.store.durable = True
    aged = {"status": "offered", "finished_at": 1, "result": RESULT}
    assert instance.reusable(aged)
    assert not jobs.ProfileResearchJobs(clock=instance.clock).reusable(aged)
    instance.legacy_store = legacy
    instance.store.purge_expired = AsyncMock()
    await instance.purge_expired()
    assert "24 hours" in pool.conn.queries[-1][0]


@pytest.mark.asyncio
@pytest.mark.parametrize("durable", [False, True])
async def test_aged_pwm_continuation_retains_work_and_charged_slots_together(monkeypatch, durable):
    now = 10 * jobs.TTL_SECONDS
    store = MemoryStore()
    store.durable = durable
    instance = pwm_manager(monkeypatch, store=store, progressive=True, clock=lambda: now)
    old = now - 2 * jobs.TTL_SECONDS
    await store.write(
        "owner",
        {
            "job_id": "retained-generation",
            "status": "paused",
            "started_at": old,
            "finished_at": old,
            "discovery_started_at": old,
            "identity_binding": "owner-bound-identity",
            "starts": [],
            "attempted_combinations": [1, 33],
            "consent_generation": "00000000-0000-4000-8000-000000000001",
            "budget_scope": instance.budget_scope(),
            "work": {"evidence": "received checkpoint"},
            "result": {"status": "paused", "pkm_written": False, "restart_required": True},
        },
        None,
    )
    await instance.start("owner", "fixture-token")
    await settle(instance)
    args = instance.offer.await_args.kwargs
    assert args["attempts_used"] == ((1, 33) if durable else ())
    assert args["work"] == ({"evidence": "received checkpoint"} if durable else {})
    assert (store.rows["owner"]["job_id"] == "retained-generation") is durable
    # A new manager sees the retained offered report without another provider call.
    restarted = pwm_manager(
        monkeypatch, store=store, progressive=True, clock=lambda: now + 2 * jobs.TTL_SECONDS
    )
    result = await restarted.start("owner", "fresh-fixture-token")
    await settle(restarted)
    assert result["status"] == ("offered" if durable else "pending")
    assert restarted.offer.await_count == (0 if durable else 1)
    refused = {"status": "consent_required", "pkm_written": False}
    restarted.check = AsyncMock(return_value=(refused, ""))
    assert await restarted.status("owner", "fresh-fixture-token") == refused


@pytest.mark.asyncio
async def test_search_dependency_refusal_keeps_already_billed_query_model_slot(monkeypatch):
    from hushh_mcp.one_adk.tavily_search import TavilyUnavailable

    async def research(**kwargs):
        await kwargs["on_attempts_start"]((1,))
        await kwargs["on_attempts_start"]((33,))
        await kwargs["on_progress"]({"usage_records": {"33": {"input_tokens": 20}}})
        raise TavilyUnavailable(403)

    instance = pwm_manager(monkeypatch, progressive=True, offer=research, clock=lambda: 10000)
    await instance.start("owner", "fixture-token")
    await settle(instance)
    state = instance.store.rows["owner"]
    assert state["status"] == "unavailable"
    assert state["attempted_combinations"] == [1, 33]
    assert state["starts"] == [10000]
    assert state["work"]["usage_records"]["33"]["input_tokens"] == 20


@pytest.mark.asyncio
async def test_tavily_rollout_projects_only_starts_through_real_commit_consent_fence(monkeypatch):
    from contextlib import asynccontextmanager

    from hushh_mcp.one_adk.encrypted_session_service import EncryptedSessionCheckpointStore
    from hushh_mcp.services.world_model_preferences import checkpoint_committed

    pool = FakePool()
    generation = "00000000-0000-4000-8000-000000000001"
    fetchrow = pool.conn.fetchrow

    async def read(sql, *args, **kwargs):
        if "FROM pwm_research_preferences" in sql:
            return {"enabled": True, "generation": generation}
        return await fetchrow(sql, *args, **kwargs)

    @asynccontextmanager
    async def transaction():
        yield

    pool.conn.fetchrow = read
    pool.conn.transaction = transaction
    store = EncryptedSessionCheckpointStore(
        app_name="one.personal_world_model.v1",
        session_id="tavily-profile-v1",
        durable=True,
        pool_provider=AsyncMock(return_value=pool),
        on_commit=checkpoint_committed,
    )
    legacy = MemoryStore()
    await legacy.write(
        "owner",
        {
            "job_id": "00000000-0000-4000-8000-0000000000d1",
            "starts": [9990],
            "work": {"bing_notes": "must not migrate"},
            "result": RESULT,
        },
        None,
    )
    instance = pwm_manager(monkeypatch, store=store, legacy_store=legacy, clock=lambda: 10000)
    holder = RequestChatKey(os.urandom(32))
    holder.bind_owner("owner")
    with bind_request_chat_key(holder):
        await carry_legacy_starts(
            "owner",
            AsyncMock(),
            store=store,
            legacy_store=legacy,
            context_factory=lambda: instance.job_context("owner", "fixture-token"),
            clock=instance.clock,
        )
        state = await store.get("owner")
    assert state["consent_generation"] == generation
    assert state["starts"] == [9990] and state["attempted_combinations"] == []
    assert state["job_id"] != legacy.rows["owner"]["job_id"]
    assert "work" not in state and "report" not in state["result"]
    assert state["status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome,completed", [("ready", True), ("partial", True), ("attention", False), (None, False)]
)
async def test_failed_or_empty_completion_does_not_block_research_for_a_week(
    monkeypatch, outcome, completed
):
    from hushh_mcp.services import world_model_preferences as preferences

    connection = SimpleNamespace(fetchval=AsyncMock(return_value=outcome))
    pool = SimpleNamespace(acquire=lambda **_: value_scope(connection))
    monkeypatch.setattr(preferences, "get_pool", AsyncMock(return_value=pool))
    assert await preferences.draft_completed("owner", "draft") is completed
    assert connection.fetchval.await_args.args[1:] == ("owner", "draft")
