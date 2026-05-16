"""
Tests for input bounds on Gmail connector and PKM agent-lab request models.

Canonical attach points
-----------------------
api.routes.kai.gmail.gmail_connect_complete
  -> payload: GmailConnectCompleteRequest (user_id max_length=128,
     code max_length=512, state max_length=512)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.pkm.preview_pkm_structure
  -> payload: PKMAgentLabStructureRequest (user_id max_length=128,
     current_domains list max_length=50)
  -> FastAPI returns HTTP 422 when any bound is exceeded

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


# ===========================================================================
# Canonical route-level caller proof
# ===========================================================================

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import api.routes.kai.gmail as gmail_module  # noqa: E402
import api.routes.pkm as pkm_module  # noqa: E402
from api.middleware import require_firebase_auth, require_vault_owner_token  # noqa: E402


def _firebase_stub() -> str:
    return "test-uid"


def _vault_owner_stub() -> dict:
    return {"user_id": "test-uid", "token": "fake-token", "scope": "vault.owner"}  # noqa: S105


def _gmail_client() -> TestClient:
    app = FastAPI()
    app.include_router(gmail_module.router)
    app.dependency_overrides[require_firebase_auth] = _firebase_stub
    return TestClient(app, raise_server_exceptions=False)


def _pkm_client() -> TestClient:
    app = FastAPI()
    app.include_router(pkm_module.router)
    app.dependency_overrides[require_vault_owner_token] = _vault_owner_stub
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.kai.gmail.gmail_connect_complete
# POST /gmail/connect/complete  ->  GmailConnectCompleteRequest
# ---------------------------------------------------------------------------


class TestGmailConnectCompleteRouteInputBounds:
    """
    api.routes.kai.gmail.gmail_connect_complete is the canonical owner of
    GmailConnectCompleteRequest validation for POST /gmail/connect/complete.

    Proves FastAPI returns HTTP 422 when user_id, code, or state exceed
    their bounds, before any OAuth exchange runs.
    """

    _URL = "/gmail/connect/complete"

    def _valid_body(self, **overrides) -> dict:
        base = {
            "user_id": "test-uid",
            "code": "auth_code_value",
            "state": "state_value",
        }
        return {**base, **overrides}

    def test_valid_body_passes_validation(self):
        """A valid body must not be rejected by Pydantic validation."""
        resp = _gmail_client().post(self._URL, json=self._valid_body())
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _gmail_client().post(self._URL, json=self._valid_body(user_id="u" * 129))
        assert resp.status_code == 422

    def test_code_over_max_returns_422(self):
        """code > 512 chars must be rejected with 422."""
        resp = _gmail_client().post(self._URL, json=self._valid_body(code="c" * 513))
        assert resp.status_code == 422

    def test_state_over_max_returns_422(self):
        """state > 512 chars must be rejected with 422."""
        resp = _gmail_client().post(self._URL, json=self._valid_body(state="s" * 513))
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.pkm.preview_pkm_structure
# POST /api/pkm/agent-lab/structure  ->  PKMAgentLabStructureRequest
# ---------------------------------------------------------------------------


class TestPreviewPkmStructureRouteInputBounds:
    """
    api.routes.pkm.preview_pkm_structure is the canonical owner of
    PKMAgentLabStructureRequest validation for POST /api/pkm/agent-lab/structure.

    Proves FastAPI returns HTTP 422 when user_id or current_domains exceed
    their bounds, before any service call runs.
    """

    _URL = "/api/pkm/agent-lab/structure"

    def _valid_body(self, **overrides) -> dict:
        base = {
            "user_id": "test-uid",
            "message": "Analyze my data",
        }
        return {**base, **overrides}

    def test_valid_body_passes_validation(self):
        """A valid body must not be rejected by Pydantic validation."""
        resp = _pkm_client().post(self._URL, json=self._valid_body())
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _pkm_client().post(self._URL, json=self._valid_body(user_id="u" * 129))
        assert resp.status_code == 422

    def test_current_domains_over_max_returns_422(self):
        """current_domains list > 50 items must be rejected with 422."""
        resp = _pkm_client().post(self._URL, json=self._valid_body(current_domains=["d"] * 51))
        assert resp.status_code == 422
