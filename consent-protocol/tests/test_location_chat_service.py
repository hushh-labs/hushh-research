from hushh_mcp.services.location_chat_service import LocationChatService


class _Msg:
    def __init__(self, role: str, content: str) -> None:
        self.role = role
        self.content = content


class _Turn:
    def __init__(self, conversation_id: str, history: list) -> None:
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None) -> None:
        self.history = history or []
        self.added: list[dict] = []
        self.prepare_calls: list[dict] = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        self.prepare_calls.append(
            {"user_id": user_id, "message": message, "conversation_id": conversation_id}
        )
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append(
            {"conversation_id": conversation_id, "role": role, "content": content, "status": status}
        )


class _FakeAgent:
    def __init__(self, result) -> None:
        self.result = result
        self.calls: list[tuple] = []

    def handle_message(self, message, user_id, consent_token=""):
        self.calls.append((message, user_id, consent_token))
        return self.result


async def test_handle_turn_returns_camelcase_payload_and_persists_reply():
    store = _FakeStore()
    agent = _FakeAgent({"response": "Stopped sharing with Mom.", "is_complete": True})
    service = LocationChatService(agent=agent, chat_store=store)

    out = await service.handle_turn(
        user_id="user_123",
        message="stop sharing with Mom",
        consent_token="vault-token",  # noqa: S106
        conversation_id=None,
    )

    assert out == {
        "conversationId": "conv-new",
        "response": "Stopped sharing with Mom.",
        "isComplete": True,
        "stateChanged": True,
    }
    # consent token reaches the agent
    assert agent.calls[0][1] == "user_123"
    assert agent.calls[0][2] == "vault-token"
    # assistant reply persisted as complete
    assert store.added[0]["role"] == "assistant"
    assert store.added[0]["status"] == "complete"
    assert store.added[0]["content"] == "Stopped sharing with Mom."


async def test_handle_turn_folds_history_into_prompt():
    store = _FakeStore(history=[_Msg("user", "who can see me"), _Msg("assistant", "Mom and Dad.")])
    agent = _FakeAgent({"response": "ok", "is_complete": True})
    service = LocationChatService(agent=agent, chat_store=store)

    await service.handle_turn(
        user_id="u",
        message="stop the first one",
        consent_token="t",  # noqa: S106
        conversation_id="c1",
    )

    composed = agent.calls[0][0]
    assert "User: who can see me" in composed
    assert "Assistant: Mom and Dad." in composed
    assert "Latest user message:\nstop the first one" in composed


async def test_handle_turn_marks_error_without_state_change():
    store = _FakeStore()
    agent = _FakeAgent({"response": "I cannot complete that.", "error": "PermissionError"})
    service = LocationChatService(agent=agent, chat_store=store)

    out = await service.handle_turn(
        user_id="u",
        message="do something",
        consent_token="t",  # noqa: S106
    )

    assert out["stateChanged"] is False
    assert out["isComplete"] is False
    assert store.added[0]["status"] == "error"
