import base64
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services.direct_messages_service import (
    DirectMessageCipher,
    DirectMessagesError,
    DirectMessagesService,
)

_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111"
_MESSAGE_ID = "22222222-2222-4222-8222-222222222222"


class _Cipher:
    def __init__(self):
        self.sealed: list[tuple[str, dict]] = []

    def seal(self, content, **kwargs):
        self.sealed.append((content, kwargs))
        return {
            "content_ciphertext": "opaque-ciphertext",
            "content_iv": "opaque-iv",
            "content_algorithm": "aes-256-gcm-aad-v1",
        }

    def open(self, _row):
        return "decrypted text"


def _service(cipher=None):
    # No engine deliberately exercises the service's lightweight unit seam;
    # production paths use one Cloud SQL transaction/graph lock.
    return DirectMessagesService(
        db=SimpleNamespace(),
        cipher=cipher or _Cipher(),
        event_notifier=lambda *_args, **_kwargs: None,
        push_notifier=lambda *_args, **_kwargs: None,
    )


def _conversation(can_send=True):
    return {
        "id": _CONVERSATION_ID,
        "participant_a_user_id": "alice",
        "participant_b_user_id": "bob",
        "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "last_message_at": datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
        "peer_person_ref": "33333333-3333-4333-8333-333333333333",
        "peer_display_name": "Bob",
        "peer_photo_url": None,
        "can_send": can_send,
    }


def _message():
    return {
        "id": _MESSAGE_ID,
        "conversation_id": _CONVERSATION_ID,
        "sender_user_id": "alice",
        "content_ciphertext": "opaque-ciphertext",
        "content_iv": "opaque-iv",
        "content_algorithm": "aes-256-gcm-aad-v1",
        "created_at": datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
        "read_at": None,
    }


def test_cipher_seals_and_opens_without_plaintext_persistence(monkeypatch):
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1",
        base64.urlsafe_b64encode(b"m" * 32).decode("ascii"),
    )
    cipher = DirectMessageCipher()
    sealed = cipher.seal(
        "hello private world",
        conversation_id=_CONVERSATION_ID,
        message_id=_MESSAGE_ID,
        sender_user_id="alice",
    )
    assert "hello private world" not in sealed["content_ciphertext"]
    assert (
        cipher.open(
            {
                "id": _MESSAGE_ID,
                "conversation_id": _CONVERSATION_ID,
                "sender_user_id": "alice",
                **sealed,
            }
        )
        == "hello private world"
    )


def test_cipher_fails_closed_when_storage_key_is_missing(monkeypatch):
    monkeypatch.delenv("DIRECT_MESSAGE_ENCRYPTION_KEY_V1", raising=False)
    with pytest.raises(DirectMessagesError) as caught:
        DirectMessageCipher().seal(
            "hello",
            conversation_id=_CONVERSATION_ID,
            message_id=_MESSAGE_ID,
            sender_user_id="alice",
        )
    assert caught.value.code == "DIRECT_MESSAGE_STORAGE_UNAVAILABLE"


def test_send_rejects_self_and_empty_messages_before_a_database_write():
    service = _service()
    with pytest.raises(DirectMessagesError) as caught:
        service.send_message("alice", recipient_user_id="alice", content="hello")
    assert caught.value.code == "DIRECT_MESSAGE_NO_SELF"

    with pytest.raises(DirectMessagesError) as caught:
        service.send_message("alice", recipient_user_id="bob", content=" \n ")
    assert caught.value.code == "DIRECT_MESSAGE_EMPTY"


def test_send_requires_current_accepted_connection_and_never_reaches_insert(monkeypatch):
    service = _service()
    inserted = []
    monkeypatch.setattr(
        service,
        "_require_active_connection",
        lambda *_args: (_ for _ in ()).throw(
            DirectMessagesError(
                "DIRECT_MESSAGE_CONNECTION_REQUIRED",
                "You can only message an accepted connection.",
                status_code=403,
            )
        ),
    )
    monkeypatch.setattr(
        service, "_execute_one", lambda sql, *_args, **_kwargs: inserted.append(sql)
    )

    with pytest.raises(DirectMessagesError) as caught:
        service.send_message("alice", recipient_user_id="bob", content="hello")

    assert caught.value.code == "DIRECT_MESSAGE_CONNECTION_REQUIRED"
    assert inserted == []


def test_send_encrypts_content_and_returns_a_participant_safe_projection(monkeypatch):
    cipher = _Cipher()
    service = _service(cipher)
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(service, "_require_active_connection", lambda *_args: "connection-id")
    monkeypatch.setattr(service, "_conversation_by_pair", lambda *_args: _conversation())

    def execute_one(sql, params=None):
        calls.append((sql, params or {}))
        if "SELECT id\n                    FROM conversations" in sql:
            return {"id": _CONVERSATION_ID}
        if "INSERT INTO messages" in sql:
            return _message()
        return None

    monkeypatch.setattr(service, "_execute_one", execute_one)

    result = service.send_message("alice", recipient_user_id="bob", content="  hello Bob  ")

    assert cipher.sealed[0][0] == "hello Bob"
    message_insert_params = next(params for sql, params in calls if "INSERT INTO messages" in sql)
    assert message_insert_params["content_ciphertext"] == "opaque-ciphertext"
    assert "content" not in message_insert_params
    assert result["message"]["content"] == "decrypted text"
    assert result["message"]["senderIsViewer"] is True
    assert "senderUserId" not in result["message"]
    assert "_peerUserId" not in result["conversation"]


def test_history_is_readable_but_reported_read_only_after_disconnect(monkeypatch):
    service = _service()
    monkeypatch.setattr(
        service, "_conversation_for_participant", lambda *_args: _conversation(False)
    )
    monkeypatch.setattr(service, "_execute_many", lambda *_args, **_kwargs: [_message()])

    result = service.list_messages("alice", _CONVERSATION_ID)

    assert result["items"][0]["content"] == "decrypted text"
    assert result["canSend"] is False
    assert result["disconnectedNotice"] is True


def test_active_connection_query_also_requires_no_direct_message_block(monkeypatch):
    service = _service()
    captured = {}

    def execute_one(sql, params=None):
        captured["sql"] = sql
        captured["params"] = params
        return {"id": "connection-id"}

    monkeypatch.setattr(service, "_execute_one", execute_one)
    assert service._active_connection_id("alice", "bob") == "connection-id"
    assert "direct_message_blocks" in captured["sql"]
    assert captured["params"] == {"sender_user_id": "alice", "recipient_user_id": "bob"}


def test_block_requires_an_existing_relationship_and_persists_a_directed_row(monkeypatch):
    service = _service()
    monkeypatch.setattr(service, "_message_relationship_exists", lambda *_args: True)
    calls = []

    def execute_one(sql, params=None):
        calls.append((sql, params or {}))
        if "SELECT id, created_at\n                    FROM direct_message_blocks" in sql:
            return {
                "id": "44444444-4444-4444-8444-444444444444",
                "created_at": "2026-01-01T00:00:00Z",
            }
        return None

    monkeypatch.setattr(service, "_execute_one", execute_one)
    result = service.block_user("alice", blocked_user_id="bob")

    assert result["blocked"] is True
    assert any("INSERT INTO direct_message_blocks" in sql for sql, _ in calls)
