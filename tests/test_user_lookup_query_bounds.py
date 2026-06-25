"""Tests for GET /api/user/lookup query parameter bounds (CWE-400).

All five optional query parameters on the user lookup endpoint were previously
unbounded, allowing arbitrarily large inputs to reach the Firebase Admin SDK
and the phone number parser.

Bounds applied:
- identifier: max_length=128 (Firebase UID max is 128 chars)
- email: max_length=320 (RFC 5321 maximum email length)
- phone_number: max_length=32 (E.164 max is 15 digits + prefix)
- country_iso2: max_length=2 (ISO 3166-1 alpha-2 codes are exactly 2 chars)
- country: max_length=64 (country names fit in 64 chars)

Canonical attach point:
- GET /api/user/lookup (api/routes/session.py, lookup_user handler)
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.session import router as session_router


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(session_router)
    return app


client = TestClient(_build_app(), raise_server_exceptions=False)

_VALID_HEADERS = {"X-MCP-Developer-Token": "placeholder-dev-token"}


class TestIdentifierBound:
    """identifier query param: max_length=128."""

    def test_identifier_at_max_length_accepted(self):
        """Verify 128-char identifier passes schema (auth/business logic may reject)."""
        response = client.get(
            "/api/user/lookup",
            params={"identifier": "i" * 128},
            headers=_VALID_HEADERS,
        )
        assert response.status_code != 422, (
            f"128-char identifier should pass schema validation, got 422: {response.text}"
        )

    def test_identifier_over_max_length_rejected(self):
        """Verify 129-char identifier is rejected with HTTP 422."""
        response = client.get(
            "/api/user/lookup",
            params={"identifier": "i" * 129},
            headers=_VALID_HEADERS,
        )
        assert response.status_code == 422, (
            f"129-char identifier must be rejected with 422, got {response.status_code}"
        )


class TestEmailBound:
    """email query param: max_length=320 (RFC 5321)."""

    def test_email_at_max_length_accepted(self):
        """Verify 320-char email value passes schema."""
        response = client.get(
            "/api/user/lookup",
            params={"email": "e" * 320},
            headers=_VALID_HEADERS,
        )
        assert response.status_code != 422, (
            f"320-char email should pass schema validation, got 422: {response.text}"
        )

    def test_email_over_max_length_rejected(self):
        """Verify 321-char email is rejected with HTTP 422."""
        response = client.get(
            "/api/user/lookup",
            params={"email": "e" * 321},
            headers=_VALID_HEADERS,
        )
        assert response.status_code == 422, (
            f"321-char email must be rejected with 422, got {response.status_code}"
        )


class TestPhoneNumberBound:
    """phone_number query param: max_length=32."""

    def test_phone_at_max_length_accepted(self):
        """Verify 32-char phone value passes schema."""
        response = client.get(
            "/api/user/lookup",
            params={"phone_number": "1" * 32},
            headers=_VALID_HEADERS,
        )
        assert response.status_code != 422, (
            f"32-char phone should pass schema validation, got 422: {response.text}"
        )

    def test_phone_over_max_length_rejected(self):
        """Verify 33-char phone number is rejected with HTTP 422."""
        response = client.get(
            "/api/user/lookup",
            params={"phone_number": "1" * 33},
            headers=_VALID_HEADERS,
        )
        assert response.status_code == 422, (
            f"33-char phone must be rejected with 422, got {response.status_code}"
        )


class TestCountryIso2Bound:
    """country_iso2 query param: max_length=2."""

    def test_country_iso2_at_max_length_accepted(self):
        """Verify 2-char country code passes schema (valid ISO 3166-1 alpha-2)."""
        response = client.get(
            "/api/user/lookup",
            params={"country_iso2": "US"},
            headers=_VALID_HEADERS,
        )
        assert response.status_code != 422, (
            f"2-char country_iso2 should pass schema, got 422: {response.text}"
        )

    def test_country_iso2_over_max_length_rejected(self):
        """Verify 3-char country_iso2 is rejected with HTTP 422."""
        response = client.get(
            "/api/user/lookup",
            params={"country_iso2": "USA"},
            headers=_VALID_HEADERS,
        )
        assert response.status_code == 422, (
            f"3-char country_iso2 must be rejected with 422, got {response.status_code}"
        )


class TestCountryBound:
    """country query param: max_length=64."""

    def test_country_at_max_length_accepted(self):
        """Verify 64-char country value passes schema."""
        response = client.get(
            "/api/user/lookup",
            params={"country": "c" * 64},
            headers=_VALID_HEADERS,
        )
        assert response.status_code != 422, (
            f"64-char country should pass schema, got 422: {response.text}"
        )

    def test_country_over_max_length_rejected(self):
        """Verify 65-char country is rejected with HTTP 422."""
        response = client.get(
            "/api/user/lookup",
            params={"country": "c" * 65},
            headers=_VALID_HEADERS,
        )
        assert response.status_code == 422, (
            f"65-char country must be rejected with 422, got {response.status_code}"
        )

    def test_all_params_absent_passes_schema(self):
        """Verify request with no query params passes schema (business logic validates)."""
        response = client.get(
            "/api/user/lookup",
            headers=_VALID_HEADERS,
        )
        assert response.status_code != 422, (
            f"No query params should pass schema validation, got 422: {response.text}"
        )
