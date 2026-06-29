"""Tests for the informational pre-vault agent route (``agent_intro``).

These lock in the trust-boundary guarantees of the lower-privilege tier that
powers the single One agent bar before the vault is unlocked:

- It works anonymously (no Authorization header required).
- It never accepts or forwards PKM / vault context.
- It only forwards pure ``route.*`` navigation actions; any other action plan is
  suppressed and the turn degrades to plain text.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.extension import _rate_limit_exceeded_handler

from api.middlewares.rate_limit import limiter
from api.routes.kai import agent_intro
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    PreparedAgentRuntime,
)


class _FakeIntroService:
    def __init__(self):
        self.next_action_plan: AgentChatActionPlan | None = None
        self.stream_tokens = ["Hi", " from One"]
        self.plan_calls: list[dict] = []
        self.stream_calls: list[dict] = []
        self.runtime_client = object()

    async def prepare_agent_runtime(
        self,
        *,
        runtime_credential: str | None = None,
        runtime_credential_mode: str | None = None,
    ):
        return PreparedAgentRuntime(
            mode="hushh_managed_vertex",
            provider="gemini",
            model="gemini-2.5-flash",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
            client=self.runtime_client,
            evidence={},
        )

    async def plan_action_with_gemini(
        self,
        *,
        user_message: str,
        history,
        runtime_client,
        runtime_model: str,
        pkm_context: str | None = None,
        screen_context: dict | None = None,
    ):
        # Trust-boundary assertions: no PKM, no history is ever passed here.
        assert pkm_context is None
        assert history == []
        self.plan_calls.append(
            {
                "user_message": user_message,
                "pkm_context": pkm_context,
                "screen_context": screen_context,
            }
        )
        return self.next_action_plan

    async def stream_response(
        self,
        *,
        user_message: str,
        history,
        runtime_client,
        runtime_model: str,
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ):
        # The informational tier must never stream with PKM context or a plan.
        assert pkm_context is None
        assert action_plan is None
        assert history == []
        self.stream_calls.append({"user_message": user_message})
        for token in self.stream_tokens:
            yield token


def _client(service: _FakeIntroService) -> TestClient:
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(agent_intro.router)
    return TestClient(app)


def test_intro_stream_works_anonymously_and_streams_tokens(monkeypatch):
    service = _FakeIntroService()
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/intro/stream",
        json={"message": "What is Hushh?"},
    )

    assert response.status_code == 200
    assert response.headers["x-agent-model"] == "gemini-2.5-flash"
    # Ephemeral: never advertises a conversation id header.
    assert "x-agent-conversation-id" not in {k.lower() for k in response.headers}
    assert 'event: start\ndata: {"conversation_id": null' in response.text
    assert 'event: token\ndata: {"token": "Hi"}' in response.text
    assert 'event: token\ndata: {"token": " from One"}' in response.text
    assert 'event: complete\ndata: {"conversation_id": null' in response.text
    assert service.stream_calls == [{"user_message": "What is Hushh?"}]


def test_intro_forwards_only_navigation_actions(monkeypatch):
    service = _FakeIntroService()
    service.next_action_plan = AgentChatActionPlan(
        call_id="call-1",
        action_id="route.profile",
        label="Open profile",
        execution="frontend",
        slots={},
        message="Taking you to your profile.",
    )
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/intro/stream",
        json={"message": "open my profile"},
    )

    assert response.status_code == 200
    assert "event: tool_start" in response.text
    assert "event: tool_waiting" in response.text
    assert "route.profile" in response.text
    # Navigation path short-circuits the free-text stream.
    assert service.stream_calls == []


def test_intro_suppresses_non_navigation_actions(monkeypatch):
    service = _FakeIntroService()
    service.next_action_plan = AgentChatActionPlan(
        call_id="call-2",
        action_id="pkm.add",
        label="Save to PKM",
        execution="frontend",
        slots={},
        message="Saving that to your memory.",
    )
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/intro/stream",
        json={"message": "remember my birthday is in May"},
    )

    assert response.status_code == 200
    # The vault-touching action is suppressed; it degrades to a text answer.
    assert "pkm.add" not in response.text
    assert "event: tool_start" not in response.text
    assert service.stream_calls == [{"user_message": "remember my birthday is in May"}]


def test_intro_rejects_empty_and_oversized_messages(monkeypatch):
    service = _FakeIntroService()
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    client = _client(service)

    empty = client.post("/agent/chat/intro/stream", json={"message": ""})
    assert empty.status_code == 422

    oversized = client.post("/agent/chat/intro/stream", json={"message": "x" * 4001})
    assert oversized.status_code == 422
