"""Voice and typed command proposals validated and checkpointed in the owner's agent.

For an own-cloud owner the plan, its query and the screen it came from must never
reach the hub. These prove the agent validates with the hub's own rules, holds the
checkpoint itself, advances it only one exact step at a time, and never touches the
hub's checkpoint store or directive ledger.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import command_proposals, pod_agent_chat, pod_command_proposals
from api.routes.one.pod_chat_owner import owner_context
from hushh_mcp.services.pod_command_checkpoints import MAX_PER_OWNER, PodCommandCheckpointStore

BASE = "/api/one/pod/agent-chat/proposals"


class HubUntouchable:
    def __getattr__(self, name):
        raise AssertionError(f"the hub's store was used: {name}")


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setattr(pod_command_proposals, "store", PodCommandCheckpointStore())
    monkeypatch.setattr(command_proposals, "_checkpoints", HubUntouchable())
    monkeypatch.setattr(command_proposals, "_ledger", HubUntouchable())


def _client(owner_id: str = "owner-a") -> TestClient:
    app = FastAPI()
    app.include_router(pod_agent_chat.router)
    app.dependency_overrides[owner_context] = lambda: SimpleNamespace(
        owner=owner_id, require_access=AsyncMock()
    )
    return TestClient(app)


def _typed(request_id: str, action_id: str = "location.open_now", context=None):
    return {
        "request_id": request_id,
        "action": {"action_id": action_id, "slots": {}},
        "context": context if context is not None else {"screen": "location"},
    }


def test_a_typed_action_is_validated_and_checkpointed_in_the_agent():
    client = _client()
    request_id = str(uuid4())
    created = client.post(f"{BASE}/typed", json=_typed(request_id))
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["plan"]["steps"][0]["action_id"] == "location.open_now"
    checkpoint = body["checkpoint"]
    assert checkpoint["command_id"] == request_id
    assert checkpoint["status"] == "ready" and checkpoint["next_step"] == 0
    assert "plan" not in checkpoint and "plan_digest" not in checkpoint
    again = client.post(f"{BASE}/typed", json=_typed(request_id)).json()
    assert again["recovery_required"] is True
    # The owner of a different session reads nothing of it.
    assert _client("owner-b").get(f"{BASE}/{request_id}").status_code == 404


def test_an_unregistered_action_and_disabled_voice_are_refused():
    client = _client()
    unknown = client.post(f"{BASE}/typed", json=_typed(str(uuid4()), "location.delete_world"))
    assert unknown.status_code == 422
    disabled = client.post(
        f"{BASE}/typed",
        json=_typed(str(uuid4()), context={"voice_settings": {"voice_enabled": False}}),
    )
    assert disabled.status_code == 403


def test_settle_advances_exactly_the_next_step_and_then_closes():
    client = _client()
    request_id = str(uuid4())
    checkpoint = client.post(f"{BASE}/typed", json=_typed(request_id)).json()["checkpoint"]
    wrong_step = client.post(
        f"{BASE}/{request_id}/settle",
        json={"revision": checkpoint["revision"], "step": 1, "status": "succeeded"},
    )
    assert wrong_step.status_code == 409
    stale = client.post(
        f"{BASE}/{request_id}/settle",
        json={"revision": checkpoint["revision"] + 5, "step": 0, "status": "succeeded"},
    )
    assert stale.status_code == 409
    done = client.post(
        f"{BASE}/{request_id}/settle",
        json={"revision": checkpoint["revision"], "step": 0, "status": "succeeded"},
    ).json()["checkpoint"]
    assert done["status"] == "completed" and done["next_step"] == 1
    closed = client.post(
        f"{BASE}/{request_id}/settle",
        json={"revision": done["revision"], "step": 1, "status": "succeeded"},
    )
    assert closed.status_code == 409
    assert client.delete(f"{BASE}/{request_id}").json()["cancelled"] is True
    assert client.get(f"{BASE}/{request_id}").status_code == 404


def test_a_semantic_plan_is_validated_by_the_hubs_rules_and_a_raw_query_is_refused():
    client = _client()
    revision, _ = command_proposals._catalog()
    request_id = str(uuid4())
    semantic = client.post(
        BASE,
        json={
            "request_id": request_id,
            "plan_version": "location.plan.v1",
            "context": {"screen": "location"},
            "semantic": {
                "capability_revision": revision,
                "assessment": {"steps": [{"action_id": "location.open_now", "slots": {}}]},
            },
        },
    )
    assert semantic.status_code == 200, semantic.text
    assert semantic.json()["checkpoint"]["step_count"] == 1
    mismatch = client.post(
        BASE,
        json={
            "request_id": str(uuid4()),
            "plan_version": "location.plan.v1",
            "context": {},
            "semantic": {
                "capability_revision": "old-pod-image",
                "assessment": {"steps": [{"action_id": "location.open_now", "slots": {}}]},
            },
        },
    )
    assert mismatch.status_code == 409
    query = client.post(
        BASE, json={"request_id": str(uuid4()), "query": "share with mum", "context": {}}
    )
    assert query.status_code == 422
    assert query.json()["detail"] == {"code": "COMMAND_SEMANTIC_REQUIRED"}


async def test_the_pod_store_is_owner_bound_compare_and_set_and_bounded():
    from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict

    store = PodCommandCheckpointStore()
    row = await store.create("owner-a", "cmd", {"status": "ready", "next_step": 0})
    assert await store.get("owner-b", "cmd") is None
    with pytest.raises(CommandCheckpointConflict):
        await store.update("owner-a", "cmd", row["revision"] + 1, {"status": "x"})
    for index in range(MAX_PER_OWNER - 1):
        await store.create("owner-a", f"c{index}", {"status": "ready"})
    with pytest.raises(CommandCheckpointConflict):
        await store.create("owner-a", "one-too-many", {"status": "ready"})
    await store.create("owner-b", "cmd", {"status": "ready"})
