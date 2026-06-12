"""CWE-400 bounds tests for Kai Gmail routes (6 models)."""

import pytest
from pydantic import ValidationError

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
        req = GmailConnectCompleteRequest(
            user_id="user-123", code="code123", state="state123"
        )
        assert req.code == "code123"

    def test_code_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(
                user_id="user-123", code="A" * 513, state="state123"
            )

    def test_state_bounds(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(
                user_id="user-123", code="code123", state="A" * 513
            )


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
