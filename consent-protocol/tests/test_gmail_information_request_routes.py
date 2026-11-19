from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import gmail_information_requests as module


def _app(*, owner_user_id: str = "owner") -> TestClient:
    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[module.hub_content_owner] = lambda: {
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

    assert (
        client.patch(
            "/api/one/email/information-requests/preference",
            json={"user_id": "owner", "enabled": True},
        ).status_code
        == 403
    )
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
            "/api/one/email/information-requests/scan",
            json={"max_results": 2, "include_recent_inbox": True},
        )

    assert list_response.status_code == 200
    assert scan_response.status_code == 200
    assert service.list_workflows.await_args.kwargs == {
        "user_id": "owner",
        "limit": 12,
        "offset": 0,
        "view": "activity",
    }
    assert service.scan_recent.await_args.kwargs == {
        "user_id": "owner",
        "max_results": 2,
        "include_recent_inbox": True,
    }


def test_scan_route_reports_partial_progress_without_exposing_cursor_state():
    service = type("Service", (), {})()
    service.scan_recent = AsyncMock(
        return_value={
            "accepted": True,
            "scanned_count": 2,
            "unchanged_count": 4,
            "matched_count": 1,
            "failed_count": 1,
            "retry_pending": True,
            "workflow_ids": ["workflow-1"],
            "next_monitor_history_id": "private-cursor",
        }
    )
    with patch.object(module, "_service", return_value=service):
        response = _app().post("/api/one/email/information-requests/scan", json={})

    assert response.status_code == 200
    assert response.json() == {
        "accepted": True,
        "scanned_count": 2,
        "unchanged_count": 4,
        "matched_count": 1,
        "failed_count": 1,
        "retry_pending": True,
        "workflow_ids": ["workflow-1"],
    }


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


def test_scan_stream_emits_progress_and_a_metadata_only_request_before_completion():
    service = type("Service", (), {})()

    async def scan_recent(**kwargs):
        await kwargs["on_progress"](
            2,
            {
                "workflow_id": "workflow-2",
                "status": "detected",
                "gmail_thread_id": "thread-2",
                "received_at": datetime(2026, 9, 24, 12, tzinfo=timezone.utc),
                "classification_confidence": 0.9,
                "requested_field_labels": ["Passport number"],
                "candidate_scopes": [],
                "attachment_review_required": False,
            },
        )
        return {
            "accepted": True,
            "scanned_count": 2,
            "unchanged_count": 0,
            "matched_count": 1,
            "failed_count": 0,
            "workflow_ids": ["workflow-2"],
            "next_monitor_history_id": "private-cursor",
        }

    service.scan_recent = scan_recent
    with patch.object(module, "_service", return_value=service):
        response = _app().post("/api/one/email/information-requests/scan/stream", json={})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "private, no-store, no-cache, no-transform"
    assert 'event: progress\ndata: {"event":"progress","scanned_count":0}' in response.text
    assert 'event: progress\ndata: {"event":"progress","scanned_count":2}' in response.text
    assert 'event: request\ndata: {"event":"request","workflow"' in response.text
    assert "2026-09-24T12:00:00+00:00" in response.text
    assert 'event: complete\ndata: {"event":"complete","accepted":true' in response.text
    assert "private-cursor" not in response.text
    assert "subject" not in response.text
    assert "body" not in response.text


def test_scan_stream_reports_only_safe_error_copy_after_it_starts():
    service = type("Service", (), {})()
    service.scan_recent = AsyncMock(side_effect=RuntimeError("provider diagnostic"))
    with patch.object(module, "_service", return_value=service):
        response = _app().post("/api/one/email/information-requests/scan/stream", json={})

    assert response.status_code == 200
    assert "provider diagnostic" not in response.text
    assert (
        'event: error\ndata: {"event":"error","message":"Personal Gmail monitoring is temporarily unavailable. Please try again."}'
        in response.text
    )


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
            json={
                "body": "Approved details",
                "action_id": "prepared-action",
                "sender_token": "s" * 48,
            },
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
        "sender_token": "s" * 48,
        "body": "Approved details",
        "html_body": None,
    }


def test_refresh_candidates_uses_only_the_authenticated_vault_owner():
    service = type("Service", (), {})()
    service.refresh_candidate_scopes = AsyncMock(
        return_value={"workflow_id": "workflow-1", "candidate_scopes": []}
    )
    with patch.object(module, "_service", return_value=service):
        response = _app().post("/api/one/email/information-requests/workflow-1/refresh-candidates")

    assert response.status_code == 200
    assert service.refresh_candidate_scopes.await_args.kwargs == {
        "user_id": "owner",
        "workflow_id": "workflow-1",
    }


def test_source_preview_fetches_only_the_current_owner_selected_workflow():
    service = type("Service", (), {})()
    service.get_source_preview = AsyncMock(
        return_value={
            "from": "Sender",
            "reply_to": "Replies <reply@example.test>",
            "subject": "Verification",
            "body": "Requested details",
        }
    )
    with patch.object(module, "_service", return_value=service):
        response = _app().get("/api/one/email/information-requests/workflow-1/source-preview")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == {
        "from": "Sender",
        "reply_to": "Replies <reply@example.test>",
        "subject": "Verification",
        "body": "Requested details",
    }
    assert service.get_source_preview.await_args.kwargs == {
        "user_id": "owner",
        "workflow_id": "workflow-1",
    }


def test_exact_active_request_requires_the_same_vault_owner():
    workflow_id = "c6390607-de4a-41c1-80d9-62ec0246728e"
    path = f"/api/one/email/information-requests/{workflow_id}"
    workflow = {"workflow_id": workflow_id, "status": "detected"}
    service = type("Service", (), {})()
    service.get_active_workflow = AsyncMock(side_effect=[workflow, None])
    with patch.object(module, "_service", return_value=service):
        assert _app(owner_user_id="another-owner").get(path).status_code == 403
        service.get_active_workflow.assert_not_awaited()
        response = _app().get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json() == workflow
        service.get_active_workflow.assert_awaited_once_with(
            user_id="owner", workflow_id=workflow_id
        )
        assert _app().get(path).status_code == 404


def test_source_preview_rejects_a_different_vault_owner():
    response = _app(owner_user_id="another-owner").get(
        "/api/one/email/information-requests/workflow-1/source-preview"
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "PERSONAL_GMAIL_INFORMATION_REQUEST_OWNER_REQUIRED"


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


def test_exact_terminal_request_history_is_owner_bound_read_only_and_not_cached():
    workflow = "af36e1c0-4dde-44eb-87a1-e3d5fa07d281"
    service = type("Service", (), {})()
    service.get_terminal_workflow = AsyncMock(
        return_value={"workflow_id": workflow, "status": "sent"}
    )
    with patch.object(module, "_service", return_value=service):
        response = _app().get(f"/api/one/email/information-requests/{workflow}/activity")
        assert response.status_code == 200 and response.json()["status"] == "sent"
        assert response.headers["Cache-Control"] == "private, no-store"
        service.get_terminal_workflow.assert_awaited_once_with(
            user_id="owner", workflow_id=workflow
        )
        assert (
            _app(owner_user_id="foreign")
            .get(f"/api/one/email/information-requests/{workflow}/activity")
            .status_code
            == 403
        )
        service.get_terminal_workflow.assert_awaited_once()
        service.get_terminal_workflow.return_value = None
        assert (
            _app().get(f"/api/one/email/information-requests/{workflow}/activity").status_code
            == 404
        )
