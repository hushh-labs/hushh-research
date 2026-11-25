"""Conversation-link custody, viewer binding and legacy-key retirement."""

import base64

import pytest

from hushh_mcp.services.direct_messages_service import DirectMessageCipher, DirectMessagesError

_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111"


def test_route_cipher_randomized_and_bound_to_viewer(monkeypatch):
    from hushh_mcp.services.direct_message_route_cipher import DirectMessageRouteCipher

    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"r" * 32).decode()
    )
    cipher = DirectMessageRouteCipher()
    token = cipher.seal("alice", "conversation", _CONVERSATION_ID)
    assert _CONVERSATION_ID not in token
    assert token != cipher.seal("alice", "conversation", _CONVERSATION_ID)
    assert cipher.open("alice", token) == ("conversation", _CONVERSATION_ID)
    with pytest.raises(DirectMessagesError):
        cipher.open("bob", token)
    with pytest.raises(DirectMessagesError):
        cipher.open("alice", token[:12] + ("A" if token[12] != "A" else "B") + token[13:])
    person = cipher.seal("alice", "person", "person-ref")
    assert cipher.open("alice", person) == ("person", "person-ref")
    monkeypatch.delenv("DIRECT_MESSAGE_ENCRYPTION_KEY_V1")
    with pytest.raises(DirectMessagesError) as exc:
        cipher.open("alice", token)
    assert exc.value.status_code == 503


def test_existing_conversation_links_survive_retiring_message_key(monkeypatch):
    from hushh_mcp.services.direct_message_route_cipher import DirectMessageRouteCipher

    monkeypatch.delenv("DIRECT_MESSAGE_ROUTE_KEY_V1", raising=False)
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"m" * 32).decode()
    )
    cipher = DirectMessageRouteCipher()
    existing = cipher.seal("alice", "conversation", _CONVERSATION_ID)
    preserved_key = cipher._key()
    message = DirectMessageCipher().seal(
        "Synthetic historical content",
        conversation_id=_CONVERSATION_ID,
        message_id="historical-message",
        sender_user_id="alice",
    )
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ROUTE_KEY_V1", base64.urlsafe_b64encode(preserved_key).decode()
    )
    monkeypatch.delenv("DIRECT_MESSAGE_ENCRYPTION_KEY_V1")
    assert cipher.open("alice", existing) == ("conversation", _CONVERSATION_ID)
    assert cipher.open("alice", cipher.seal("alice", "person", "person-ref")) == (
        "person",
        "person-ref",
    )
    with pytest.raises(DirectMessagesError):
        cipher.open("bob", existing)
    with pytest.raises(DirectMessagesError) as exc:
        DirectMessageCipher().open(
            {
                **message,
                "conversation_id": _CONVERSATION_ID,
                "id": "historical-message",
                "sender_user_id": "alice",
            }
        )
    assert exc.value.status_code == 503


@pytest.mark.parametrize(
    "configured", ["", "invalid!", base64.urlsafe_b64encode(b"short").decode()]
)
def test_bad_dedicated_route_key_does_not_fall_back_to_message_key(monkeypatch, configured):
    from hushh_mcp.services.direct_message_route_cipher import DirectMessageRouteCipher

    monkeypatch.setenv("DIRECT_MESSAGE_ROUTE_KEY_V1", configured)
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"m" * 32).decode()
    )
    with pytest.raises(DirectMessagesError) as exc:
        DirectMessageRouteCipher().seal("alice", "conversation", _CONVERSATION_ID)
    assert exc.value.status_code == 503
    assert exc.value.code == "DIRECT_MESSAGE_ROUTE_UNAVAILABLE"
