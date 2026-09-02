from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import gmail_information_requests as module


def _app(*, owner_user_id: str = "owner") -> TestClient:
    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": owner_user_id,
        "token": "vault-owner-token",
    }
    return TestClient(app)


def test_preference_routes_bind_to_the_authenticated_account_user():
    service = type("Service", (), {})()
    service.get_preference = AsyncMock(
        return_value={"user_id": "owner", "monitoring_enabled": False}
    )
    service.set_preference = AsyncMock(
        return_value={"user_id": "owner", "monitoring_enabled": True}
    )
    with patch.object(module, "_service", return_value=service):
        client = _app()
        get_response = client.get("/api/one/email/information-requests/preference?user_id=owner")
        patch_response = client.patch(
            "/api/one/email/information-requests/preference",
            json={"user_id": "owner", "enabled": True},
        )

    assert get_response.status_code == 200
    assert patch_response.status_code == 200
    assert service.get_preference.await_args.kwargs == {"user_id": "owner"}
    assert service.set_preference.await_args.kwargs == {"user_id": "owner", "enabled": True}


def test_queue_and_scan_require_matching_firebase_and_vault_owner():
    client = _app(owner_user_id="other-owner")

    assert client.get("/api/one/email/information-requests").status_code == 403
    assert client.post("/api/one/email/information-requests/scan", json={}).status_code == 403


def test_queue_and_scan_derive_owner_without_a_caller_supplied_user_id():
    service = type("Service", (), {})()
    service.list_workflows = AsyncMock(return_value={"workflows": [], "limit": 12})
    service.scan_recent = AsyncMock(
        return_value={"accepted": True, "scanned_count": 2, "matched_count": 1, "failed_count": 0}
    )
    with patch.object(module, "_service", return_value=service):
        client = _app()
        list_response = client.get("/api/one/email/information-requests?limit=12&view=activity")
        scan_response = client.post(
            "/api/one/email/information-requests/scan", json={"max_results": 2}
        )

    assert list_response.status_code == 200
    assert scan_response.status_code == 200
    assert service.list_workflows.await_args.kwargs == {
        "user_id": "owner",
        "limit": 12,
        "offset": 0,
        "view": "activity",
    }
    assert service.scan_recent.await_args.kwargs == {"user_id": "owner", "max_results": 2}


def test_scan_route_never_exposes_a_gmail_history_cursor():
    service = type("Service", (), {})()
    service.scan_recent = AsyncMock(
        return_value={
            "accepted": True,
            "scanned_count": 1,
            "matched_count": 1,
            "next_page_token": "opaque-gmail-page-token",
            "next_monitor_history_id": "opaque-history-id",
        }
    )
    with patch.object(module, "_service", return_value=service):
        response = _app().post("/api/one/email/information-requests/scan", json={})

    assert response.status_code == 200
    assert response.json() == {"accepted": True, "scanned_count": 1, "matched_count": 1}


def test_reply_routes_bind_only_a_source_derived_envelope_to_the_owner():
    service = type("Service", (), {})()
    service.prepare_reply = AsyncMock(return_value={"action_id": "prepared-action"})
    service.send_reply = AsyncMock(return_value={"state": "sent"})
    with patch.object(module, "_service", return_value=service):
        client = _app()
        prepared = client.post(
            "/api/one/email/information-requests/workflow-1/prepare-reply",
            json={"body": "Approved details", "idempotency_key": "confirmation-key-1"},
        )
        sent = client.post(
            "/api/one/email/information-requests/workflow-1/send-reply",
            json={"body": "Approved details", "action_id": "prepared-action"},
        )
        rejected = client.post(
            "/api/one/email/information-requests/workflow-1/prepare-reply",
            json={
                "body": "Approved details",
                "idempotency_key": "confirmation-key-2",
                "to": "attacker@example.com",
            },
        )

    assert prepared.status_code == 200
    assert sent.status_code == 200
    assert rejected.status_code == 422
    assert service.prepare_reply.await_args.kwargs == {
        "user_id": "owner",
        "workflow_id": "workflow-1",
        "body": "Approved details",
        "html_body": None,
        "idempotency_key": "confirmation-key-1",
    }
    assert service.send_reply.await_args.kwargs == {
        "user_id": "owner",
        "workflow_id": "workflow-1",
        "action_id": "prepared-action",
        "body": "Approved details",
        "html_body": None,
    }


def test_background_monitor_requires_oidc_token(monkeypatch):
    monkeypatch.setenv("GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUTH_ENABLED", "true")
    monkeypatch.setenv(
        "GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUDIENCE", "https://api.example.com"
    )
    monkeypatch.setenv(
        "GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SERVICE_ACCOUNT_EMAIL",
        "scheduler@example.iam.gserviceaccount.com",
    )
    client = _app()

    response = client.post("/api/one/email/information-requests/scan-enabled", json={})

    assert response.status_code == 401
    assert (
        response.json()["detail"]["code"]
        == "PERSONAL_GMAIL_INFORMATION_REQUEST_MONITOR_UNAUTHORIZED"
    )


def test_background_monitor_accepts_only_the_configured_oidc_identity(monkeypatch):
    monkeypatch.setenv("GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUTH_ENABLED", "true")
    monkeypatch.setenv(
        "GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUDIENCE", "https://api.example.com"
    )
    monkeypatch.setenv(
        "GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SERVICE_ACCOUNT_EMAIL",
        "scheduler@example.iam.gserviceaccount.com",
    )
    service = type("Service", (), {})()
    service.scan_enabled_users = AsyncMock(return_value={"eligible_users": 1})
    with (
        patch.object(
            module.google_id_token,
            "verify_oauth2_token",
            return_value={
                "email": "scheduler@example.iam.gserviceaccount.com",
                "email_verified": True,
            },
        ),
        patch.object(module, "_service", return_value=service),
    ):
        response = _app().post(
            "/api/one/email/information-requests/scan-enabled",
            json={"max_users": 1},
            headers={"Authorization": "Bearer signed-oidc-token"},
        )

    assert response.status_code == 200
    assert service.scan_enabled_users.await_args.kwargs == {"max_users": 1}


def test_ignore_route_requires_the_vault_owner_and_marks_only_that_workflow():
    service = type("Service", (), {})()
    service.ignore_workflow = AsyncMock(
        return_value={"workflow_id": "workflow-1", "status": "ignored"}
    )
    with patch.object(module, "_service", return_value=service):
        response = _app().post("/api/one/email/information-requests/workflow-1/ignore")

    assert response.status_code == 200
    assert service.ignore_workflow.await_args.kwargs == {
        "user_id": "owner",
        "workflow_id": "workflow-1",
    }
