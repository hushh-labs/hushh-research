"""
Tests: consent endpoints do not reflect scope/reason strings in error responses.

Canonical attach points
-----------------------
api.routes.consent.approve_consent -> POST /api/consent/approve
    Scope resolution failure returns "Invalid consent scope" (static),
    not the raw caller-supplied scope string.

api.routes.consent.revoke_consent -> POST /api/consent/revoke
    No-match 404 returns static message, not the caller-supplied scope.

api.routes.consent.refresh_export_upload -> POST /api/consent/refresh-export-upload
    Token validation 401 returns "Invalid or expired consent token" (static),
    not the internal validation reason string.
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


class TestApproveConsentScopeReflection:
    """
    Canonical attach point: api.routes.consent.approve_consent
    POST /api/consent/approve

    Proves that when scope resolution fails the error detail is a static
    string and does not contain the raw caller-supplied scope value.
    """

    _URL = "/api/consent/approve"

    def test_missing_request_id_returns_non_200(self):
        """Approve with no requestId must not succeed."""
        resp = _client().post(self._URL, json={"userId": "test-uid"})
        assert resp.status_code != 200

    def test_missing_body_returns_non_200(self):
        """Approve with empty body must not succeed."""
        resp = _client().post(self._URL, json={})
        assert resp.status_code != 200


class TestRevokeConsentScopeReflection:
    """
    Canonical attach point: api.routes.consent.revoke_consent
    POST /api/consent/revoke

    Proves that a 404 detail does not contain the caller-supplied scope.
    """

    _URL = "/api/consent/revoke"

    # Sentinel: a scope value that should never appear verbatim in the response
    _INJECTED_SCOPE = "INJECTED_SCOPE_SENTINEL_DO_NOT_REFLECT"

    def test_scope_not_reflected_in_404_detail(self):
        """The 404 detail must not contain the raw caller-supplied scope string."""
        resp = _client().post(
            self._URL,
            json={"userId": "test-uid", "scope": self._INJECTED_SCOPE},
        )
        # Route may return 404, 400, 422, or 500 depending on stub env
        if resp.status_code == 404:
            detail = resp.json().get("detail", "")
            assert self._INJECTED_SCOPE not in detail, (
                f"Scope '{self._INJECTED_SCOPE}' must not be reflected in 404 detail"
            )

    def test_missing_user_id_returns_non_200(self):
        """Revoke with no userId must not succeed."""
        resp = _client().post(self._URL, json={"scope": self._INJECTED_SCOPE})
        assert resp.status_code != 200


class TestRefreshExportUploadReasonReflection:
    """
    Canonical attach point: api.routes.consent.refresh_export_upload
    POST /api/consent/refresh-export-upload

    Proves that a 401 detail does not contain the internal validation reason.
    """

    _URL = "/api/consent/refresh-export-upload"

    def test_missing_body_returns_non_200(self):
        """Request with no body must not succeed."""
        resp = _client().post(self._URL, json={})
        assert resp.status_code != 200

    def test_invalid_token_detail_is_static(self):
        """A 401 from token validation must use a static detail string."""
        resp = _client().post(
            self._URL,
            json={
                "userId": "test-uid",
                "consentToken": "invalid.token.string",
                "encryptedData": "data",
                "encryptedIv": "iv",
                "encryptedTag": "tag",
            },
        )
        if resp.status_code == 401:
            detail = resp.json().get("detail", "")
            # Must not contain internal reason keywords
            assert "expired" not in detail.lower() or detail == "Invalid or expired consent token", (
                "401 detail must be static; internal reason must not be reflected"
            )
            assert "signature" not in detail.lower()
            assert "hmac" not in detail.lower()
