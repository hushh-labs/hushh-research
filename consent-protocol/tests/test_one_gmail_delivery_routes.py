from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import gmail_delivery as module


def _app(*, owner_user_id: str = "firebase-user") -> FastAPI:
    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase-user"
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": owner_user_id,
        "token": "vault-owner-token",
    }
    return app


def _envelope() -> dict[str, object]:
    return {
        "to": ["recipient@example.com"],
        "cc": [],
        "bcc": [],
        "subject": "Hello",
        "body": "Message",
        "html_body": "<p>Message</p>",
    }


def test_prepare_derives_user_from_matching_firebase_and_vault_owner():
    service = MagicMock()
    service.prepare = AsyncMock(return_value={"action_id": "action", "state": "prepared"})
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/prepare",
            json={
                **_envelope(),
                "to": "recipient@example.com",
                "cc": "",
                "bcc": "",
                "idempotency_key": "x" * 16,
            },
        )

    assert response.status_code == 200
    assert service.prepare.await_args.kwargs["user_id"] == "firebase-user"
    assert service.prepare.await_args.kwargs["draft_payload"] == {
        **_envelope(),
        "to": "recipient@example.com",
        "cc": "",
        "bcc": "",
    }


def test_delivery_rejects_firebase_vault_owner_mismatch_without_caller_user_id():
    response = TestClient(_app(owner_user_id="other-user")).post(
        "/api/one/email/draft",
        json={"instruction": "Draft a greeting."},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "GMAIL_DELIVERY_USER_MISMATCH"


def test_prepare_accepts_one_drive_reference_and_returns_reviewable_descriptor():
    descriptor = {
        "revision": "revision-1",
        "sha256": "a" * 64,
        "filename": "note.txt",
        "mime_type": "text/plain",
        "size": 12,
        "source_account_label": "owner@example.com",
    }
    service = MagicMock()
    service.prepare = AsyncMock(
        return_value={
            "action_id": "action",
            "state": "prepared",
            "drive_attachment": descriptor,
            "attachment_token": "opaque-token",
        }
    )
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/prepare",
            json={
                **_envelope(),
                "idempotency_key": "x" * 16,
                "drive_attachment": {"file_id": "drive-file-1"},
            },
        )
    assert response.status_code == 200
    assert response.json()["drive_attachment"] == descriptor
    assert response.json()["attachment_token"] == "opaque-token"
    assert "file_id" not in response.json()["drive_attachment"]
    assert service.prepare.await_args.kwargs["draft_payload"]["drive_attachment"] == {
        "file_id": "drive-file-1",
    }
    service.execute.assert_not_called()


def test_send_passes_opaque_attachment_token_to_owner_service():
    token = "opaque-token" * 4
    service = MagicMock()
    service.execute = AsyncMock(return_value={"action_id": "action", "state": "sent"})
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/send",
            json={**_envelope(), "action_id": "action", "attachment_token": token},
        )
    assert response.status_code == 200
    assert service.execute.await_args.kwargs["user_id"] == "firebase-user"
    assert service.execute.await_args.kwargs["draft_payload"]["attachment_token"] == token


def test_source_bound_delivery_uses_the_common_routes_without_trusting_the_browser_envelope():
    delivery = MagicMock()
    delivery.prepare = AsyncMock(return_value={"action_id": "action", "state": "prepared"})
    delivery.execute = AsyncMock(return_value={"action_id": "action", "state": "sent"})
    reply_context = type("ReplyContext", (), {"thread_id": "thread-1"})()
    source = MagicMock()
    source.resolve_reply_delivery = AsyncMock(
        return_value=(
            {
                "to": ["verified@example.com"],
                "cc": [],
                "bcc": [],
                "subject": "Re: Verified request",
                "body": "Approved details",
            },
            reply_context,
        )
    )
    source.record_reply_delivery = AsyncMock(return_value={"action_id": "action", "state": "sent"})

    with (
        patch.object(module, "get_gmail_delivery_service", return_value=delivery),
        patch.object(
            module,
            "get_personal_gmail_information_request_service",
            return_value=source,
        ),
    ):
        client = TestClient(_app())
        prepared = client.post(
            "/api/one/email/prepare",
            json={
                **_envelope(),
                "to": "attacker@example.com",
                "idempotency_key": "x" * 16,
                "source_workflow_id": "workflow-1",
            },
        )
        sent = client.post(
            "/api/one/email/send",
            json={
                **_envelope(),
                "to": "attacker@example.com",
                "action_id": "action",
                "source_workflow_id": "workflow-1",
            },
        )

    assert prepared.status_code == 200
    assert sent.status_code == 200
    assert source.resolve_reply_delivery.await_args_list[0].kwargs == {
        "user_id": "firebase-user",
        "workflow_id": "workflow-1",
        "body": "Message",
        "html_body": "<p>Message</p>",
    }
    assert delivery.prepare.await_args.kwargs["draft_payload"]["to"] == ["verified@example.com"]
    assert delivery.prepare.await_args.kwargs["reply_context"] is reply_context
    assert delivery.execute.await_args.kwargs["draft_payload"]["to"] == ["verified@example.com"]
    assert delivery.execute.await_args.kwargs["reply_context"] is reply_context
    assert source.record_reply_delivery.await_args.kwargs == {
        "user_id": "firebase-user",
        "workflow_id": "workflow-1",
        "result": {"action_id": "action", "state": "sent"},
    }


def test_route_rejects_multiple_attachments_and_caller_supplied_bytes():
    client = TestClient(_app())
    for payload in (
        {"drive_attachment": [{"file_id": "a", "revision": "r"}]},
        {"attachments": [{"file_id": "a", "revision": "r"}]},
        {"drive_attachment": {"file_id": "a", "revision": "r", "content": "raw"}},
    ):
        response = client.post(
            "/api/one/email/prepare",
            json={**_envelope(), "idempotency_key": "x" * 16, **payload},
        )
        assert response.status_code == 422


def test_send_rejects_file_reference_instead_of_opaque_token():
    response = TestClient(_app()).post(
        "/api/one/email/send",
        json={
            **_envelope(),
            "action_id": "action",
            "drive_attachment": {"file_id": "drive-file-1", "revision": "revision-1"},
        },
    )
    assert response.status_code == 422
