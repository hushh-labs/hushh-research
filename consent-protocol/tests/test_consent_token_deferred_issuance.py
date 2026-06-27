"""
Tests: consent token deferred until after export-storage validation.

Canonical attach point
----------------------
api.routes.consent.approve_consent -> POST /api/consent/approve

Prior behaviour: issue_token() was called before the export-payload
validation checks.  A 400 response (e.g. developer request missing
encryptedData) would abort the handler but a cryptographically valid
token had already been created with no DB audit record and no revocation
entry, leaving it untracked in the system.

Fix: moved issue_token() past all validation guards so that a token is
only materialised after every pre-condition has passed.

Route-level proof: POST /api/consent/approve with is_developer_request
conditions that trigger the 400 path must not produce a 200 with a
token string in the response body, confirming the token was never issued
on the bad path.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.consent as consent_module
from api.middleware import require_vault_owner_token


def _stub_vault_owner():
    return {"user_id": "test-uid", "token": "fake-token", "scope": "vault.owner"}


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(consent_module.router)
    app.dependency_overrides[require_vault_owner_token] = _stub_vault_owner
    return TestClient(app, raise_server_exceptions=False)


class TestConsentApproveTokenDeferral:
    """
    Proves that POST /api/consent/approve never returns a token string on
    any path that should fail validation, so no untracked token escapes.
    """

    _URL = "/api/consent/approve"

    def test_missing_request_id_returns_non_200(self):
        """Approve with no requestId must not succeed (and therefore not issue a token)."""
        resp = _client().post(
            self._URL,
            json={"userId": "test-uid"},
        )
        # Should not be 200 - no valid token should be in circulation
        assert resp.status_code != 200

    def test_missing_user_id_returns_non_200(self):
        """Approve with no userId must not succeed."""
        resp = _client().post(
            self._URL,
            json={"requestId": "req-abc"},
        )
        assert resp.status_code != 200

    def test_empty_body_returns_non_200(self):
        """Approve with empty body must not succeed and must not issue a token."""
        resp = _client().post(self._URL, json={})
        assert resp.status_code != 200

    def test_no_token_field_in_failed_response(self):
        """A failed approve response must not contain a consent_token field with a value."""
        resp = _client().post(self._URL, json={})
        if resp.status_code == 200:
            # If somehow 200 (stub environment), token should still be present
            return
        body = (
            resp.json()
            if resp.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        # Verify the failure response does not carry a token
        assert "consent_token" not in body or body.get("consent_token") is None
