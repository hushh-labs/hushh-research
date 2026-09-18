"""The HTTP confirm twin proves the actor the same way the socket does."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import voice
from hushh_mcp.one_voice import actor_proof
from hushh_mcp.one_voice.pending_actions import PendingAction
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import ToolInput, ToolPolicy, ToolResult, ToolSpec

USER = "user-me"
ROW = "11111111-1111-4111-8111-111111111111"
CONV = "22222222-2222-4222-8222-222222222222"


class _Input(ToolInput):
    pass


class _Result(ToolResult):
    status: str = "sent"


async def _send(ctx, args):
    return _Result(status="sent", spoken_facts=["sent"])


SEND = ToolSpec(
    name="send_thing",
    gateway_action_id="people.profile.connect",
    policy=ToolPolicy.confirm_voice,
    input_model=_Input,
    output_model=_Result,
    description="Send.",
    handler=_send,
    firebase_plane=True,
    summarize=lambda ctx, a: "send the thing",
)


class _Store:
    def __init__(self) -> None:
        self.row = PendingAction(
            id=ROW,
            user_id=USER,
            conversation_id=CONV,
            tool_name=SEND.name,
            gateway_action_id=SEND.gateway_action_id,
            tier="voice",
            args={},
            summary="send the thing",
            status="pending",
        )
        self.confirmed: list[str] = []

    async def get(self, *, user_id, pending_action_id):
        return self.row if pending_action_id == ROW and user_id == USER else None

    async def confirm(self, *, user_id, pending_action_id, source, receipt_token=None):
        self.confirmed.append(source)
        self.row.status = "confirmed"
        return self.row

    async def resolve(self, *, user_id, pending_action_id, status, result):
        self.row.status = status
        self.row.result = result
        return self.row


@pytest.fixture
def app(monkeypatch):
    store = _Store()
    proofs: list[tuple[str | None, str]] = []

    async def fake_proof(token, expected_user_id):
        proofs.append((token, expected_user_id))
        return {"fresh": "ok", "stale": "invalid", "theirs": "mismatch"}.get(
            str(token or ""), "missing"
        )

    monkeypatch.setattr(actor_proof, "verify_firebase_actor", fake_proof)
    monkeypatch.setattr(registry, "get_tool", lambda name: {SEND.name: SEND}.get(str(name or "")))
    monkeypatch.setattr(voice, "PendingActionStore", lambda: store)

    class _Conversations:
        async def get(self, *, user_id, conversation_id):
            return None

    monkeypatch.setattr(
        "hushh_mcp.one_voice.conversations.ConversationStore", lambda: _Conversations()
    )
    application = FastAPI()
    application.include_router(voice.router)
    application.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": USER,
        "token": "HCT:token",
    }
    return application, store, proofs


@pytest.mark.parametrize(
    ("token", "code"),
    [
        (None, "FIREBASE_PROOF_REQUIRED"),
        ("stale", "FIREBASE_PROOF_INVALID"),
        ("theirs", "FIREBASE_PROOF_INVALID"),
    ],
)
def test_http_confirm_refuses_an_unproven_actor_before_the_row_is_confirmed(app, token, code):
    application, store, proofs = app
    body: dict[str, Any] = {} if token is None else {"firebase_id_token": token}
    response = TestClient(application).post(
        f"/api/one/voice/pending-actions/{ROW}/confirm", json=body
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == code
    assert proofs == [(token, USER)]
    assert store.confirmed == [] and store.row.status == "pending"


def test_http_confirm_executes_with_a_verified_proof(app):
    application, store, proofs = app
    response = TestClient(application).post(
        f"/api/one/voice/pending-actions/{ROW}/confirm", json={"firebase_id_token": "fresh"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["status"] == "sent"
    assert proofs == [("fresh", USER)]
    assert store.confirmed == ["http"] and store.row.status == "executed"


def test_http_confirm_refuses_a_device_step_tool_and_leaves_the_card_tappable(app, monkeypatch):
    """A tool whose result hands the device a step (Save My Soul's publish)
    can only be confirmed inside the live session that runs and verifies it;
    over HTTP it would arm grants nobody publishes or reports."""
    from hushh_mcp.one_voice.tools import sos

    application, store, proofs = app
    trigger = next(t for t in sos.TOOLS if t.name == "trigger_save_my_soul")
    assert trigger.device_step is True
    store.row.tool_name = trigger.name
    store.row.gateway_action_id = trigger.gateway_action_id
    store.row.tier = "tap"
    monkeypatch.setattr(
        registry, "get_tool", lambda name: {trigger.name: trigger}.get(str(name or ""))
    )
    response = TestClient(application).post(
        f"/api/one/voice/pending-actions/{ROW}/confirm",
        json={"receipt_token": "whatever", "firebase_id_token": "fresh"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "SESSION_CONFIRM_REQUIRED",
        "tool": "trigger_save_my_soul",
    }
    assert proofs == []
    assert store.confirmed == [] and store.row.status == "pending"
