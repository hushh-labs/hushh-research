# tests/test_investor_admin_auth.py
"""
PR attach points:
  POST /api/investors/       (api/routes/investors.py :: create_investor)
  POST /api/investors/bulk   (api/routes/investors.py :: bulk_create_investors)

Verifies that admin investor-ingestion endpoints require Firebase
authentication and return 401/403 when called without credentials.

Previously these endpoints had no authentication guard, allowing any
unauthenticated caller to insert or overwrite investor profiles.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth

_FIREBASE_UID = "test-uid-investor-admin"


@pytest.fixture()
def authed_client():
    """Client with mocked Firebase auth."""
    from api.main import app

    app.dependency_overrides[require_firebase_auth] = lambda: _FIREBASE_UID
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


@pytest.fixture()
def unauthed_client():
    """Client with NO auth overrides — simulates a request without Firebase token."""
    from api.main import app

    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# POST /api/investors/ — unauthenticated must be rejected
# ---------------------------------------------------------------------------


def test_create_investor_without_auth_rejected(unauthed_client: TestClient) -> None:
    """POST /api/investors/ without Firebase token must return 401 or 403."""
    resp = unauthed_client.post(
        "/api/investors/",
        json={"name": "Unauthorized Investor"},
    )
    assert resp.status_code in (401, 403), (
        f"Expected 401/403 for unauthenticated create_investor, got {resp.status_code}: {resp.text}"
    )


def test_create_investor_with_auth_not_rejected_401_403(authed_client: TestClient) -> None:
    """POST /api/investors/ with valid Firebase token must NOT return 401 or 403."""
    resp = authed_client.post(
        "/api/investors/",
        json={"name": "Test Fund Manager"},
    )
    # Auth guard passes; downstream may 422 (missing fields) or 500 (no DB) — both are fine
    assert resp.status_code not in (401, 403), (
        f"Authenticated request was rejected with auth error: {resp.status_code}"
    )


# ---------------------------------------------------------------------------
# POST /api/investors/bulk — unauthenticated must be rejected
# ---------------------------------------------------------------------------


def test_bulk_create_investors_without_auth_rejected(unauthed_client: TestClient) -> None:
    """POST /api/investors/bulk without Firebase token must return 401 or 403."""
    resp = unauthed_client.post(
        "/api/investors/bulk",
        json=[{"name": "Investor A"}, {"name": "Investor B"}],
    )
    assert resp.status_code in (401, 403), (
        f"Expected 401/403 for unauthenticated bulk_create_investors, got {resp.status_code}: {resp.text}"
    )


def test_bulk_create_investors_with_auth_not_rejected_401_403(authed_client: TestClient) -> None:
    """POST /api/investors/bulk with valid Firebase token must NOT return 401 or 403."""
    resp = authed_client.post(
        "/api/investors/bulk",
        json=[{"name": "Test Investor"}],
    )
    assert resp.status_code not in (401, 403), (
        f"Authenticated bulk request was rejected with auth error: {resp.status_code}"
    )
