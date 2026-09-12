from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import command_proposals as routes
from api.routes.one.retired_voice import router as retired_router
from hushh_mcp.operons.location.plan import LocationPlanV1


def test_obsolete_live_clients_get_retirement_without_provider_startup():
    app = FastAPI()
    app.include_router(retired_router)
    client = TestClient(app)
    assert client.post("/api/one/adk/relay-session").status_code == 410
    with client.websocket_connect("/api/one/adk/live") as ws:
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
