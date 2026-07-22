"""Typed Agent Chat uses One's semantic head and preserves its SSE contract."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import agent_chat
from hushh_mcp.adk_bridge import dispatch as dispatch_mod
from hushh_mcp.adk_bridge.connected_systems_agent import get_connected_systems_a2a
from hushh_mcp.adk_bridge.contract import SpecialistTurnResult
from hushh_mcp.one_adk.text_runtime import OneTextDirective, OneTextStreamEvent
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    PreparedAgentChatTurn,
    PreparedAgentRuntime,
)


class _FakeDirectiveStore:
    async def issue(self, **kwargs):  # noqa: ANN003
        return SimpleNamespace(
            directive_id="dir-test",
            context_revision=kwargs["context_revision"],
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )

    async def cancel_open_for_conversation(self, **kwargs):  # noqa: ANN003
        return None


@pytest.fixture(autouse=True)
def _directive_authority(monkeypatch):
    monkeypatch.setattr(
        agent_chat,
        "get_action_directive_store",
        lambda: _FakeDirectiveStore(),
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
        self.one_events: list[OneTextStreamEvent] = [
            OneTextStreamEvent(kind="token", text="general response")
        ]
        self.one_event_delay_seconds = 0.0
        self.one_turn_calls: list[dict] = []

    async def prepare_agent_runtime(
        self,
        *,
        runtime_credential=None,
        runtime_credential_mode=None,
        runtime_credential_transport=None,
        runtime_vertex_project=None,
        runtime_vertex_location=None,
    ):
        return PreparedAgentRuntime(
            mode="hushh_managed_vertex",
            provider="gemini",
            model="gemini-3.1-flash-lite",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
            gemini_byok_transport="developer_api",
            vertex_project=None,
            vertex_location=None,
            client=self.runtime_client,
            evidence={},
        )

    async def prepare_turn(self, *, user_id: str, message: str, conversation_id=None):
        return PreparedAgentChatTurn(
            conversation_id="conversation-gen",
            user_message_id="msg-gen-1",
            history=[],
            model="gemini-3.1-flash-lite",
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
        raise AssertionError("typed Agent Chat must not call the legacy action planner")

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
        raise AssertionError("typed Agent Chat must not call the legacy response stream")
        yield  # pragma: no cover

    async def stream_one_turn(self, **kwargs):
        self.one_turn_calls.append(kwargs)
        if self.one_event_delay_seconds:
            await asyncio.sleep(self.one_event_delay_seconds)
        for event in self.one_events:
            yield event

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
    """One, not a keyword router, emits the Location specialist directive."""
    service = _MinimalFakeService()
    service.one_events = [
        OneTextStreamEvent(kind="token", text="Ready to share with Mom."),
        OneTextStreamEvent(
            kind="directive",
            directive=OneTextDirective(
                kind="action",
                payload={"id": "act-1", "type": "publish_share"},
                delegate_agent_id="agent_location",
            ),
        ),
    ]
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


def test_explicit_delegate_agent_id_is_delegated(monkeypatch):
    """Generated One Goal contracts can force a wired specialist without re-classifying text."""

    async def stub(task):
        return SpecialistTurnResult(
            conversation_id="c-email",
            text="Two threads need a reply today.",
            directive=None,
            is_complete=True,
            state_changed=False,
            model="one+email",
        )

    monkeypatch.setitem(dispatch_mod._REGISTRY, "agent_email", stub)
    service = _MinimalFakeService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    app = _make_app()
    client = TestClient(app)
    resp = client.post(
        "/agent/chat/stream",
        json={
            "user_id": "u1",
            "message": "what needs a reply today?",
            "delegate_agent_id": "agent_email",
        },
    )

    assert resp.status_code == 200
    assert "Two threads need a reply today." in resp.text
    events = _parse_sse(resp.text)
    assert events == ["start", "token", "complete"]
    assert len(service.saved_messages) == 1


def test_location_delegate_result_is_not_persisted_twice(monkeypatch):
    captured_tasks = []

    async def stub(task):
        captured_tasks.append(task)
        return SpecialistTurnResult(
            conversation_id="conversation-location",
            text="Your public link is ready.",
            directive=None,
            is_complete=True,
            state_changed=True,
            model="one+location",
        )

    monkeypatch.setitem(dispatch_mod._REGISTRY, "agent_location", stub)
    service = _MinimalFakeService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    response = TestClient(_make_app()).post(
        "/agent/chat/stream",
        json={
            "user_id": "u1",
            "message": "",
            "conversation_id": "conversation-location",
            "delegate_result": {
                "delegate_agent_id": "agent_location",
                "kind": "action",
                "id": "public-link-1",
                "type": "create_public_link",
                "status": "completed",
            },
        },
    )

    assert response.status_code == 200
    assert _parse_sse(response.text) == ["start", "token", "complete"]
    assert captured_tasks[0].persistence_owner == "specialist"
    assert service.saved_messages == []


def test_slow_explicit_location_delegate_emits_progress(monkeypatch):
    async def stub(task):
        await asyncio.sleep(0.02)
        return SpecialistTurnResult(
            conversation_id=task.conversation_id or "conversation-location",
            text="I can prepare that public location link.",
            directive=None,
            is_complete=True,
            state_changed=False,
            model="one+location",
        )

    monkeypatch.setitem(dispatch_mod._REGISTRY, "agent_location", stub)
    monkeypatch.setattr(agent_chat, "_AGENT_CHAT_PROGRESS_INTERVAL_SECONDS", 0.005)
    service = _MinimalFakeService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    response = TestClient(_make_app()).post(
        "/agent/chat/stream",
        json={
            "user_id": "u1",
            "message": "Create a public location link",
            "delegate_agent_id": "agent_location",
        },
    )

    assert response.status_code == 200
    events = _parse_sse(response.text)
    assert events[0] == "start"
    assert "progress" in events[1:-2]
    assert events[-2:] == ["token", "complete"]


def test_slow_one_turn_emits_progress_until_first_token(monkeypatch):
    service = _MinimalFakeService()
    service.one_event_delay_seconds = 0.02
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    monkeypatch.setattr(agent_chat, "_AGENT_CHAT_PROGRESS_INTERVAL_SECONDS", 0.005)

    response = TestClient(_make_app()).post(
        "/agent/chat/stream",
        json={"user_id": "u1", "message": "Create a public location link"},
    )

    assert response.status_code == 200
    events = _parse_sse(response.text)
    assert events[0] == "start"
    assert "progress" in events[1:-2]
    assert events[-2:] == ["token", "complete"]


def test_non_location_turn_uses_existing_path(monkeypatch):
    """A general message stays conversational inside One."""

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


def test_silent_model_turn_fails_explicitly_instead_of_completing_empty(monkeypatch):
    service = _MinimalFakeService()
    service.one_events = []
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    response = TestClient(_make_app()).post(
        "/agent/chat/stream",
        json={
            "user_id": "u1",
            "message": "list down a summary of my memory",
            "pkm_context": "Writing preference: concise summaries.",
        },
    )

    assert response.status_code == 200
    assert _parse_sse(response.text) == ["start", "error"]
    assert "AGENT_RUNTIME_EMPTY_RESPONSE" in response.text
    assert "event: complete" not in response.text


@pytest.mark.parametrize(
    ("message", "action_id"),
    [
        ("take me to location", "route.one_location"),
        ("take me to KYC", "route.one_kyc"),
    ],
)
def test_route_phrasing_uses_one_generated_navigation_action(monkeypatch, message, action_id):
    service = _MinimalFakeService()
    service.one_events = [
        OneTextStreamEvent(kind="token", text="Opening that screen."),
        OneTextStreamEvent(
            kind="directive",
            directive=OneTextDirective(
                kind="action",
                payload={"actionId": action_id, "slots": {}},
            ),
        ),
    ]
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    response = TestClient(_make_app()).post(
        "/agent/chat/stream",
        json={"user_id": "u1", "message": message},
    )

    assert response.status_code == 200
    assert f'"action_id": "{action_id}"' in response.text
    assert "event: tool_waiting" in response.text
    assert "specialist_directive" not in response.text
    assert service.one_turn_calls[0]["message"] == message


def test_llm_planned_connected_systems_turn_delegates_inline(monkeypatch):
    """One can return a governed Connected Systems specialist directive."""
    service = _MinimalFakeService()
    service.one_events = [
        OneTextStreamEvent(kind="token", text="Review the proposed CRM update in the app."),
        OneTextStreamEvent(
            kind="directive",
            directive=OneTextDirective(
                kind="action",
                payload={
                    "id": "crm-plan-1",
                    "type": "connected_system.crm.update.propose",
                    "actionId": "connected_system.crm.update.propose",
                    "execution": "frontend",
                    "slots": {"scope": "all_connected_crm_systems"},
                },
                delegate_agent_id="agent_connected_systems",
            ),
        ),
    ]
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
    assert "connected_system.crm.update.propose" in resp.text


def test_connected_systems_delegate_result_requires_attenuated_authority(monkeypatch):
    """A raw vault-owner chat token must not become CRM hop authority."""

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
    assert "event: error" in resp.text
    assert "Found records in 3 of 3 connected CRM brands." not in resp.text
