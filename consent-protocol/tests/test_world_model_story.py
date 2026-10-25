"""The owner's Personal World Model story, end to end on the job manager.

Opening the pane ensures research; every checkpoint the worker seals shows up
in GET /jobs as progress whose counts grow and that never carries owner text;
the live stream turns those reads into frames; the finished draft is offered
and announced to the Feed as ready. The research itself is a scripted fake.
"""

import asyncio
import copy
import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api.routes.one.world_model_stream import progress_events
from hushh_mcp.services import profile_research_jobs as jobs
from hushh_mcp.services import world_model_preferences as preferences_module
from hushh_mcp.services import world_model_service as pwm
from hushh_mcp.services.world_model_preferences import checkpoint_committed
from tests.test_profile_research_jobs import MemoryStore

GENERATION = "00000000-0000-4000-8000-000000000001"
IDENTITY = {
    "full_name": "Alex Example",
    "email": "alex@example.test",
    "phone_number": "+15550001111",
}
# Everything in a checkpoint that is the owner's, or about them: never in progress.
PRIVATE = ("Alex", "alex@example.test", "+15550001111", "publishes", "studied", "Exact public")
PROGRESS_KEYS = {
    "stage",
    "searches_used",
    "searches_total",
    "model_calls_used",
    "model_calls_total",
    "topics_checked",
    "sources_found",
    "recent_sources",
    "identity_state",
    "candidates",
    "started_at",
    "last_activity_at",
    "slice",
}
BIO = {"title": "Bio", "url": "https://example.test/alex"}
ALUMNI = {"title": "Alumni", "url": "https://example.test/alumni"}
PLAN = {
    "purpose": "identity",
    "seed_fields": ["full_name", "email"],
    "anchor_ids": [],
    "candidate_id": None,
    "topics": ["career"],
    "question": "Find the supplied owner's public work.",
}
OFFERED = {
    "status": "offered",
    "pkm_written": False,
    "report": {
        "match_status": "matched",
        "name": "Alex Example",
        "summary": "Public work",
        "sections": [
            {
                "kind": "career",
                "facts": [
                    {"statement": "Builds software.", "confidence": "supported", "sources": [BIO]}
                ],
            }
        ],
    },
    "search_suggestions": [],
}


def iso(epoch):
    return datetime.fromtimestamp(epoch, tz=UTC).isoformat().replace("+00:00", "Z")


def identity_checkpoint(at):
    """After the first search: one receipt, identity still open."""
    return {
        "attempts": {
            "1": {
                "plan": copy.deepcopy(PLAN),
                "observed": True,
                "answer": "Alex Example publishes alex@example.test and +15550001111.",
                "source_refs": ["s1"],
                "state": "received",
                "at": at,
            }
        },
        "sources": {"s1": BIO},
        "search_suggestions": [],
    }


def coverage_checkpoint(at):
    """After the second search: the owner is linked, a second topic covered."""
    work = identity_checkpoint(at - 30)
    work["attempts"]["2"] = {
        "plan": {
            **copy.deepcopy(PLAN),
            "purpose": "coverage",
            "candidate_id": "c1",
            "topics": ["career", "education"],
        },
        "observed": True,
        "answer": "Alex Example studied at Example Uni.",
        "source_refs": ["s2"],
        "state": "received",
        "at": at,
    }
    work["sources"]["s2"] = ALUMNI
    work["assessment"] = {
        "candidates": [
            {"id": "c1", "label": "Alex Example", "anchor_ids": ["a1"], "blocking_conflicts": []}
        ],
        "anchors": [
            {
                "id": "a1",
                "candidate_id": "c1",
                "kind": "verified_contact",
                "seed_field": "email",
                "assertion": "Publishes the supplied contact.",
                "source_refs": ["s1"],
                "temporal_context": "Current public bio",
            }
        ],
        "identity": {
            "state": "owner_linked",
            "reason": "Exact public contact matches",
            "probability": None,
            "selected_candidate_id": "c1",
            "supporting_anchor_ids": ["a1"],
            "next_step": "finish",
        },
    }
    return work


class ScriptedResearch:
    """Research in three gated phases, so the test can read status between checkpoints."""

    def __init__(self, clock):
        self.clock = clock
        self.batch = None
        self.result = OFFERED
        self.entered = asyncio.Event()
        self.proceed = [asyncio.Event() for _ in range(3)]
        self.reached = [asyncio.Event() for _ in range(3)]

    async def __call__(self, **kwargs):
        self.entered.set()
        await self.proceed[0].wait()
        await kwargs["on_attempts_start"]((1, pwm.MAX_SEARCHES + 1))
        await kwargs["on_progress"](identity_checkpoint(self.clock()))
        self.reached[0].set()
        await self.proceed[1].wait()
        await kwargs["on_attempts_start"]((pwm.MAX_SEARCHES + 2, 2, pwm.MAX_SEARCHES + 3))
        work = coverage_checkpoint(self.clock())
        if self.batch:
            work["finding_batches"] = [self.batch]
        await kwargs["on_progress"](work)
        self.reached[1].set()
        await self.proceed[2].wait()
        self.reached[2].set()
        return self.result


class CommittingStore(MemoryStore):
    """The in-memory store plus the real commit hook, as the encrypted store runs it."""

    def __init__(self, conn):
        super().__init__()
        self.conn = conn

    async def write(self, owner, state, expected):
        receipt = await super().write(owner, state, expected)
        if receipt is not None:
            await checkpoint_committed(self.conn, owner, state)
        return receipt


async def settle(instance):
    if instance.tasks:
        await asyncio.gather(*list(instance.tasks))


@pytest.fixture
def story(monkeypatch, active_account_lifecycle):
    """One owner, consented and admitted; a scripted researcher behind the real manager."""
    now = [10_000.0]

    def consent_row():
        return {
            "enabled": True,
            "generation": uuid.UUID(GENERATION),
            "auto_started_at": None,
            "consent_version": preferences_module.AZURE_BING_CONSENT_VERSION
            if pwm.POLICY["provider"] == "azure_openai_web_search"
            else preferences_module.NATIVE_CONSENT_VERSION,
        }

    monkeypatch.setattr(preferences_module, "load_pwm_policy", lambda: pwm.POLICY)
    monkeypatch.setattr(
        pwm,
        "preferences",
        AsyncMock(side_effect=lambda *_args: consent_row()),
    )
    monkeypatch.setattr(pwm, "admission", AsyncMock(return_value=(None, "owner-bound-identity")))
    monkeypatch.setattr(pwm, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    monkeypatch.setenv("HUSSH_POD_MODE", "0")
    monkeypatch.setattr(
        "hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode",
        AsyncMock(return_value="shared"),
    )
    monkeypatch.setattr(jobs, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    monkeypatch.setattr(jobs, "one_profile_research_enabled", lambda: True)
    monkeypatch.setattr(jobs, "provider_breaker", jobs.ProviderBreaker())
    conn = SimpleNamespace(
        fetchrow=AsyncMock(side_effect=lambda *_args, **_kwargs: consent_row()),
        execute=AsyncMock(),
    )
    research = ScriptedResearch(lambda: now[0])
    instance = pwm.WorldModelJobs(
        store=CommittingStore(conn),
        offer=research,
        check=AsyncMock(return_value=(None, "owner-bound-identity")),
        max_attempts=pwm.MAX_SEARCHES + pwm.MAX_MODEL_CALLS,
        stored_attempts=pwm.MAX_SEARCHES + pwm.MAX_MODEL_CALLS,
        job_seconds=pwm.POLICY["job_seconds"],
        lease_seconds=pwm.POLICY["lease_seconds"],
        preserve_budget_on_identity_change=True,
        review_ids=True,
        progressive=True,
        clock=lambda: now[0],
    )
    return SimpleNamespace(now=now, conn=conn, research=research, jobs=instance)


def assert_contract(progress):
    assert set(progress) == PROGRESS_KEYS
    assert progress["stage"] in {"starting", "identity", "coverage", "report"}
    assert progress["searches_total"] == pwm.MAX_SEARCHES
    assert progress["model_calls_total"] == pwm.MAX_MODEL_CALLS
    assert 0 <= progress["searches_used"] <= progress["searches_total"]
    assert 0 <= progress["model_calls_used"] <= progress["model_calls_total"]
    assert len(progress["topics_checked"]) <= 20
    assert len(progress["recent_sources"]) <= 5
    assert all(set(row) == {"title", "url"} for row in progress["recent_sources"])
    assert progress["identity_state"] in {
        None,
        "owner_linked",
        "candidate_for_review",
        "ambiguous",
        "no_match",
    }
    assert progress["candidates"] >= 0 and progress["slice"] >= 1
    serialized = json.dumps(progress)
    for private in PRIVATE:
        assert private not in serialized


def use_azure_budget(story, monkeypatch):
    monkeypatch.setattr(pwm, "POLICY", {**pwm.POLICY, "provider": "azure_openai_web_search"})
    story.jobs.search_slots = 8
    story.jobs.max_attempts = 24
    story.jobs.stored_attempts = 24


@pytest.mark.asyncio
async def test_pending_before_worker_admission_does_not_request_a_restart(story):
    instance = story.jobs
    instance.store.rows["owner"] = {
        "status": "pending",
        "identity_binding": "",
        "started_at": story.now[0],
        "revision": 1,
        "fence": "seed",
        "work": {"sources": {"s1": BIO}},
    }
    assert await instance.status("owner", "fixture-token") == jobs.pending()
    instance.check.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_story_ensure_reports_growing_progress_then_offers_the_draft(story):
    instance, research, now = story.jobs, story.research, story.now
    # Opening the pane: research starts on its own, with nothing to show yet.
    assert await instance.ensure("owner", "fixture-token") == jobs.pending()
    await research.entered.wait()
    draft_id = instance.store.rows["owner"]["job_id"]
    before = await instance.status("owner", "fixture-token")
    assert before["status"] == "pending" and before["restart_required"] is False
    assert_contract(before["progress"])
    assert before["progress"]["stage"] == "starting"
    # The first run is part 1: the ledger already counts the start in flight.
    assert before["progress"]["slice"] == 1
    assert before["progress"]["started_at"] == iso(now[0])
    assert before["progress"]["last_activity_at"] == iso(now[0])

    now[0] += 30
    research.proceed[0].set()
    await research.reached[0].wait()
    identity = (await instance.status("owner", "fixture-token"))["progress"]
    assert_contract(identity)
    assert identity["stage"] == "identity"
    assert identity["identity_state"] is None and identity["candidates"] == 0
    assert identity["topics_checked"] == ["career"]
    assert identity["recent_sources"] == [BIO]
    assert identity["last_activity_at"] == iso(now[0])

    now[0] += 30
    research.proceed[1].set()
    await research.reached[1].wait()
    coverage = (await instance.status("owner", "fixture-token"))["progress"]
    assert_contract(coverage)
    assert coverage["stage"] == "coverage"
    assert coverage["identity_state"] == "owner_linked" and coverage["candidates"] == 1
    assert coverage["topics_checked"] == ["career", "education"]
    assert coverage["recent_sources"] == [BIO, ALUMNI]
    assert coverage["last_activity_at"] == iso(now[0])
    # Checkpoint by checkpoint, the counters only grow.
    for key in ("searches_used", "model_calls_used", "sources_found"):
        assert before["progress"][key] < identity[key] < coverage[key], key
    assert (coverage["searches_used"], coverage["model_calls_used"]) == (2, 3)

    research.proceed[2].set()
    await settle(instance)
    final = await instance.status("owner", "fixture-token")
    assert final == {**OFFERED, "draft_id": draft_id}
    assert "progress" not in final
    # The Feed outcome row the notification worker delivers: ready, not attention.
    sql, owner, announced, generation, outcome, email_state = story.conn.execute.call_args.args[:6]
    assert "pwm_completion_events" in sql
    assert (owner, announced, generation) == ("owner", uuid.UUID(draft_id), uuid.UUID(GENERATION))
    assert (outcome, email_state) == ("ready", "pending")


@pytest.mark.asyncio
async def test_owner_story_stream_frames_follow_the_checkpoints_then_close(story):
    instance, research, now = story.jobs, story.research, story.now
    assert (await instance.ensure("owner", "fixture-token"))["status"] == "pending"
    await research.entered.wait()
    phases = iter(range(3))

    async def sleep(_seconds):
        # Each poll interval lets research reach its next checkpoint.
        phase = next(phases)
        now[0] += 30
        research.proceed[phase].set()
        if phase < 2:
            await research.reached[phase].wait()
        else:
            await settle(instance)

    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    frames = [
        frame
        async for frame in progress_events(
            instance, "owner", "fixture-token", request, poll_seconds=0.0, sleep=sleep
        )
    ]
    assert [frame["event"] for frame in frames] == ["progress", "progress", "progress", "result"]
    progress = [json.loads(frame["data"]) for frame in frames[:3]]
    for value in progress:
        assert_contract(value)
    assert [value["stage"] for value in progress] == ["starting", "identity", "coverage"]
    assert [value["searches_used"] for value in progress] == [0, 1, 2]
    assert [value["sources_found"] for value in progress] == [0, 1, 2]
    result = json.loads(frames[3]["data"])
    assert result == await instance.status("owner", "fixture-token")
    assert result["status"] == "offered"


@pytest.mark.asyncio
async def test_owner_can_read_cited_partial_batch_after_failure_but_changed_binding_cannot(
    story, monkeypatch
):
    instance, research = story.jobs, story.research
    research.batch = {
        "candidate_id": "c1",
        "attempt_id": 2,
        "topic": "education",
        "facts": [
            {
                "statement": "Studied at Example Uni.",
                "confidence": "supported",
                "sources": [{"title": "Alumni", "ref": "s2"}],
            }
        ],
    }
    research.result = {"status": "unavailable", "pkm_written": False}
    assert (await instance.ensure("owner", "fixture-token"))["status"] == "pending"
    await research.entered.wait()
    research.proceed[0].set()
    await research.reached[0].wait()
    research.proceed[1].set()
    await research.reached[1].wait()
    live = await instance.status("owner", "fixture-token")
    assert live["status"] == "pending"
    assert live["validated_facts"][0]["sources"] == [ALUMNI]
    assert live["validated_facts"][0]["statement"] == "Studied at Example Uni."
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    frames = [
        frame
        async for frame in progress_events(
            instance, "owner", "fixture-token", request, initial=live, lifetime_seconds=0
        )
    ]
    assert [frame["event"] for frame in frames] == ["progress", "partial", "result"]
    assert json.loads(frames[1]["data"])["validated_facts"] == live["validated_facts"]
    research.proceed[2].set()
    await settle(instance)
    vertex_failed = await instance.status("owner", "fixture-token")
    assert vertex_failed["status"] == "unavailable"
    assert vertex_failed["validated_facts"] == live["validated_facts"]
    use_azure_budget(story, monkeypatch)
    state = instance.store.rows["owner"]
    state["work"].update(
        azure_work_version=1,
        usage_records={
            str(pwm.MAX_SEARCHES + 1): {
                "input_tokens": 120,
                "output_tokens": 35,
                "cached_input_tokens": 20,
                "elapsed_ms": 1000,
            }
        },
    )
    failed = await instance.status("owner", "fixture-token")
    assert failed["status"] == "unavailable"
    # The Azure display contract cannot retain a prior coverage citation which
    # is not owned by the current selected candidate's anchors. Vertex above
    # keeps its existing coverage contract; provider rebinding must revoke it.
    assert failed["validated_facts"] == []
    assert failed["progress"]["topics_checked"] == ["career", "education"]
    from hushh_mcp.one_adk.world_model_usage import public_result

    body, usage = public_result(failed)
    assert "_provider_usage" not in body
    assert "research" not in body  # failed bodies retain the existing strict shape
    assert usage["recorded_calls"] == 1
    assert usage["model_calls"] == 3
    assert usage["input_tokens"] is None  # two charged calls have no SDK receipt
    assert usage["bing_requests"] is None
    instance.check.return_value = (None, "changed-owner-binding")
    denied = await instance.status("owner", "fixture-token")
    assert denied == jobs.pending(restart=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("with_work", [False, True])
async def test_legacy_vertex_budget_starts_fresh_azure_job_without_losing_hourly_starts(
    story, monkeypatch, with_work
):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import world_model as routes

    use_azure_budget(story, monkeypatch)
    instance, now = story.jobs, story.now[0]
    old_job = str(uuid.uuid4())
    old_start = now - 120
    instance.store.rows["owner"] = {
        "job_id": old_job,
        "status": "unavailable",
        "started_at": old_start,
        "finished_at": now - 70,
        "discovery_started_at": old_start,
        "identity_binding": "legacy-vertex-binding",
        "starts": [old_start],
        "attempted_combinations": [*range(1, 6), *range(33, 66)],
        "consent_generation": GENERATION,
        "result": {"status": "unavailable", "pkm_written": False},
        "revision": 1,
        "fence": "legacy",
        **({"work": {"attempts": {"1": {"observed": True}}}} if with_work else {}),
    }
    offer = AsyncMock(return_value={"status": "unavailable", "pkm_written": False})
    instance.offer = offer

    monkeypatch.setattr(routes, "world_model_jobs", instance)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture-token",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/one/world-model/ensure")
        assert response.status_code == 202
        assert response.json() == jobs.pending()
    await settle(instance)

    row = instance.store.rows["owner"]
    assert row["job_id"] != old_job
    assert row["budget_scope"] == instance.budget_scope()
    assert row["attempted_combinations"] == []
    assert row["starts"] == [old_start, now]
    assert "work" not in row
    assert offer.await_args.kwargs["attempts_used"] == ()
    assert offer.await_args.kwargs["work"] == {}


@pytest.mark.asyncio
async def test_legacy_vertex_migration_keeps_three_starts_per_hour_limit(story, monkeypatch):
    use_azure_budget(story, monkeypatch)
    instance, now = story.jobs, story.now[0]
    instance.store.rows["owner"] = {
        "job_id": str(uuid.uuid4()),
        "status": "unavailable",
        "started_at": now - 120,
        "finished_at": now - 70,
        "identity_binding": "legacy-vertex-binding",
        "starts": [now - 120, now - 90, now - 60],
        "attempted_combinations": [33],
        "consent_generation": GENERATION,
        "result": {"status": "unavailable", "pkm_written": False},
        "revision": 1,
        "fence": "legacy",
    }
    offer = instance.offer = AsyncMock(return_value=OFFERED)

    result = await instance.ensure("owner", "fixture-token")

    assert result["status"] == "unavailable"
    assert result["retry_after_s"] > 0
    offer.assert_not_awaited()
    assert instance.store.rows["owner"]["starts"] == [now - 120, now - 90, now - 60]


@pytest.mark.asyncio
async def test_azure_budget_scope_preserves_paid_slots_and_rejects_malformed_ledger(
    story, monkeypatch
):
    use_azure_budget(story, monkeypatch)
    instance, now = story.jobs, story.now[0]
    old_job = str(uuid.uuid4())
    row = {
        "job_id": old_job,
        "status": "unavailable",
        "started_at": now - 120,
        "finished_at": now - 70,
        "discovery_started_at": now - 120,
        "identity_binding": "owner-bound-identity",
        "starts": [now - 120],
        "attempted_combinations": [1, 9],
        "consent_generation": GENERATION,
        "work": {"azure_work_version": 1},
        "result": {"status": "unavailable", "pkm_written": False},
        "revision": 1,
        "fence": "azure",
    }
    instance.store.rows["owner"] = row
    offer = instance.offer = AsyncMock(return_value={"status": "unavailable", "pkm_written": False})

    assert await instance.ensure("owner", "fixture-token") == jobs.pending()
    await settle(instance)
    assert offer.await_args.kwargs["attempts_used"] == (1, 9)
    assert offer.await_args.kwargs["work"] == {"azure_work_version": 1}
    assert instance.store.rows["owner"]["job_id"] == old_job

    malformed = {**row, "budget_scope": instance.budget_scope(), "attempted_combinations": [33]}
    instance.store.rows["owner"] = malformed
    with pytest.raises(RuntimeError, match="Invalid discovery attempt budget"):
        await instance.ensure("owner", "fixture-token")

    instance.store.rows["owner"] = {
        **row,
        "budget_scope": "unknown-provider:v2:8:16",
        "attempted_combinations": [1, 9],
    }
    with pytest.raises(RuntimeError, match="Unsupported discovery budget scope"):
        await instance.ensure("owner", "fixture-token")

    instance.store.rows["owner"] = {**row, "work": {"azure_work_version": 2}}
    with pytest.raises(RuntimeError, match="Unsupported discovery work version"):
        await instance.ensure("owner", "fixture-token")


@pytest.mark.asyncio
async def test_azure_consent_change_keeps_paid_slots_but_clears_private_work(story, monkeypatch):
    use_azure_budget(story, monkeypatch)
    instance, now = story.jobs, story.now[0]
    instance.store.rows["owner"] = {
        "job_id": str(uuid.uuid4()),
        "status": "unavailable",
        "started_at": now - 120,
        "finished_at": now - 70,
        "discovery_started_at": now - 120,
        "identity_binding": "prior-consent-binding",
        "starts": [now - 120],
        "attempted_combinations": [1, 9],
        "budget_scope": instance.budget_scope(),
        "consent_generation": "00000000-0000-4000-8000-000000000002",
        "work": {"azure_work_version": 1, "sources": {"private": "old consent"}},
        "result": {"status": "unavailable", "pkm_written": False},
        "revision": 1,
        "fence": "azure",
    }
    offer = instance.offer = AsyncMock(return_value={"status": "unavailable", "pkm_written": False})

    assert await instance.ensure("owner", "fixture-token") == jobs.pending()
    await settle(instance)

    assert offer.await_args.kwargs["attempts_used"] == (1, 9)
    assert offer.await_args.kwargs["work"] == {}
    assert instance.store.rows["owner"]["starts"] == [now - 120, now]


@pytest.mark.asyncio
async def test_azure_checkpoint_cannot_be_reused_after_vertex_rollback(story, monkeypatch):
    monkeypatch.setattr(pwm, "POLICY", {**pwm.POLICY, "provider": "vertex_google_search"})
    instance, now = story.jobs, story.now[0]
    instance.search_slots = 32
    instance.max_attempts = 160
    instance.stored_attempts = 160
    old_start = now - 120
    instance.store.rows["owner"] = {
        "job_id": str(uuid.uuid4()),
        "status": "unavailable",
        "started_at": old_start,
        "finished_at": now - 70,
        "identity_binding": "azure-binding",
        "starts": [old_start],
        "attempted_combinations": [1, 9],
        "budget_scope": "azure_openai_web_search:v1:8:16",
        "consent_generation": GENERATION,
        "work": {"azure_work_version": 1},
        "result": {"status": "unavailable", "pkm_written": False},
        "revision": 1,
        "fence": "azure",
    }
    offer = instance.offer = AsyncMock(return_value={"status": "unavailable", "pkm_written": False})

    assert await instance.ensure("owner", "fixture-token") == jobs.pending()
    await settle(instance)

    assert offer.await_args.kwargs["attempts_used"] == ()
    assert offer.await_args.kwargs["work"] == {}
    row = instance.store.rows["owner"]
    assert row["budget_scope"] == instance.budget_scope()
    assert row["starts"] == [old_start, now]
