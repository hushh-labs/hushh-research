"""Tests for authentication guard on investor write endpoints.

POST /api/investors/ and POST /api/investors/bulk are admin data-ingestion
endpoints. Before this fix they had no authentication dependency, meaning any
unauthenticated HTTP client could create or overwrite investor profile records
in the public investor table and contaminate the identity-resolution layer.

Fix: Both handlers now declare `firebase_uid: str = Depends(require_firebase_auth)`.
FastAPI injects the dependency before the handler body runs; a missing or invalid
Bearer token causes a 401 before any database write is attempted.

Canonical attach:
  api.routes.investors.create_investor      -> POST /api/investors/
  api.routes.investors.bulk_create_investors -> POST /api/investors/bulk
"""

from __future__ import annotations

import inspect

import pytest

from api.routes.investors import bulk_create_investors, create_investor

# ---------------------------------------------------------------------------
# Structural tests: verify the dependency is wired at the function level
# ---------------------------------------------------------------------------


class TestCreateInvestorHasAuthDependency:
    """create_investor must declare require_firebase_auth as a Depends parameter."""

    def test_firebase_uid_parameter_exists(self):
        sig = inspect.signature(create_investor)
        assert "firebase_uid" in sig.parameters, (
            "create_investor must have a 'firebase_uid' parameter"
        )

    def test_firebase_uid_has_depends(self):
        from fastapi import params as fastapi_params

        sig = inspect.signature(create_investor)
        param = sig.parameters["firebase_uid"]
        assert isinstance(param.default, fastapi_params.Depends), (
            "firebase_uid default must be a FastAPI Depends object"
        )

    def test_depends_wraps_require_firebase_auth(self):
        from api.middleware import require_firebase_auth

        sig = inspect.signature(create_investor)
        param = sig.parameters["firebase_uid"]
        assert param.default.dependency is require_firebase_auth, (
            "firebase_uid Depends must wrap require_firebase_auth"
        )


class TestBulkCreateInvestorsHasAuthDependency:
    """bulk_create_investors must declare require_firebase_auth as a Depends parameter."""

    def test_firebase_uid_parameter_exists(self):
        sig = inspect.signature(bulk_create_investors)
        assert "firebase_uid" in sig.parameters, (
            "bulk_create_investors must have a 'firebase_uid' parameter"
        )

    def test_firebase_uid_has_depends(self):
        from fastapi import params as fastapi_params

        sig = inspect.signature(bulk_create_investors)
        param = sig.parameters["firebase_uid"]
        assert isinstance(param.default, fastapi_params.Depends), (
            "firebase_uid default must be a FastAPI Depends object"
        )

    def test_depends_wraps_require_firebase_auth(self):
        from api.middleware import require_firebase_auth

        sig = inspect.signature(bulk_create_investors)
        param = sig.parameters["firebase_uid"]
        assert param.default.dependency is require_firebase_auth, (
            "firebase_uid Depends must wrap require_firebase_auth"
        )


# ---------------------------------------------------------------------------
# HTTP integration tests: 401 without a Bearer token
# ---------------------------------------------------------------------------


@pytest.fixture()
def test_client():
    """Minimal FastAPI test client with only the investors router mounted."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.routes.investors import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


class TestCreateInvestorRequiresAuth:
    """POST /api/investors/ must return 401 when no Bearer token is provided."""

    def test_no_auth_header_returns_401(self, test_client):
        resp = test_client.post(
            "/api/investors/",
            json={"name": "Warren Buffett"},
        )
        assert resp.status_code == 401

    def test_invalid_bearer_token_returns_401(self, test_client):
        resp = test_client.post(
            "/api/investors/",
            json={"name": "Warren Buffett"},
            headers={"Authorization": "Bearer not-a-real-token"},
        )
        assert resp.status_code == 401

    def test_response_does_not_reveal_db_state_on_missing_auth(self, test_client):
        """Error detail must not leak schema or stack-trace information."""
        resp = test_client.post(
            "/api/investors/",
            json={"name": "Warren Buffett"},
        )
        detail = resp.json().get("detail", "")
        assert "investor" not in str(detail).lower() or "auth" in str(detail).lower()


class TestBulkCreateInvestorsRequiresAuth:
    """POST /api/investors/bulk must return 401 when no Bearer token is provided."""

    def test_no_auth_header_returns_401(self, test_client):
        resp = test_client.post(
            "/api/investors/bulk",
            json=[{"name": "Warren Buffett"}],
        )
        assert resp.status_code == 401

    def test_invalid_bearer_token_returns_401(self, test_client):
        resp = test_client.post(
            "/api/investors/bulk",
            json=[{"name": "Warren Buffett"}],
            headers={"Authorization": "Bearer not-a-real-token"},
        )
        assert resp.status_code == 401
