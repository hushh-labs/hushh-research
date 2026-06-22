from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import agent_chat
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    AgentChatConversation,
    AgentChatMessage,
    AgentRuntimeContractError,
    AgentRuntimeProviderError,
    PreparedAgentChatTurn,
    PreparedAgentRuntime,
)


class _FakeAgentChatService:
    def __init__(self):
        self.saved_messages: list[dict] = []
        self.next_action_plan: AgentChatActionPlan | None = None
        self.prepared_turns = 0
        self.runtime_contract_calls: list[dict] = []
        self.prepared_runtimes: list[dict] = []
        self.stream_action_plans: list[AgentChatActionPlan | None] = []
        self.stream_tokens = ["Hello", " from Gemini"]
        self.stream_error: Exception | None = None
        self.plan_error: Exception | None = None
        self.runtime_client = object()
        self.deleted = False
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

    def prepare_runtime_contract(
        self,
        *,
        runtime_credential: str | None = None,
        runtime_credential_mode: str | None = None,
    ):
        self.runtime_contract_calls.append(
            {
                "runtime_credential": runtime_credential,
                "runtime_credential_mode": runtime_credential_mode,
            }
        )
        if runtime_credential_mode == "byok" and not (runtime_credential or "").strip():
            raise AgentRuntimeContractError(
                error_code="AGENT_RUNTIME_CREDENTIAL_MISSING",
                message=(
                    "Kai needs your Gemini key to continue. Add or update it in "
                    "Profile > Runtime keys, or switch Kai to Hushh managed Gemini."
                ),
            )
        if runtime_credential_mode not in {None, "byok", "hushh_managed_vertex"}:
            raise AgentRuntimeContractError(
                error_code="AGENT_RUNTIME_MODE_INVALID",
                message="Agent runtime credential mode is invalid.",
            )
        return None

    async def prepare_agent_runtime(
        self,
        *,
        runtime_credential: str | None = None,
        runtime_credential_mode: str | None = None,
    ):
        self.prepare_runtime_contract(
            runtime_credential=runtime_credential,
            runtime_credential_mode=runtime_credential_mode,
        )
        self.prepared_runtimes.append(
            {
                "runtime_credential": runtime_credential,
                "runtime_credential_mode": runtime_credential_mode,
            }
        )
        return PreparedAgentRuntime(
            mode=runtime_credential_mode or "hushh_managed_vertex",
            provider="gemini",
            model="gemini-2.5-flash",
            credential_ref="pkm:runtime_secrets.llm.gemini_api_key",
            client=self.runtime_client,
            evidence={},
        )

    async def prepare_turn(self, *, user_id: str, message: str, conversation_id: str | None = None):
        assert user_id == "user-1"
        assert message == "Hello Agent"
        assert conversation_id is None
        self.prepared_turns += 1
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
        runtime_client,
        runtime_model: str,
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ):
        assert user_message == "Hello Agent"
        assert history == []
        assert runtime_client is self.runtime_client
        assert runtime_model == "gemini-2.5-flash"
        assert pkm_context in {None, "Saved domains: Financial"}
        self.stream_action_plans.append(action_plan)
        if self.stream_error is not None:
            raise self.stream_error
        for token in self.stream_tokens:
            yield token

    async def plan_action_with_gemini(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        runtime_client,
        runtime_model: str,
        pkm_context: str | None = None,
    ):
        assert user_message == "Hello Agent"
        assert history == []
        assert runtime_client is self.runtime_client
        assert runtime_model == "gemini-2.5-flash"
        assert pkm_context in {None, "Saved domains: Financial"}
        if self.plan_error is not None:
            raise self.plan_error
        return self.next_action_plan

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
        return [] if self.deleted else [self.conversation]

    async def get_conversation(self, conversation_id: str, *, user_id: str | None = None):
        if not self.deleted and conversation_id == "conversation-1" and user_id == "user-1":
            return self.conversation
        return None

    async def rename_conversation(self, conversation_id: str, *, user_id: str, title: str):
        if conversation_id != "conversation-1" or user_id != "user-1" or self.deleted:
            return None
        self.conversation.title = title
        self.conversation.updated_at = "2026-05-18T00:00:02+00:00"
        return self.conversation

    async def delete_conversation(self, conversation_id: str, *, user_id: str):
        if conversation_id != "conversation-1" or user_id != "user-1" or self.deleted:
            return False
        self.deleted = True
        return True

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
    assert service.runtime_contract_calls == [
        {
            "runtime_credential": None,
            "runtime_credential_mode": None,
        }
    ]
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


def test_agent_chat_stream_accepts_hushh_managed_runtime_mode_without_user_key(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={
            "user_id": "user-1",
            "message": "Hello Agent",
            "runtime_credential_mode": "hushh_managed_vertex",
        },
    )

    assert response.status_code == 200
    assert service.prepared_turns == 1
    assert service.runtime_contract_calls == [
        {
            "runtime_credential": None,
            "runtime_credential_mode": "hushh_managed_vertex",
        }
    ]


def test_agent_chat_stream_rejects_byok_without_runtime_credential(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={
            "user_id": "user-1",
            "message": "Hello Agent",
            "runtime_credential_mode": "byok",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == {
        "code": "AGENT_RUNTIME_CREDENTIAL_MISSING",
        "message": (
            "Kai needs your Gemini key to continue. Add or update it in "
            "Profile > Runtime keys, or switch Kai to Hushh managed Gemini."
        ),
    }
    assert service.prepared_turns == 0
    assert service.saved_messages == []


def test_agent_chat_stream_rejects_invalid_runtime_mode_without_leaking_key(
    monkeypatch,
    caplog,
):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)
    raw_key = "USER_GEMINI_KEY_SHOULD_NOT_LEAK"

    response = client.post(
        "/agent/chat/stream",
        json={
            "user_id": "user-1",
            "message": "Hello Agent",
            "runtime_credential": raw_key,
            "runtime_credential_mode": "unsupported",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == {
        "code": "AGENT_RUNTIME_MODE_INVALID",
        "message": "Agent runtime credential mode is invalid.",
    }
    assert raw_key not in response.text
    assert raw_key not in caplog.text
    assert service.prepared_turns == 0
    assert service.saved_messages == []


def test_agent_chat_stream_saves_short_frontend_action_receipt(monkeypatch):
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
    assert 'event: token\ndata: {"token": "Starting Kai analysis for NVDA."}' in response.text
    assert service.stream_action_plans == []
    assert [message["role"] for message in service.saved_messages] == ["assistant"]
    assert service.saved_messages[0]["content"] == "Starting Kai analysis for NVDA."


def test_agent_chat_stream_does_not_stream_long_text_for_navigation_action(monkeypatch):
    service = _FakeAgentChatService()
    service.stream_tokens = ["This is a long generic Gemini navigation explanation."]
    service.next_action_plan = AgentChatActionPlan(
        call_id="tool_test_2",
        action_id="route.consents",
        label="Open Consent Center",
        execution="frontend",
        slots={},
        message="Open Consent Center in the app.",
    )
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={"user_id": "user-1", "message": "Hello Agent"},
    )

    assert response.status_code == 200
    assert 'event: tool_waiting\ndata: {"call_id": "tool_test_2"' in response.text
    assert 'event: token\ndata: {"token": "Open Consent Center in the app."}' in response.text
    assert "long generic Gemini" not in response.text
    assert service.stream_action_plans == []
    assert service.saved_messages[0]["content"] == "Open Consent Center in the app."


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


def test_agent_chat_stream_saves_error_message_when_stream_fails_before_tokens(monkeypatch):
    service = _FakeAgentChatService()
    service.stream_error = RuntimeError("Gemini unavailable")
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={"user_id": "user-1", "message": "Hello Agent"},
    )

    assert response.status_code == 200
    assert 'event: error\ndata: {"message": "Agent chat failed. Please try again."' in response.text
    assert service.saved_messages == [
        {
            "conversation_id": "conversation-1",
            "user_id": "user-1",
            "role": "assistant",
            "content": "Agent chat failed. Please try again.",
            "status": "error",
            "model": "gemini-2.5-pro",
            "error_code": "AGENT_CHAT_STREAM_FAILED",
        }
    ]


def test_agent_chat_stream_saves_safe_runtime_provider_error(monkeypatch):
    service = _FakeAgentChatService()
    service.stream_error = AgentRuntimeProviderError(
        error_code="AGENT_RUNTIME_CREDENTIAL_INVALID",
        message=(
            "Your saved Gemini key could not be used. Update it in Profile > Runtime keys "
            "or switch Kai to Hushh managed Gemini."
        ),
        detail={"likely_issue": "invalid_or_unauthorized_api_key"},
    )
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.post(
        "/agent/chat/stream",
        json={
            "user_id": "user-1",
            "message": "Hello Agent",
            "runtime_credential_mode": "byok",
            "runtime_credential": "BAD_KEY_SHOULD_NOT_LEAK",
        },
    )

    assert response.status_code == 200
    assert '"code": "AGENT_RUNTIME_CREDENTIAL_INVALID"' in response.text
    assert "Your saved Gemini key could not be used." in response.text
    assert "BAD_KEY_SHOULD_NOT_LEAK" not in response.text
    assert service.saved_messages == [
        {
            "conversation_id": "conversation-1",
            "user_id": "user-1",
            "role": "assistant",
            "content": (
                "Your saved Gemini key could not be used. Update it in Profile > Runtime keys "
                "or switch Kai to Hushh managed Gemini."
            ),
            "status": "error",
            "model": "gemini-2.5-pro",
            "error_code": "AGENT_RUNTIME_CREDENTIAL_INVALID",
        }
    ]


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


async def test_agent_chat_stream_saves_non_empty_interrupted_fallback(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)

    class _DisconnectingRequest:
        async def is_disconnected(self):
            return True

    response = await agent_chat.stream_agent_chat(
        _DisconnectingRequest(),
        agent_chat.AgentChatStreamRequest(user_id="user-1", message="Hello Agent"),
        {"user_id": "user-1", "scope": "vault.owner"},
    )
    chunks: list[str] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)

    stream_text = "".join(chunks)
    assert "event: token" not in stream_text
    assert "event: complete" not in stream_text
    assert service.saved_messages == [
        {
            "conversation_id": "conversation-1",
            "user_id": "user-1",
            "role": "assistant",
            "content": "Agent response was interrupted before it could finish.",
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


def test_agent_chat_renames_conversation(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.patch(
        "/agent/chat/conversations/conversation-1",
        json={"title": "Renamed Kai analysis"},
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Renamed Kai analysis"
    assert service.conversation.title == "Renamed Kai analysis"


def test_agent_chat_deletes_conversation(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service)

    response = client.delete("/agent/chat/conversations/conversation-1")

    assert response.status_code == 200
    assert response.json() == {"conversation_id": "conversation-1", "deleted": True}
    assert service.deleted is True


def test_agent_chat_rename_and_delete_return_not_found_for_other_user(monkeypatch):
    service = _FakeAgentChatService()
    monkeypatch.setattr(agent_chat, "get_agent_chat_service", lambda: service)
    client = _client(service, user_id="other-user")

    renamed = client.patch(
        "/agent/chat/conversations/conversation-1",
        json={"title": "Nope"},
    )
    deleted = client.delete("/agent/chat/conversations/conversation-1")

    assert renamed.status_code == 404
    assert deleted.status_code == 404
