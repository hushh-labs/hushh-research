from unittest.mock import MagicMock, patch

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


def test_send_person_ref_threads_authenticated_sender_and_never_accepts_a_peer_uid_response():
    service = MagicMock()
    service.send_message.return_value = {
        "conversation": {"id": "conversation-1", "peerPersonRef": "person-1", "canSend": True},
        "message": {"id": "message-1", "senderIsViewer": True, "content": "hello"},
    }
    with patch("api.routes.one.messages._service", return_value=service):
        response = _client().post(
            "/api/one/messages",
            json={"recipientPersonRef": "11111111-1111-4111-8111-111111111111", "content": "hello"},
        )

    assert response.status_code == 200
    assert response.json()["message"]["senderIsViewer"] is True
    service.send_message.assert_called_once_with(
        "viewer-user",
        content="hello",
        recipient_user_id=None,
        recipient_person_ref="11111111-1111-4111-8111-111111111111",
        reply_to_message_id=None,
    )


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
    service.open_with_person.return_value = {"conversation": None, "canSend": True}
    person_ref = "11111111-1111-4111-8111-111111111111"
    with patch("api.routes.one.messages._service", return_value=service):
        response = _client().get(f"/api/one/messages/with/person/{person_ref}")

    assert response.status_code == 200
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
