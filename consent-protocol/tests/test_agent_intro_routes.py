"""Tests for the informational pre-vault agent route (``agent_intro``).

These lock in the trust-boundary guarantees of the lower-privilege tier that
powers the single One agent bar before the vault is unlocked:

- It works anonymously (no Authorization header required).
- It never accepts or forwards PKM / vault context.
- It only forwards pure ``route.*`` navigation directives; any other directive
  is suppressed and the turn stays informational.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.extension import _rate_limit_exceeded_handler

from api.middlewares.rate_limit import limiter
from api.routes.kai import agent_intro
from hushh_mcp.one_adk.text_runtime import OneTextDirective, OneTextStreamEvent
from hushh_mcp.services.agent_chat_service import PreparedAgentRuntime


class _FakeIntroService:
    def __init__(self):
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
            model="gemini-3.1-flash-lite",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
            gemini_byok_transport="developer_api",
            vertex_project=None,
            vertex_location=None,
            client=self.runtime_client,
            evidence={},
        )


def _client(service: _FakeIntroService) -> TestClient:
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(agent_intro.router)
    return TestClient(app)


def _intro_stream(events: list[OneTextStreamEvent], calls: list[dict]):
    async def stream(**kwargs):
        calls.append(kwargs)
        for event in events:
            yield event

    return stream


def test_intro_stream_works_anonymously_and_streams_tokens(monkeypatch):
    service = _FakeIntroService()
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    calls: list[dict] = []
    monkeypatch.setattr(
        agent_intro,
        "stream_one_intro_text_turn",
        _intro_stream(
            [
                OneTextStreamEvent(kind="token", text="Hi"),
                OneTextStreamEvent(kind="token", text=" from One"),
            ],
            calls,
        ),
    )
    client = _client(service)

    response = client.post(
        "/agent/chat/intro/stream",
        json={"message": "What is Hushh?"},
    )

    assert response.status_code == 200
    assert response.headers["x-agent-model"] == "gemini-3.1-flash-lite"
    # Ephemeral: never advertises a conversation id header.
    assert "x-agent-conversation-id" not in {k.lower() for k in response.headers}
    assert 'event: start\ndata: {"conversation_id": null' in response.text
    assert 'event: token\ndata: {"token": "Hi"}' in response.text
    assert 'event: token\ndata: {"token": " from One"}' in response.text
    assert 'event: complete\ndata: {"conversation_id": null' in response.text
    assert len(calls) == 1
    assert {key: value for key, value in calls[0].items() if key != "screen_context"} == {
        "user_id": "anonymous",
        "message": "What is Hushh?",
        "runtime_provider": "gemini",
        "runtime_model": "gemini-3.1-flash-lite",
        "runtime_mode": "hushh_managed_vertex",
        "runtime_credential": None,
    }
    assert calls[0]["screen_context"]["route_family"] == ""
    assert calls[0]["screen_context"]["available_action_ids"] == []
    assert "pkm_context" not in calls[0]["screen_context"]


def test_intro_forwards_only_navigation_actions(monkeypatch):
    service = _FakeIntroService()
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    monkeypatch.setattr(
        agent_intro,
        "stream_one_intro_text_turn",
        _intro_stream(
            [
                OneTextStreamEvent(
                    kind="directive",
                    directive=OneTextDirective(
                        kind="action", payload={"actionId": "route.profile", "slots": {}}
                    ),
                )
            ],
            [],
        ),
    )
    client = _client(service)

    response = client.post(
        "/agent/chat/intro/stream",
        json={"message": "open my profile"},
    )

    assert response.status_code == 200
    assert "event: tool_start" in response.text
    assert "event: tool_waiting" in response.text
    assert "route.profile" in response.text


def test_intro_suppresses_non_navigation_actions(monkeypatch):
    service = _FakeIntroService()
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    monkeypatch.setattr(
        agent_intro,
        "stream_one_intro_text_turn",
        _intro_stream(
            [
                OneTextStreamEvent(kind="token", text="Unlock your vault to save that."),
                OneTextStreamEvent(
                    kind="directive",
                    directive=OneTextDirective(
                        kind="action", payload={"actionId": "pkm.add", "slots": {}}
                    ),
                ),
            ],
            [],
        ),
    )
    client = _client(service)

    response = client.post(
        "/agent/chat/intro/stream",
        json={"message": "remember my birthday is in May"},
    )

    assert response.status_code == 200
    # The vault-touching action is suppressed; it degrades to a text answer.
    assert "pkm.add" not in response.text
    assert "event: tool_start" not in response.text
    assert "Unlock your vault to save that." in response.text


def test_intro_rejects_empty_and_oversized_messages(monkeypatch):
    service = _FakeIntroService()
    monkeypatch.setattr(agent_intro, "get_agent_chat_service", lambda: service)
    client = _client(service)

    empty = client.post("/agent/chat/intro/stream", json={"message": ""})
    assert empty.status_code == 422

    oversized = client.post("/agent/chat/intro/stream", json={"message": "x" * 4001})
    assert oversized.status_code == 422
