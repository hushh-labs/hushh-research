"""The stream route delegates location turns to dispatch and relays frames,
without invoking the central planner. Non-location turns are untouched."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import agent_chat
from hushh_mcp.adk_bridge import dispatch as dispatch_mod
from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a
from hushh_mcp.adk_bridge.contract import A2ADirective, SpecialistTurnResult
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    PreparedAgentChatTurn,
    PreparedAgentRuntime,
)


def _parse_sse(body: str) -> list[str]:
    return [line[len("event: ") :] for line in body.splitlines() if line.startswith("event: ")]


class _MinimalFakeService:
    """Minimal fake for tests that reach the central planner path."""

    def __init__(self):
        self.runtime_client = object()
        self.stream_tokens = ["general response"]
        self.saved_messages: list[dict] = []
        self.action_plan: AgentChatActionPlan | None = None

    async def prepare_agent_runtime(self, *, runtime_credential=None, runtime_credential_mode=None):
        return PreparedAgentRuntime(
            mode="hushh_managed_vertex",
            provider="gemini",
            model="gemini-2.5-flash",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
            client=self.runtime_client,
            evidence={},
        )

    async def prepare_turn(self, *, user_id: str, message: str, conversation_id=None):
        return PreparedAgentChatTurn(
            conversation_id="conversation-gen",
            user_message_id="msg-gen-1",
            history=[],
            model="gemini-2.5-flash",
        )

    async def plan_action_with_gemini(
        self,
        *,
        user_message,
        history,
        runtime_client,
        runtime_model,
        pkm_context=None,
        screen_context=None,
        deterministic_crm_first=True,
    ):
        return self.action_plan

    async def stream_response(
        self,
        *,
        user_message,
        history,
        runtime_client,
        runtime_model,
        action_plan=None,
        pkm_context=None,
    ):
        for token in self.stream_tokens:
            yield token

    async def add_message(self, **kwargs):
        self.saved_messages.append(kwargs)


def _make_app(user_id: str = "u1") -> FastAPI:
    """Mini FastAPI app with only the agent_chat router and auth bypassed."""
    app = FastAPI()
    app.include_router(agent_chat.router)
    app.dependency_overrides[agent_chat.require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "token": "tok",
    }
    return app


def test_location_turn_is_delegated(monkeypatch):
    """Location message triggers delegation; events are start, token, specialist_directive, complete."""

    async def stub(task):
        return SpecialistTurnResult(
            conversation_id="c-loc",
            text="Ready to share with Mom.",
            directive=A2ADirective(kind="action", payload={"id": "act-1", "type": "publish_share"}),
            is_complete=False,
            state_changed=False,
            model="one+location",
        )

    # Use monkeypatch so the registry is restored after this test.
    monkeypatch.setitem(dispatch_mod._REGISTRY, "agent_location", stub)

    # Also patch the service so the planner path is observably different if it
    # mistakenly runs (it would emit "general response" instead of the delegation frames).
    service = _MinimalFakeService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    app = _make_app()
    client = TestClient(app)
    resp = client.post(
        "/agent/chat/stream",
        json={"user_id": "u1", "message": "share my location with Mom"},
    )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    assert events == ["start", "token", "specialist_directive", "complete"]


def test_non_location_turn_uses_existing_path(monkeypatch):
    """A general message is NOT delegated; it hits the planner path and never emits
    specialist_directive."""

    service = _MinimalFakeService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    app = _make_app()
    client = TestClient(app)
    resp = client.post(
        "/agent/chat/stream",
        json={"user_id": "u1", "message": "good morning"},
    )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    assert "specialist_directive" not in events
    assert events and events[0] == "start"


def test_llm_planned_connected_systems_turn_delegates_inline(monkeypatch):
    """Brand wording can come from the LLM planner instead of the fallback classifier."""

    monkeypatch.setitem(
        dispatch_mod._REGISTRY,
        "agent_connected_systems",
        lambda task: get_connected_systems_a2a().handle(task),
    )
    service = _MinimalFakeService()
    service.action_plan = AgentChatActionPlan(
        call_id="crm-plan-1",
        action_id="connected_system.crm.update.propose",
        label="Propose CRM Update",
        execution="frontend",
        slots={
            "systemId": "salesforce-fsc-customer0",
            "objectType": "Contact",
            "scope": "all_connected_crm_systems",
            "additionalFieldsJson": '{"MailingCity":"Chicago"}',
        },
        message="Opening Connected Systems so you can review and approve the CRM update.",
    )
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    app = _make_app()
    client = TestClient(app)
    resp = client.post(
        "/agent/chat/stream",
        json={"user_id": "u1", "message": "can you update all my brands with new city Chicago"},
    )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    assert events == ["start", "token", "specialist_directive", "complete"]
    assert "Update all" in resp.text


def test_connected_systems_delegate_result_accepts_multibrand_display(monkeypatch):
    """Multi-brand CRM summaries are longer than selection chip labels."""

    monkeypatch.setitem(
        dispatch_mod._REGISTRY,
        "agent_connected_systems",
        lambda task: get_connected_systems_a2a().handle(task),
    )
    service = _MinimalFakeService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    display = "\n".join(
        [
            "Found records in 3 of 3 connected CRM brands.",
            "- Brand One: Name: Abdul Zalil Email: abdul.zalil@gmail.com City: Las Vegas",
            "- Brand Two: Name: Abdul Zalil Email: abdul.zalil@gmail.com City: Chicago",
            "- Brand Three: Name: Abdul Zalil Email: abdul.zalil@gmail.com City: New York",
        ]
    )
    assert len(display) > 200

    app = _make_app()
    client = TestClient(app)
    resp = client.post(
        "/agent/chat/stream",
        json={
            "user_id": "u1",
            "message": "",
            "conversation_id": "conversation-gen",
            "delegate_result": {
                "delegate_agent_id": "agent_connected_systems",
                "kind": "action",
                "id": "read_all",
                "type": "connected_system.crm.read",
                "status": "completed",
                "display": display,
            },
        },
    )

    assert resp.status_code == 200
    assert "Found records in 3 of 3 connected CRM brands." in resp.text
