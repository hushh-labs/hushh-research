from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import agent_chat
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    AgentChatConversation,
    AgentChatMessage,
    PreparedAgentChatTurn,
)


class _FakeAgentChatService:
    def __init__(self):
        self.saved_messages: list[dict] = []
        self.next_action_plan: AgentChatActionPlan | None = None
        self.stream_action_plans: list[AgentChatActionPlan | None] = []
        self.stream_tokens = ["Hello", " from Gemini"]
        self.conversation = AgentChatConversation(
            id="conversation-1",
            user_id="user-1",
            title="First prompt",
            status="active",
            model="gemini-2.5-pro",
            message_count=2,
            created_at="2026-05-18T00:00:00+00:00",
            updated_at="2026-05-18T00:00:01+00:00",
            last_message_at="2026-05-18T00:00:01+00:00",
        )
        self.history = [
            AgentChatMessage(
                id="message-user-1",
                conversation_id="conversation-1",
                user_id="user-1",
                role="user",
                status="complete",
                content="Hello",
                model=None,
                created_at="2026-05-18T00:00:00+00:00",
                completed_at="2026-05-18T00:00:00+00:00",
            ),
            AgentChatMessage(
                id="message-assistant-1",
                conversation_id="conversation-1",
                user_id="user-1",
                role="assistant",
                status="complete",
                content="Hi there",
                model="gemini-2.5-pro",
                created_at="2026-05-18T00:00:01+00:00",
                completed_at="2026-05-18T00:00:01+00:00",
            ),
        ]

    async def prepare_turn(self, *, user_id: str, message: str, conversation_id: str | None = None):
        assert user_id == "user-1"
        assert message == "Hello Agent"
        assert conversation_id is None
        return PreparedAgentChatTurn(
            conversation_id="conversation-1",
            user_message_id="message-user-2",
            history=[],
            model="gemini-2.5-pro",
        )

    async def stream_response(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        action_plan: AgentChatActionPlan | None = None,
    ):
        assert user_message == "Hello Agent"
        assert history == []
        self.stream_action_plans.append(action_plan)
        for token in self.stream_tokens:
            yield token

    def plan_action(self, message: str):
        assert message == "Hello Agent"
        return self.next_action_plan

    async def add_message(self, **kwargs):
        self.saved_messages.append(kwargs)
        return AgentChatMessage(
            id=f"saved-{len(self.saved_messages)}",
            conversation_id=kwargs["conversation_id"],
            user_id=kwargs["user_id"],
            role=kwargs["role"],
            status=kwargs["status"],
            content=kwargs["content"],
            model=kwargs.get("model"),
            created_at=None,
            completed_at=None,
        )

    async def list_conversations(self, user_id: str, *, limit: int = 5):
        assert user_id == "user-1"
        assert limit == 1
        return [self.conversation]

    async def get_conversation(self, conversation_id: str, *, user_id: str | None = None):
        if conversation_id == "conversation-1" and user_id == "user-1":
            return self.conversation
        return None

    async def get_recent_messages(self, conversation_id: str, *, user_id: str, limit: int = 50):
        assert conversation_id == "conversation-1"
        assert user_id == "user-1"
        assert limit == 50
        return self.history


def _client(service: _FakeAgentChatService, user_id: str = "user-1") -> TestClient:
    app = FastAPI()
    app.include_router(agent_chat.router)
    app.dependency_overrides[agent_chat.require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "scope": "vault.owner",
    }
    return TestClient(app)


def test_agent_chat_stream_sends_token_events_and_saves_assistant(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={"user_id": "user-1", "message": "Hello Agent"},
    )

    assert response.status_code == 200
    assert response.headers["x-agent-conversation-id"] == "conversation-1"
    assert response.headers["x-agent-model"] == "gemini-2.5-pro"
    assert 'event: token\ndata: {"token": "Hello"}' in response.text
    assert 'event: token\ndata: {"token": " from Gemini"}' in response.text
    assert 'event: complete\ndata: {"conversation_id": "conversation-1"' in response.text
    assert service.stream_action_plans == [None]
    assert service.saved_messages == [
        {
            "conversation_id": "conversation-1",
            "user_id": "user-1",
            "role": "assistant",
            "content": "Hello from Gemini",
            "status": "complete",
            "model": "gemini-2.5-pro",
            "error_code": None,
        }
    ]


def test_agent_chat_stream_sends_live_tool_events_without_saving_tool_messages(monkeypatch):
    service = _FakeAgentChatService()
    service.next_action_plan = AgentChatActionPlan(
        call_id="tool_test_1",
        action_id="analysis.start",
        label="Start analysis for NVDA",
        execution="frontend",
        slots={"symbol": "NVDA"},
        message="Starting Kai analysis for NVDA.",
    )
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={"user_id": "user-1", "message": "Hello Agent"},
    )

    assert response.status_code == 200
    assert 'event: tool_start\ndata: {"call_id": "tool_test_1"' in response.text
    assert '"action_id": "analysis.start"' in response.text
    assert '"slots": {"symbol": "NVDA"}' in response.text
    assert 'event: tool_waiting\ndata: {"call_id": "tool_test_1"' in response.text
    assert '"status": "waiting_for_frontend"' in response.text
    assert service.stream_action_plans == [service.next_action_plan]
    assert [message["role"] for message in service.saved_messages] == ["assistant"]
    assert service.saved_messages[0]["content"] == "Hello from Gemini"


def test_agent_chat_stream_does_not_save_empty_assistant_message(monkeypatch):
    service = _FakeAgentChatService()
    service.stream_tokens = []
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={"user_id": "user-1", "message": "Hello Agent"},
    )

    assert response.status_code == 200
    assert 'event: complete\ndata: {"conversation_id": "conversation-1"' in response.text
    assert service.saved_messages == []


async def test_agent_chat_stream_saves_partial_interrupted_response(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    class _DisconnectingRequest:
        def __init__(self):
            self.calls = 0

        async def is_disconnected(self):
            self.calls += 1
            return self.calls >= 2

    response = await agent_chat.stream_agent_chat(
        _DisconnectingRequest(),
        agent_chat.AgentChatStreamRequest(user_id="user-1", message="Hello Agent"),
        {"user_id": "user-1", "scope": "vault.owner"},
    )
    chunks: list[str] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)

    stream_text = "".join(chunks)
    assert 'event: token\ndata: {"token": "Hello"}' in stream_text
    assert "event: complete" not in stream_text
    assert service.saved_messages == [
        {
            "conversation_id": "conversation-1",
            "user_id": "user-1",
            "role": "assistant",
            "content": "Hello",
            "status": "interrupted",
            "model": "gemini-2.5-pro",
            "error_code": None,
        }
    ]


def test_agent_chat_stream_rejects_token_user_mismatch(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service, user_id="other-user")

    response = client.post(
        "/agent/chat/stream",
        json={"user_id": "user-1", "message": "Hello Agent"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Token user_id does not match request user_id"
    assert service.saved_messages == []


def test_agent_chat_recent_conversation_and_history(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    conversations = client.get("/agent/chat/conversations/user-1?limit=1")
    history = client.get("/agent/chat/history/conversation-1")

    assert conversations.status_code == 200
    assert conversations.json()["conversations"][0]["title"] == "First prompt"
    assert history.status_code == 200
    assert [message["content"] for message in history.json()["messages"]] == [
        "Hello",
        "Hi there",
    ]
