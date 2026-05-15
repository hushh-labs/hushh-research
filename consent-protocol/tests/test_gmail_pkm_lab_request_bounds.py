"""
Tests for input bounds on Gmail connector and PKM agent-lab request models.

Covers:
- GmailConnectStartRequest: user_id, redirect_uri, login_hint
- GmailConnectCompleteRequest: user_id, code, state, redirect_uri
- GmailDisconnectRequest: user_id
- GmailSyncRequest: user_id
- GmailReconcileRequest: user_id
- GmailReceiptMemoryPreviewRequest: user_id
- PKMAgentLabStructureRequest: user_id, message, current_domains
"""

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
from api.routes.pkm import PKMAgentLabStructureRequest

# ---------------------------------------------------------------------------
# GmailConnectStartRequest
# ---------------------------------------------------------------------------


class TestGmailConnectStartRequest:
    def test_valid_passes(self):
        r = GmailConnectStartRequest(user_id="u1")
        assert r.user_id == "u1"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="u" * 129)

    def test_user_id_at_max_passes(self):
        r = GmailConnectStartRequest(user_id="u" * 128)
        assert len(r.user_id) == 128

    def test_redirect_uri_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="u1", redirect_uri="h" * 1001)

    def test_login_hint_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectStartRequest(user_id="u1", login_hint="e" * 321)


# ---------------------------------------------------------------------------
# GmailConnectCompleteRequest
# ---------------------------------------------------------------------------


class TestGmailConnectCompleteRequest:
    def test_valid_passes(self):
        r = GmailConnectCompleteRequest(user_id="u1", code="code123", state="state123")
        assert r.code == "code123"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="u" * 129, code="c", state="s")

    def test_code_empty_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="u1", code="", state="s")

    def test_code_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="u1", code="c" * 513, state="s")

    def test_state_empty_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="u1", code="c", state="")

    def test_state_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="u1", code="c", state="s" * 513)

    def test_redirect_uri_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailConnectCompleteRequest(user_id="u1", code="c", state="s", redirect_uri="h" * 1001)


# ---------------------------------------------------------------------------
# Simple single-field models
# ---------------------------------------------------------------------------


class TestGmailDisconnectRequest:
    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailDisconnectRequest(user_id="u" * 129)

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            GmailDisconnectRequest(user_id="")


class TestGmailSyncRequest:
    def test_valid_passes(self):
        r = GmailSyncRequest(user_id="u1")
        assert r.user_id == "u1"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailSyncRequest(user_id="u" * 129)


class TestGmailReconcileRequest:
    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailReconcileRequest(user_id="u" * 129)


class TestGmailReceiptMemoryPreviewRequest:
    def test_valid_passes(self):
        r = GmailReceiptMemoryPreviewRequest(user_id="u1")
        assert r.force_refresh is False

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            GmailReceiptMemoryPreviewRequest(user_id="u" * 129)


# ---------------------------------------------------------------------------
# PKMAgentLabStructureRequest
# ---------------------------------------------------------------------------


class TestPKMAgentLabStructureRequest:
    def test_valid_passes(self):
        r = PKMAgentLabStructureRequest(user_id="u1", message="Analyze my data")
        assert r.current_domains == []

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            PKMAgentLabStructureRequest(user_id="", message="msg")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PKMAgentLabStructureRequest(user_id="u" * 129, message="msg")

    def test_user_id_at_max_passes(self):
        r = PKMAgentLabStructureRequest(user_id="u" * 128, message="msg")
        assert len(r.user_id) == 128

    def test_message_empty_raises(self):
        with pytest.raises(ValidationError):
            PKMAgentLabStructureRequest(user_id="u1", message="")

    def test_message_too_long_raises(self):
        with pytest.raises(ValidationError):
            PKMAgentLabStructureRequest(user_id="u1", message="m" * 12001)

    def test_current_domains_over_50_raises(self):
        with pytest.raises(ValidationError):
            PKMAgentLabStructureRequest(user_id="u1", message="msg", current_domains=["d"] * 51)

    def test_current_domains_at_max_passes(self):
        r = PKMAgentLabStructureRequest(user_id="u1", message="msg", current_domains=["d"] * 50)
        assert len(r.current_domains) == 50
