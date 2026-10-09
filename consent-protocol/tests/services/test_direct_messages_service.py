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


def _service(cipher=None, feed_notifier=None):
    # No engine deliberately exercises the service's lightweight unit seam;
    # production paths use one Cloud SQL transaction/graph lock.
    return DirectMessagesService(
        db=SimpleNamespace(),
        cipher=cipher or _Cipher(),
        event_notifier=lambda *_args, **_kwargs: None,
        push_notifier=lambda *_args, **_kwargs: None,
        feed_notifier=feed_notifier or (lambda *_args, **_kwargs: None),
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
        "viewer_display_name": "Alice",
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
    feed_events = []
    service = _service(
        cipher,
        feed_notifier=lambda recipient, **event: feed_events.append((recipient, event)),
    )
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
    assert feed_events == [
        (
            "bob",
            {
                "actor_label": "Alice",
                "conversation_id": _CONVERSATION_ID,
                "message_id": _MESSAGE_ID,
            },
        )
    ]


def test_send_persists_a_reply_only_after_the_target_is_checked_in_the_same_conversation(
    monkeypatch,
):
    cipher = _Cipher()
    service = _service(cipher)
    reply_id = "33333333-3333-4333-8333-333333333333"
    reply_row = {**_action_message(sender_user_id="bob"), "id": reply_id}
    sent_row = {
        **_action_message(),
        "id": "44444444-4444-4444-8444-444444444444",
        "reply_to_message_id": reply_id,
    }
    calls: list[tuple[str, dict]] = []

    monkeypatch.setattr(service, "_require_active_connection", lambda *_args: "connection-id")
    monkeypatch.setattr(service, "_conversation_by_pair", lambda *_args: _conversation())
    monkeypatch.setattr(
        service,
        "_message_for_participant",
        lambda viewer, conversation_id, message_id: (
            reply_row
            if (viewer, conversation_id, message_id) == ("alice", _CONVERSATION_ID, reply_id)
            else None
        ),
    )

    def execute_one(sql, params=None):
        calls.append((sql, params or {}))
        if "SELECT id\n                    FROM conversations" in sql:
            return {"id": _CONVERSATION_ID}
        if "INSERT INTO messages" in sql:
            return sent_row
        return None

    monkeypatch.setattr(service, "_execute_one", execute_one)

    result = service.send_message(
        "alice",
        recipient_user_id="bob",
        content="I agree",
        reply_to_message_id=reply_id,
    )

    insert_params = next(params for sql, params in calls if "INSERT INTO messages" in sql)
    assert insert_params["reply_to_message_id"] == reply_id
    assert result["message"]["replyTo"] == {
        "id": reply_id,
        "content": "decrypted text",
        "senderIsViewer": False,
        "deletedForEveryoneAt": None,
    }


def test_send_reply_returns_a_projection_when_insert_row_lacks_joined_reply_envelope(
    monkeypatch,
):
    """A reply acknowledgement must not decrypt fields INSERT RETURNING lacks."""
    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1",
        base64.urlsafe_b64encode(b"r" * 32).decode("ascii"),
    )
    cipher = DirectMessageCipher()
    service = _service(cipher)
    reply_id = "33333333-3333-4333-8333-333333333333"
    sent_id = "44444444-4444-4444-8444-444444444444"
    reply_row = {
        **_action_message(sender_user_id="bob"),
        "id": reply_id,
        **cipher.seal(
            "Original message",
            conversation_id=_CONVERSATION_ID,
            message_id=reply_id,
            sender_user_id="bob",
        ),
    }
    sent_row = {
        **_action_message(),
        "id": sent_id,
        "reply_to_message_id": reply_id,
        **cipher.seal(
            "I agree",
            conversation_id=_CONVERSATION_ID,
            message_id=sent_id,
            sender_user_id="alice",
        ),
    }

    monkeypatch.setattr(service, "_require_active_connection", lambda *_args: "connection-id")
    monkeypatch.setattr(service, "_conversation_by_pair", lambda *_args: _conversation())
    monkeypatch.setattr(service, "_message_for_participant", lambda *_args: reply_row)
    monkeypatch.setattr(
        service,
        "_execute_one",
        lambda sql, *_args, **_kwargs: (
            {"id": _CONVERSATION_ID}
            if "SELECT id\n                    FROM conversations" in sql
            else sent_row
            if "INSERT INTO messages" in sql
            else None
        ),
    )

    result = service.send_message(
        "alice",
        recipient_user_id="bob",
        content="I agree",
        reply_to_message_id=reply_id,
    )

    assert result["message"]["content"] == "I agree"
    assert result["message"]["replyTo"] == {
        "id": reply_id,
        "content": "Original message",
        "senderIsViewer": False,
        "deletedForEveryoneAt": None,
    }


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


def _action_message(*, sender_user_id="alice", deleted_for_everyone_at=None):
    return {
        **_message(),
        "sender_user_id": sender_user_id,
        "edited_at": None,
        "reply_to_message_id": None,
        "deleted_for_sender_at": None,
        "deleted_for_recipient_at": None,
        "deleted_for_everyone_at": deleted_for_everyone_at,
        "participant_a_user_id": "alice",
        "participant_b_user_id": "bob",
        "reactions": [],
    }


def test_sender_only_actions_reject_a_participant_who_did_not_send_the_message(monkeypatch):
    service = _service()
    monkeypatch.setattr(
        service,
        "_message_action_row",
        lambda *_args: _action_message(sender_user_id="bob"),
    )
    monkeypatch.setattr(
        service,
        "_execute_one",
        lambda *_args, **_kwargs: pytest.fail("unauthorized action reached a database write"),
    )

    with pytest.raises(DirectMessagesError) as caught:
        service.edit_message("alice", _CONVERSATION_ID, _MESSAGE_ID, content="edited")

    assert caught.value.code == "DIRECT_MESSAGE_ACTION_FORBIDDEN"


def test_edit_reencrypts_and_reaction_is_persisted_for_the_authenticated_participant(monkeypatch):
    cipher = _Cipher()
    service = _service(cipher)
    action_row = _action_message()
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(service, "_message_action_row", lambda *_args: action_row)

    def execute_one(sql, params=None):
        calls.append((sql, params or {}))
        if "UPDATE messages" in sql:
            return {"id": _MESSAGE_ID}
        if "INSERT INTO direct_message_reactions" in sql:
            return {"message_id": _MESSAGE_ID}
        return None

    monkeypatch.setattr(service, "_execute_one", execute_one)

    edited = service.edit_message("alice", _CONVERSATION_ID, _MESSAGE_ID, content="updated")
    reacted = service.react_to_message("alice", _CONVERSATION_ID, _MESSAGE_ID, emoji="👍")

    assert cipher.sealed == [
        (
            "updated",
            {
                "conversation_id": _CONVERSATION_ID,
                "message_id": _MESSAGE_ID,
                "sender_user_id": "alice",
            },
        )
    ]
    assert edited["message"]["content"] == "decrypted text"
    assert reacted["message"]["content"] == "decrypted text"
    edit_params = next(params for sql, params in calls if "UPDATE messages" in sql)
    reaction_params = next(
        params for sql, params in calls if "INSERT INTO direct_message_reactions" in sql
    )
    assert edit_params["content_ciphertext"] == "opaque-ciphertext"
    assert "content" not in edit_params
    assert reaction_params == {
        "message_id": _MESSAGE_ID,
        "viewer_user_id": "alice",
        "emoji": "👍",
    }


def test_reaction_adds_a_distinct_emoji_without_replacing_existing_reactions(monkeypatch):
    service = _service()
    action_row = _action_message()
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(service, "_message_action_row", lambda *_args: action_row)

    def execute_one(sql, params=None):
        calls.append((sql, params or {}))
        return None

    monkeypatch.setattr(service, "_execute_one", execute_one)

    service.react_to_message("alice", _CONVERSATION_ID, _MESSAGE_ID, emoji="❤️")

    reaction_sql, reaction_params = next(
        (sql, params) for sql, params in calls if "INSERT INTO direct_message_reactions" in sql
    )
    assert "ON CONFLICT (message_id, user_id, emoji)" in reaction_sql
    assert reaction_params["emoji"] == "❤️"


def test_delete_for_me_uses_the_viewers_participant_visibility_field(monkeypatch):
    service = _service()
    calls: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        service,
        "_message_action_row",
        lambda *_args: _action_message(sender_user_id="alice"),
    )
    monkeypatch.setattr(
        service,
        "_execute_one",
        lambda sql, params=None: calls.append((sql, params or {})) or {"id": _MESSAGE_ID},
    )

    result = service.delete_message("bob", _CONVERSATION_ID, _MESSAGE_ID, scope="me")

    assert result == {"scope": "me", "message": None}
    assert "SET deleted_for_recipient_at = NOW()" in calls[0][0]


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
