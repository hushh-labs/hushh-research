"""Owner-approved PWM context follows explicit Update and existing evidence boundaries."""

import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk.world_model_azure import run_world_model_azure
from tests.fixtures.profile_research_jobs import authority as authority
from tests.fixtures.profile_research_jobs import pwm_manager, settle
from tests.fixtures.world_model_gateway import IDENTITY, FakeGateway
from tests.test_world_model import owner_client


@pytest.mark.asyncio
async def test_confirmed_research_snapshot_is_frozen_for_resumes_not_later_generations(monkeypatch):
    from hushh_mcp.services import world_model_service as pwm

    instance = pwm_manager(monkeypatch, progressive=True)
    context = {"confirmed": ["Public robotics project"], "permitted_public_research": True}
    inputs = {
        "owner_decisions": {"confirmed": context["confirmed"], "rejected": ["Private exclusion"]},
        "research_context": context,
    }
    carried, same = instance.prepare_inputs(None, inputs, True)
    assert carried == inputs and same is False
    pending = {"status": "pending", "started_at": instance.clock(), "inputs": inputs}
    resumed, same = instance.prepare_inputs(
        pending, {"owner_decisions": {"confirmed": ["New fact"], "rejected": []}}, False
    )
    assert same and resumed["research_context"] == context
    changed = {**inputs, "research_context": {**context, "confirmed": []}}
    with pytest.raises(pwm.PublicProfilesChanged):
        instance.prepare_inputs(pending, changed, True)
    with pytest.raises(pwm.PublicProfilesChanged):
        instance.prepare_inputs(None, inputs, False)
    complete = {**pending, "status": "offered", "finished_at": instance.clock()}
    prepared = instance.prepare_start_state(complete)
    assert "research_context" not in prepared["inputs"]
    assert complete["inputs"]["research_context"] == context
    assert prepared["inputs"]["owner_decisions"] == inputs["owner_decisions"]


@pytest.mark.parametrize("inputs", [None, {"owner_decisions": {"confirmed": [], "rejected": []}}])
def test_new_explicit_refresh_does_not_inherit_an_old_confirmed_snapshot(inputs):
    from hushh_mcp.services.world_model_service import WorldModelJobs

    instance = object.__new__(WorldModelJobs)
    old = {"confirmed": ["Old approved detail"], "permitted_public_research": True}
    state = {
        "status": "unavailable",
        "inputs": {"research_context": old},
        "result": {"research_exhausted": True},
    }
    carried, same = instance.prepare_inputs(state, inputs, True)
    assert "research_context" not in (carried or {}) and same is False


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", ["consent", "identity"])
async def test_previous_confirmed_context_is_not_exported_after_authority_changes(
    monkeypatch, changed
):
    instance = pwm_manager(monkeypatch, progressive=True)
    old = {"confirmed": ["Old approved detail"], "permitted_public_research": True}
    state = {
        "status": "paused",
        "job_id": "previous",
        "started_at": instance.clock(),
        "finished_at": instance.clock(),
        "attempted_combinations": [],
        "starts": [],
        "identity_binding": "old-binding" if changed == "identity" else "owner-bound-identity",
        **await instance.job_context("owner", "fixture-token"),
        "inputs": {"research_context": old},
    }
    if changed == "consent":
        state["consent_generation"] = "old-generation"
    await instance.store.write("owner", state, None)
    await instance.start("owner", "fixture-token")
    await settle(instance)
    sent = instance.offer.call_args.kwargs.get("inputs") or {}
    assert "research_context" not in sent
    assert "research_context" not in instance.store.rows["owner"].get("inputs", {})


@pytest.mark.asyncio
async def test_new_update_uses_fresh_snapshot_after_consent_change(monkeypatch):
    instance = pwm_manager(monkeypatch, progressive=True)
    inputs = {
        "owner_decisions": {"confirmed": ["New approved lead"], "rejected": []},
        "research_context": {"confirmed": ["New approved lead"], "permitted_public_research": True},
    }
    now = instance.clock()
    old = {
        "status": "paused",
        "job_id": "previous",
        "started_at": now,
        "finished_at": now,
        "attempted_combinations": [1],
        "starts": [now - 10],
        "consent_generation": "old-generation",
        "identity_binding": "old-binding",
        "budget_scope": instance.budget_scope(),
    }
    await instance.store.write("owner", old, None)
    await instance.start("owner", "fixture-token", inputs=inputs, refresh_completed=True)
    await settle(instance)
    assert (
        instance.offer.call_args.kwargs["inputs"]["research_context"] == inputs["research_context"]
    )
    assert instance.offer.call_args.kwargs["attempts_used"] == ()
    assert instance.store.rows["owner"]["resume_binding"] == ""
    assert instance.store.rows["owner"]["starts"][0] == now - 10


def test_confirmed_context_is_only_admitted_on_explicit_refresh(monkeypatch):
    start = AsyncMock(return_value={"status": "pending", "pkm_written": False})
    client, _ = owner_client(monkeypatch, SimpleNamespace(start=start))
    context = {"confirmed": ["Maintains a robotics project"], "permitted_public_research": True}
    body = {
        "refresh": True,
        "owner_decisions": {"confirmed": context["confirmed"], "rejected": ["Not me"]},
        "research_context": context,
    }
    assert client.post("/api/one/world-model/jobs", json=body).status_code == 202
    start.assert_awaited_once_with(
        "owner",
        "fixture",
        refresh_completed=True,
        inputs={"owner_decisions": body["owner_decisions"], "research_context": context},
    )
    assert client.post("/api/one/world-model/ensure", json=body).status_code == 422
    for invalid in (
        {**body, "refresh": False},
        {**body, "owner_decisions": None},
        {**body, "research_context": {**context, "confirmed": ["An unconfirmed private detail"]}},
        {**body, "research_context": {**context, "permitted_public_research": False}},
    ):
        assert client.post("/api/one/world-model/jobs", json=invalid).status_code == 422
    assert start.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("approved", [False, True])
async def test_confirmed_research_snapshot_guides_search_without_becoming_identity_evidence(
    approved,
):
    lead, private_rejected = "Builds owner-declared robotics projects", "An unrelated claim"
    charges, snapshots = [], []
    observed = {"search": 0, "plan": 0}

    class ContextGateway(FakeGateway):
        async def search(self, request):
            observed["search"] += 1
            assert request.get("owner_confirmed_research_leads", []) == ([lead] if approved else [])
            assert "owner_decisions" not in request and private_rejected not in str(request)
            return await super().search(request)

        async def plan(self, payload):
            observed["plan"] += 1
            assert payload["owner_confirmed_research_leads"] == ([lead] if approved else [])
            assert "owner_decisions" not in payload and private_rejected not in str(payload)
            return await super().plan(payload)

        async def structured(self, **kwargs):
            if kwargs["purpose"] in {"identity_assessment", "provisional_findings"}:
                assert "owner_confirmed_research_leads" not in kwargs["payload"]
                assert "research_context" not in kwargs["payload"]
            return await super().structured(**kwargs)

    async def charge(values):
        charges.extend(values)

    async def checkpoint(value):
        snapshots.append(copy.deepcopy(value))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=checkpoint,
        owner_decisions={"confirmed": [lead], "rejected": [private_rejected]},
        owner_research_context={"confirmed": [lead], "permitted_public_research": True}
        if approved
        else None,
        gateway=ContextGateway(charges=charges, snapshots=snapshots),
    )
    assert observed["search"] and observed["plan"]
    assert result["status"] == "offered"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert "research_context" not in snapshots[-1]
    assert "owner_confirmed_research_leads" not in snapshots[-1]
    assert result["pkm_written"] is False
