import json

from hushh_mcp.services.agent_chat_service import AgentChatService


class _FakeResult:
    def __init__(self, data):
        self.data = data


def test_message_from_row_decrypts_metadata(monkeypatch):
    service = AgentChatService.__new__(AgentChatService)  # skip __init__/db

    def fake_decrypt(row, prefix):
        return row.get(f"{prefix}_plain", "")

    monkeypatch.setattr(service, "_decrypt_text", fake_decrypt)
    row = {
        "id": "m1",
        "conversation_id": "c1",
        "user_id": "u1",
        "role": "user",
        "status": "complete",
        "content_plain": "I selected: recipientUserId=x. Use exactly these ids.",
        "metadata_plain": json.dumps({"display": "Abdul Zalil · 8 hours", "kind": "selection"}),
        "metadata_ciphertext": "ct",  # presence signals metadata exists
    }
    message = service._message_from_row(row)
    assert message.content.startswith("I selected:")
    assert message.metadata == {"display": "Abdul Zalil · 8 hours", "kind": "selection"}


def test_message_from_row_metadata_none_when_absent(monkeypatch):
    service = AgentChatService.__new__(AgentChatService)
    monkeypatch.setattr(
        service, "_decrypt_text", lambda row, prefix: "hi" if prefix == "content" else ""
    )
    message = service._message_from_row({"id": "m2", "role": "assistant", "content_plain": "hi"})
    assert message.metadata is None
