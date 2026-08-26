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
