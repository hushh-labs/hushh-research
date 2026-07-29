"""Tests for developer API token query parameter bounds (CWE-400).

Four handler functions in api/routes/developer.py accepted an unbounded
token query parameter with no max_length constraint:

- GET  /api/v1/tool-catalog          (get_tool_catalog)
- POST /api/v1/request-consent       (request_consent)
- POST /api/v1/default-available-export (get_default_available_export)
- POST /api/v1/scoped-export         (get_scoped_export)

An adjacent handler (get_user_scopes, /api/v1/consent-status) already had
max_length=2048 on its token param; the four above lacked this guard.

Bound applied: max_length=2048 on all four token query params.

Canonical attach points:
- GET  /api/v1/tool-catalog          api/routes/developer.py, get_tool_catalog
- POST /api/v1/request-consent       api/routes/developer.py, request_consent
- POST /api/v1/default-available-export api/routes/developer.py, get_default_available_export
- POST /api/v1/scoped-export         api/routes/developer.py, get_scoped_export
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.developer import router as developer_router

_VALID_TOKEN = "a" * 2048
_OVER_TOKEN = "a" * 2049

_CONSENT_REQUEST_BODY = {
    "user_id": "test-user",
    "scope": "attr.food.*",
    "connector_public_key": "a" * 16,
    "connector_key_id": "kid-1",
    "connector_wrapping_alg": "RSA-OAEP",
}

_DEFAULT_EXPORT_BODY = {
    "user_id": "test-user",
    "scope": "attr.food.*",
}

_SCOPED_EXPORT_BODY = {
    "user_id": "test-user",
    "consent_token": "c" * 16,
}


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer_router)
    return app


client = TestClient(_build_app(), raise_server_exceptions=False)


class TestToolCatalogTokenBound:
    """GET /api/v1/tool-catalog: token query param max_length=2048."""

    def test_token_at_max_length_accepted(self):
        """2048-char token passes schema validation (auth may still reject)."""
        response = client.get(
            "/api/v1/tool-catalog",
            params={"token": _VALID_TOKEN},
        )
        assert response.status_code != 422, (
            f"2048-char token should pass schema, got 422: {response.text}"
        )

    def test_token_over_max_length_rejected(self):
        """2049-char token is rejected with HTTP 422."""
        response = client.get(
            "/api/v1/tool-catalog",
            params={"token": _OVER_TOKEN},
        )
        assert response.status_code == 422, (
            f"2049-char token must be rejected with 422, got {response.status_code}"
        )


class TestRequestConsentTokenBound:
    """POST /api/v1/request-consent: token query param max_length=2048."""

    def test_token_at_max_length_accepted(self):
        """2048-char token passes schema validation."""
        response = client.post(
            "/api/v1/request-consent",
            params={"token": _VALID_TOKEN},
            json=_CONSENT_REQUEST_BODY,
        )
        assert response.status_code != 422, (
            f"2048-char token should pass schema, got 422: {response.text}"
        )

    def test_token_over_max_length_rejected(self):
        """2049-char token is rejected with HTTP 422."""
        response = client.post(
            "/api/v1/request-consent",
            params={"token": _OVER_TOKEN},
            json=_CONSENT_REQUEST_BODY,
        )
        assert response.status_code == 422, (
            f"2049-char token must be rejected with 422, got {response.status_code}"
        )


class TestDefaultAvailableExportTokenBound:
    """POST /api/v1/default-available-export: token query param max_length=2048."""

    def test_token_at_max_length_accepted(self):
        """2048-char token passes schema validation."""
        response = client.post(
            "/api/v1/default-available-export",
            params={"token": _VALID_TOKEN},
            json=_DEFAULT_EXPORT_BODY,
        )
        assert response.status_code != 422, (
            f"2048-char token should pass schema, got 422: {response.text}"
        )

    def test_token_over_max_length_rejected(self):
        """2049-char token is rejected with HTTP 422."""
        response = client.post(
            "/api/v1/default-available-export",
            params={"token": _OVER_TOKEN},
            json=_DEFAULT_EXPORT_BODY,
        )
        assert response.status_code == 422, (
            f"2049-char token must be rejected with 422, got {response.status_code}"
        )


class TestScopedExportTokenBound:
    """POST /api/v1/scoped-export: token query param max_length=2048."""

    def test_token_at_max_length_accepted(self):
        """2048-char token passes schema validation."""
        response = client.post(
            "/api/v1/scoped-export",
            params={"token": _VALID_TOKEN},
            json=_SCOPED_EXPORT_BODY,
        )
        assert response.status_code != 422, (
            f"2048-char token should pass schema, got 422: {response.text}"
        )

    def test_token_over_max_length_rejected(self):
        """2049-char token is rejected with HTTP 422."""
        response = client.post(
            "/api/v1/scoped-export",
            params={"token": _OVER_TOKEN},
            json=_SCOPED_EXPORT_BODY,
        )
        assert response.status_code == 422, (
            f"2049-char token must be rejected with 422, got {response.status_code}"
        )

    def test_no_token_param_passes_schema(self):
        """Absence of token param passes schema (auth may reject)."""
        response = client.post(
            "/api/v1/scoped-export",
            json=_SCOPED_EXPORT_BODY,
        )
        assert response.status_code != 422, (
            f"Missing token should not cause 422, got {response.status_code}"
        )
