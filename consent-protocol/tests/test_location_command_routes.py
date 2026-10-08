import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import command_proposals as routes
from api.routes.one.retired_voice import router as retired_router
from hushh_mcp.operons.location.plan import LocationPlanV1


async def test_private_assessment_is_a_proposal_not_execution_authority(monkeypatch):
    from uuid import uuid4

    from pydantic import ValidationError

    revision, _ = routes._catalog()
    context = {"context_revision": "hub-derived"}
    body = {
        "request_id": str(uuid4()),
        "context": {},
        "semantic": {
            "capability_revision": revision,
            "assessment": {"steps": [{"action_id": "location.open_now", "slots": {}}]},
        },
    }
    monkeypatch.setattr(routes, "pod_mode", lambda: False)
    payload = routes.ProposalRequest.model_validate(body)
    plan = await routes._proposal_plan(
        payload, context, "location.plan.v1", token={"user_id": "owner"}, observed=[]
    )
    assert plan.context_revision == "hub-derived"
    assert plan.capability_revision == revision
    body["semantic"]["assessment"]["confirmation_receipt"] = "forged"
    with pytest.raises(ValidationError):
        routes.ProposalRequest.model_validate(body)
    payload.semantic.capability_revision = "old-pod-image"
    with pytest.raises(HTTPException) as error:
        await routes._proposal_plan(
            payload, context, "location.plan.v1", token={"user_id": "owner"}, observed=[]
        )
    assert error.value.detail == {"code": "COMMAND_CAPABILITY_MISMATCH"}
    with pytest.raises(HTTPException) as error:
        await routes._proposal_plan(
            routes.ProposalRequest(request_id=uuid4(), query="private", context={}),
            context,
            "location.plan.v1",
            token={"user_id": "owner"},
            observed=[],
        )
    assert error.value.detail == {"code": "AGENT_PRIVATE_RUNTIME_REQUIRED"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "status", "reason"),
    [(TimeoutError, 504, "timeout"), (ValueError, 422, "invalid_assessment")],
)
async def test_assessment_failure_classification_never_logs_private_content(
    monkeypatch, caplog, failure, status, reason
):
    private = "synthetic-private-query-and-provider-output"
    monkeypatch.setattr(
        routes,
        "LocationCommandBrain",
        lambda: SimpleNamespace(
            manifest=SimpleNamespace(capabilities={}),
            assess=AsyncMock(side_effect=failure(private)),
        ),
    )
    with pytest.raises(HTTPException) as error:
        await routes._assess(
            private, {}, token={"user_id": "synthetic-owner", "token": "synthetic-token"}
        )
    assert error.value.status_code == status
    assert f"reason={reason}" in caplog.text
    assert private not in caplog.text
    assert "synthetic-owner" not in caplog.text
    assert "synthetic-token" not in caplog.text
    assert private not in str(error.value.detail)


def test_obsolete_live_clients_get_retirement_without_provider_startup():
    app = FastAPI()
    app.include_router(retired_router)
    client = TestClient(app)
    assert client.post("/api/one/adk/relay-session").status_code == 410
    with client.websocket_connect("/api/one/adk/live") as ws:
        assert ws.receive_json() == {"type": "error", "code": "ONE_LIVE_RETIRED"}
        assert ws.receive()["code"] == 1008
    with client.websocket_connect("/api/one/adk/location-command/live") as ws:
        assert ws.receive_json() == {"type": "error", "code": "ONE_LIVE_RETIRED"}
        assert ws.receive()["code"] == 1008


@pytest.mark.asyncio
async def test_old_operation_cannot_complete_a_different_command(monkeypatch):
    revision, catalog = routes._catalog()
    plan = LocationPlanV1(
        capability_revision=revision,
        context_revision="ctx",
        mode="end_to_end",
        steps=[{"action_id": "location.open_now"}],
    )
    state = {
        "revision": 1,
        "status": "ready",
        "plan_digest": routes._digest(plan),
        "step_digests": ["expected"],
        "capsule": {"ciphertext": "opaque"},
        "next_step": 0,
    }
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value=state))
    monkeypatch.setattr(
        routes._ledger,
        "command_outcome",
        AsyncMock(
            return_value={
                "state": "settled",
                "settlement_status": "succeeded",
                "step_hmac": "different",
            }
        ),
    )
    update = AsyncMock()
    monkeypatch.setattr(routes._checkpoints, "update", update)
    with pytest.raises(HTTPException) as error:
        await routes._admission(
            "owner", "cmd", routes.StepRequest(revision=1, plan=plan, context={})
        )
    assert error.value.status_code == 409
    update.assert_not_called()


@pytest.mark.asyncio
async def test_expired_identity_cannot_be_reused(monkeypatch):
    monkeypatch.setattr(routes._checkpoints, "get", AsyncMock(return_value=None))
    monkeypatch.setattr(
        routes._ledger, "command_outcome", AsyncMock(return_value={"state": "settled"})
    )
    assess = AsyncMock()
    monkeypatch.setattr(routes, "_assess", assess)
    with pytest.raises(HTTPException) as error:
        await routes.propose(
            routes.ProposalRequest(
                request_id="00000000-0000-4000-8000-000000000000",
                query="different intent",
                context={},
            ),
            {"user_id": "owner"},
        )
    assert error.value.status_code == 409
    assess.assert_not_called()


@pytest.mark.asyncio
async def test_resume_validation_does_not_echo_private_inputs_or_return_a_server_error(monkeypatch):
    revision, _ = routes._catalog()
    plan = LocationPlanV1(
        capability_revision=revision,
        context_revision="ctx",
        mode="end_to_end",
        steps=[{"action_id": "location.send_request", "slots": {}}],
    )
    preparation = routes.MembershipPreparation(
        nonce="ab" * 32, binding_json='{"private":"synthetic-secret-note"}'
    )
    digest = hashlib.sha256(f"{preparation.nonce}:{preparation.binding_json}".encode()).hexdigest()
    step_digest = routes._ledger._hmac(plan.steps[0].model_dump())
    state = {
        "revision": 1,
        "status": "ready",
        "plan_digest": routes._digest(plan),
        "step_digests": [step_digest],
        "capsule": {"ciphertext": "opaque"},
        "next_step": 0,
    }
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value=state))
    monkeypatch.setattr(
        routes._ledger,
        "command_outcome",
        AsyncMock(
            return_value={
                "state": "consumed",
                "consumed_at": "fixture",
                "command_effect": "action",
                "action_id": "location.send_request",
                "audience_plan": {"unit": {}},
                "step_hmac": step_digest,
                "resource_binding_hmac": routes._ledger._hmac({"digest": digest}),
            }
        ),
    )
    with pytest.raises(HTTPException) as error:
        await routes._admission(
            "owner",
            "cmd",
            routes.ResumeRequest(
                revision=1,
                plan=plan,
                context={},
                preparation=preparation,
                resource_binding_digest=digest,
            ),
            renew=True,
        )
    assert error.value.status_code == 422
    assert "synthetic-secret-note" not in error.value.detail


@pytest.mark.asyncio
@pytest.mark.parametrize("complete", [True, False])
async def test_lost_membership_response_uses_only_complete_frozen_audience_receipts(
    monkeypatch, complete
):
    state = {
        "status": "ready",
        "next_step": 0,
        "step_count": 1,
        "step_digests": ["step"],
        "capsule": {"ciphertext": "opaque"},
    }
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value=state))
    monkeypatch.setattr(routes, "_public", lambda value: value)
    monkeypatch.setattr(
        routes._ledger,
        "command_outcome",
        AsyncMock(
            return_value={
                "state": "consumed",
                "step_hmac": "step",
                "action_id": "location.add_to_circle",
                "command_effect": "action",
                "membership_plan": {"0": {"request_hmac": "audience"}},
            }
        ),
    )
    reconcile = AsyncMock(return_value=complete)
    pause = AsyncMock(return_value=True)
    monkeypatch.setattr(routes, "pause_remaining_command", pause)
    monkeypatch.setattr(routes._ledger, "reconcile_membership_command", reconcile)
    ledger_settle = AsyncMock()
    monkeypatch.setattr(routes._ledger, "settle_command", ledger_settle)

    async def save(_user, _command, prior, **changes):
        return {**prior, **changes}

    monkeypatch.setattr(routes, "_save", save)
    result = await routes.settle(
        "cmd",
        routes.SettlementRequest(
            step=0,
            operation_id="op",
            execution_receipt="receipt",
            status="review_required",
        ),
        {"user_id": "owner"},
    )
    reconcile.assert_awaited_once_with(user_id="owner", command_id="cmd", step=0)
    assert result["verified_membership_result"] is complete
    assert result["checkpoint"]["status"] == ("completed" if complete else "ready")
    if complete:
        assert result["checkpoint"]["capsule"] is None
        assert ledger_settle.await_args.kwargs["status"] == "succeeded"
        pause.assert_not_awaited()
    else:
        assert result["checkpoint"]["capsule"] == state["capsule"]
        assert result["checkpoint"]["next_step"] == 0
        assert result["resume_required"] is True
        ledger_settle.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("state_name", ["issued", "confirmed", "consumed", "settled"])
async def test_partial_operation_cannot_reassess_after_authority_renewal(monkeypatch, state_name):
    plan = LocationPlanV1(
        capability_revision="cap",
        context_revision="ctx",
        mode="end_to_end",
        steps=[{"action_id": "location.send_request", "slots": {}}],
    )
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value={"next_step": 0}))
    monkeypatch.setattr(routes, "_check_plan", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        routes._ledger,
        "command_outcome",
        AsyncMock(return_value={"state": state_name, "consumed_at": "synthetic-prior-attempt"}),
    )
    assess = AsyncMock()
    monkeypatch.setattr(routes, "_assess", assess)
    with pytest.raises(HTTPException) as error:
        await routes.resolve(
            "cmd",
            routes.ResolveRequest(revision=1, plan=plan, context={}, query="Replace audience"),
            {"user_id": "owner"},
        )
    assert error.value.status_code == 409
    assess.assert_not_called()


@pytest.mark.asyncio
async def test_resource_context_uses_only_correlated_completed_steps(monkeypatch):
    from fastapi import Response

    from hushh_mcp.services.location_command_reads import LocationCommandReadService

    state = {"next_step": 1, "step_digests": ["good", "future"]}
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value=state))
    monkeypatch.setattr(routes, "_public", lambda value: value)
    monkeypatch.setattr(routes._ledger, "command_outcome", AsyncMock(return_value=None))
    results = [
        {"step": 0, "step_hmac": "good", "kind": "circle", "id": "created", "operation_id": "op"},
        {"step": 0, "step_hmac": "wrong", "kind": "circle", "id": "stale"},
        {"step": 1, "step_hmac": "future", "kind": "circle", "id": "future"},
    ]
    monkeypatch.setattr(routes._ledger, "command_results", AsyncMock(return_value=results))
    observe = AsyncMock(return_value=[])
    monkeypatch.setattr(LocationCommandReadService, "observe_created_circles", observe)
    response = Response()
    actual = await routes.get_command("cmd", response, {"user_id": "owner"})
    expected = [{"step": 0, "kind": "circle", "id": "created", "operation_id": "op"}]
    assert actual["results"] == expected
    observe.assert_awaited_once_with(expected)
    assert response.headers["Cache-Control"] == "private, no-store"
