from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one.messages import _direct_message_event, router
from hushh_mcp.services.direct_messages_service import DirectMessagesError


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "viewer-user"
    return TestClient(app)


def test_delete_chat_binds_the_authenticated_participant_and_requires_a_valid_id():
    service = MagicMock()
    conversation = "11111111-1111-4111-8111-111111111111"
    service.delete_conversation.return_value = {
        "conversationId": conversation,
        "deleted": True,
        "scope": "me",
    }
    with patch("api.routes.one.messages._service", return_value=service):
        response = _client().delete(f"/api/one/messages/conversations/{conversation}?userId=forged")
        assert response.status_code == 200
        assert response.json() == service.delete_conversation.return_value
        assert response.headers["cache-control"] == "private, no-store"
        service.delete_conversation.assert_called_once_with("viewer-user", conversation)
        assert _client().delete("/api/one/messages/conversations/invalid").status_code == 422
        service.delete_conversation.side_effect = DirectMessagesError(
            "DIRECT_MESSAGE_CONVERSATION_NOT_FOUND", "Conversation was not found.", status_code=404
        )
        assert (
            _client().delete(f"/api/one/messages/conversations/{conversation}").status_code == 404
        )
    app = FastAPI()
    app.include_router(router)
    assert (
        TestClient(app).delete(f"/api/one/messages/conversations/{conversation}").status_code == 401
    )


def test_unread_count_uses_authenticated_owner_and_returns_only_private_count_metadata():
    with patch("api.routes.one.messages.unread_message_count", return_value=137) as count:
        response = _client().get("/api/one/messages/unread-count?userId=another-user")
    count.assert_called_once_with("viewer-user")
    assert response.status_code == 200
    assert response.json() == {"unreadCount": 137}
    assert response.headers["cache-control"] == "private, no-store"


def test_unread_count_rejects_unauthenticated_reads_and_does_not_claim_zero_on_failure():
    app = FastAPI()
    app.include_router(router)
    with patch("api.routes.one.messages.unread_message_count") as count:
        response = TestClient(app).get("/api/one/messages/unread-count")
    assert response.status_code == 401
    count.assert_not_called()
    with patch(
        "api.routes.one.messages.unread_message_count", side_effect=RuntimeError("private details")
    ):
        failed = _client().get("/api/one/messages/unread-count")
    assert failed.status_code == 500
    assert "unreadCount" not in failed.json()
    assert "private details" not in failed.text


def test_send_person_ref_threads_authenticated_sender_and_never_accepts_a_peer_uid_response():
    service = MagicMock()
    service.send_message.return_value = {
        "conversation": {"id": "conversation-1", "peerPersonRef": "person-1", "canSend": True},
        "message": {"id": "message-1", "senderIsViewer": True, "content": "hello"},
    }
    with patch("api.routes.one.messages._service", return_value=service):
        response = _client().post(
            "/api/one/messages",
            json={
                "recipientPersonRef": "11111111-1111-4111-8111-111111111111",
                "content": "hello",
                "replyToMessageId": "22222222-2222-4222-8222-222222222222",
            },
        )

    assert response.status_code == 200
    assert response.json()["message"]["senderIsViewer"] is True
    service.send_message.assert_called_once_with(
        "viewer-user",
        content="hello",
        recipient_user_id=None,
        recipient_person_ref="11111111-1111-4111-8111-111111111111",
        reply_to_message_id="22222222-2222-4222-8222-222222222222",
        client_message_id=None,
        attachment=None,
    )


def test_delivery_acknowledgment_binds_the_authenticated_recipient_and_bounds_private_input():
    service = MagicMock()
    service.acknowledge_delivery.return_value = {
        "deliveredCount": 1,
        "deliveredAt": "2026-10-13T10:00:00Z",
    }
    conversation = "11111111-1111-4111-8111-111111111111"
    message = "22222222-2222-4222-8222-222222222222"
    with patch("api.routes.one.messages._service", return_value=service):
        client = _client()
        response = client.post(
            f"/api/one/messages/conversations/{conversation}/delivered",
            json={"messageIds": [message], "viewerUserId": "forged-owner"},
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        service.acknowledge_delivery.assert_called_once_with(
            "viewer-user", conversation, message_ids=[message]
        )
        for ids in ([], [message] * 101, ["private-invalid-id"]):
            invalid = client.post(
                f"/api/one/messages/conversations/{conversation}/delivered",
                json={"messageIds": ids},
            )
            assert invalid.status_code == 422
            assert invalid.json() == {"detail": "Invalid message request."}
        assert service.acknowledge_delivery.call_count == 1


def test_attachment_send_and_read_keep_authenticated_identity_and_private_bytes():
    service = MagicMock()
    service.send_message.return_value = {
        "message": {"id": "message-1", "attachment": {"kind": "document"}}
    }
    service.get_attachment.return_value = {
        "content": b"%PDF-1.4\nprivate",
        "mimeType": "application/pdf",
        "name": "notes.pdf",
    }
    conversation_id = "11111111-1111-4111-8111-111111111111"
    message_id = "22222222-2222-4222-8222-222222222222"
    attachment = {"name": "notes.pdf", "mimeType": "application/pdf", "data": "JVBERi0xLjQK"}

    with patch("api.routes.one.messages._service", return_value=service):
        client = _client()
        sent = client.post(
            "/api/one/messages",
            json={"recipientPersonRef": conversation_id, "content": "", "attachment": attachment},
        )
        fetched = client.get(
            f"/api/one/messages/conversations/{conversation_id}/messages/{message_id}/attachment"
        )

    assert sent.status_code == 200
    service.send_message.assert_called_once_with(
        "viewer-user",
        content="",
        recipient_user_id=None,
        recipient_person_ref=conversation_id,
        reply_to_message_id=None,
        client_message_id=None,
        attachment=attachment,
    )
    assert fetched.status_code == 200
    assert fetched.content == b"%PDF-1.4\nprivate"
    assert fetched.headers["cache-control"] == "private, no-store"
    assert fetched.headers["x-content-type-options"] == "nosniff"
    service.get_attachment.assert_called_once_with("viewer-user", conversation_id, message_id)


def test_send_returns_clear_server_enforced_connection_error():
    service = MagicMock()
    service.send_message.side_effect = DirectMessagesError(
        "DIRECT_MESSAGE_CONNECTION_REQUIRED",
        "You can only message an accepted connection.",
        status_code=403,
    )
    with patch("api.routes.one.messages._service", return_value=service):
        response = _client().post(
            "/api/one/messages",
            json={"recipientUserId": "other-user", "content": "hello"},
        )

    assert response.status_code == 403
    assert response.json() == {
        "detail": {
            "code": "DIRECT_MESSAGE_CONNECTION_REQUIRED",
            "message": "You can only message an accepted connection.",
        }
    }


def test_open_by_person_ref_is_private_no_store_and_uses_the_opaque_ref():
    service = MagicMock()
    person_ref = "11111111-1111-4111-8111-111111111111"
    draft = {
        "conversation": None,
        "peerPersonRef": person_ref,
        "peerDisplayName": "Connected person",
        "peerPhotoUrl": "https://example.com/person.jpg",
        "canSend": True,
        "disconnectedNotice": False,
    }
    service.open_with_person.return_value = draft
    with patch("api.routes.one.messages._service", return_value=service):
        response = _client().get(f"/api/one/messages/with/person/{person_ref}")

    assert response.status_code == 200
    assert response.json() == draft
    assert response.headers["cache-control"] == "private, no-store"
    service.open_with_person.assert_called_once_with("viewer-user", recipient_person_ref=person_ref)


def test_direct_message_sse_event_is_metadata_only():
    event = _direct_message_event(
        {
            "type": "direct_message",
            "message_id": "direct-message:message-1",
            "conversation_id": "conversation-1",
            "direct_message_id": "message-1",
            "at": "2026-01-01T00:00:00Z",
            "content": "must not be exposed",
            "sender_user_id": "must not be exposed",
        }
    )

    assert event == {
        "messageId": "direct-message:message-1",
        "conversationId": "conversation-1",
        "directMessageId": "message-1",
        "at": "2026-01-01T00:00:00Z",
        "deepLink": None,
    }


@pytest.mark.asyncio
async def test_message_stream_repairs_subscribe_gap_and_listener_reset(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from api import consent_listener
    from api.routes.one.messages import _message_event_stream

    queue = asyncio.Queue()
    subscribe = AsyncMock(return_value=queue)
    unsubscribe = AsyncMock()
    monkeypatch.setattr(consent_listener, "subscribe_consent_queue", subscribe)
    monkeypatch.setattr(consent_listener, "unsubscribe_consent_queue", unsubscribe)
    stream = _message_event_stream(
        "viewer-user", SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    )
    try:
        assert await anext(stream) == {"event": "resync", "data": "{}"}
        subscribe.assert_awaited_once_with("viewer-user", snapshot_resets=True)
        await queue.put(
            {"type": consent_listener.LOCAL_RESYNC_EVENT_TYPE, "content": "never transport this"}
        )
        assert await asyncio.wait_for(anext(stream), timeout=1) == {"event": "resync", "data": "{}"}
    finally:
        await stream.aclose()
    unsubscribe.assert_awaited_once_with("viewer-user", queue)


def test_message_actions_keep_participant_identity_server_side():
    service = MagicMock()
    service.edit_message.return_value = {"message": {"id": "message-1"}}
    service.delete_message.return_value = {"scope": "everyone", "message": {"id": "message-1"}}
    service.react_to_message.return_value = {"message": {"id": "message-1"}}
    conversation_id = "11111111-1111-4111-8111-111111111111"
    message_id = "22222222-2222-4222-8222-222222222222"
    with patch("api.routes.one.messages._service", return_value=service):
        client = _client()
        edited = client.patch(
            f"/api/one/messages/conversations/{conversation_id}/messages/{message_id}",
            json={"content": "edited"},
        )
        deleted = client.delete(
            f"/api/one/messages/conversations/{conversation_id}/messages/{message_id}?scope=everyone"
        )
        reacted = client.put(
            f"/api/one/messages/conversations/{conversation_id}/messages/{message_id}/reaction",
            json={"emoji": "😀"},
        )

    assert edited.status_code == deleted.status_code == reacted.status_code == 200
    service.edit_message.assert_called_once_with(
        "viewer-user", conversation_id, message_id, content="edited"
    )
    service.delete_message.assert_called_once_with(
        "viewer-user", conversation_id, message_id, scope="everyone"
    )
    service.react_to_message.assert_called_once_with(
        "viewer-user", conversation_id, message_id, emoji="😀"
    )


def test_route_tokens_require_participation_on_mint_and_restore(monkeypatch):
    import base64

    monkeypatch.setenv(
        "DIRECT_MESSAGE_ENCRYPTION_KEY_V1", base64.urlsafe_b64encode(b"t" * 32).decode()
    )
    service = MagicMock()
    conversation = "11111111-1111-4111-8111-111111111111"
    service._normalize_conversation_id.side_effect = lambda value: value
    service._conversation_for_participant.return_value = {"id": conversation}
    with patch("api.routes.one.messages._service", return_value=service):
        client = _client()
        minted = client.post("/api/one/messages/route-token", json={"conversationId": conversation})
        assert minted.status_code == 200
        assert minted.headers["cache-control"] == "private, no-store"
        token = minted.json()["token"]
        assert conversation not in token
        restored = client.post("/api/one/messages/route-token", json={"token": token})
        assert restored.status_code == 200
        assert restored.json()["ref"] == conversation
        service._conversation_for_participant.assert_called_with("viewer-user", conversation)
        service._conversation_for_participant.return_value = None
        assert (
            client.post("/api/one/messages/route-token", json={"token": token}).status_code == 404
        )
        assert (
            client.post(
                "/api/one/messages/route-token", json={"conversationId": conversation}
            ).status_code
            == 404
        )
        assert (
            client.post("/api/one/messages/route-token", json={"token": "dm1.invalid"}).status_code
            == 400
        )
