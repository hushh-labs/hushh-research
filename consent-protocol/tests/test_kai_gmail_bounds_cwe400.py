"""CWE-400 bounds tests for Kai Gmail routes (6 models)."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.kai import gmail
from api.routes.kai.gmail import (
    GmailConnectCompleteRequest,
    GmailConnectStartRequest,
    GmailDisconnectRequest,
    GmailReceiptMemoryPreviewRequest,
    GmailReconcileRequest,
    GmailSyncRequest,
)


class TestGmailConnectStartRequest:
    def test_valid(self):
        req = GmailConnectStartRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="A" * 257)

    def test_redirect_uri_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="user-123", redirect_uri="A" * 2049)

    def test_login_hint_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="user-123", login_hint="A" * 513)


class TestGmailConnectCompleteRequest:
    def test_valid(self):
        req = GmailConnectCompleteRequest(user_id="user-123", code="code123", state="state123")
        assert req.code == "code123"

    def test_code_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="user-123", code="A" * 513, state="state123")

    def test_state_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="user-123", code="code123", state="A" * 513)


class TestGmailDisconnectRequest:
    def test_valid(self):
        req = GmailDisconnectRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            GmailDisconnectRequest(user_id="A" * 257)


class TestGmailSyncRequest:
    def test_valid(self):
        req = GmailSyncRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            GmailSyncRequest(user_id="A" * 257)


class TestGmailReconcileRequest:
    def test_valid(self):
        req = GmailReconcileRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            GmailReconcileRequest(user_id="A" * 257)


class TestGmailReceiptMemoryPreviewRequest:
    def test_valid(self):
        req = GmailReceiptMemoryPreviewRequest(user_id="user-123")
        assert req.force_refresh is False

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            GmailReceiptMemoryPreviewRequest(user_id="A" * 257)


def _gmail_sync_run_client() -> TestClient:
    app = FastAPI()
    app.include_router(gmail.router, prefix="/api/kai")
    app.dependency_overrides[require_firebase_auth] = lambda: "test_user_123"
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test_user_123",
        "token": "test",
    }
    return TestClient(app)


class TestGmailSyncRunQueryBounds:
    """Verify max_length=128 on the user_id Query param in gmail_sync_run.

    Route-level proof via the live router, not a regex on source text, so a
    handler refactor that breaks the bound cannot pass silently.
    """

    def test_user_id_query_max_length_is_bounded(self):
        client = _gmail_sync_run_client()
        response = client.get(
            "/api/kai/gmail/sync/run_abc",
            params={"user_id": "x" * 129},
        )
        assert response.status_code == 422

    def test_user_id_within_bound_is_accepted(self):
        client = _gmail_sync_run_client()
        response = client.get(
            "/api/kai/gmail/sync/run_abc",
            params={"user_id": "test_user_123"},
        )
        assert response.status_code in {200, 404, 500, 503}
