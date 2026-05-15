"""
Hermetic tests for session route error handling and input bounds.

Covers:
- get_consent_history returns 500 (not 200) on DB failure
- get_active_consents returns 500 (not 200) on DB failure
- userId max_length=128 enforced on both endpoints
- page ge=1 / le=10_000 enforced on /consent/history
- limit ge=1 / le=200 enforced on /consent/history
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Minimal stubs so importing the router never touches real infrastructure
# ---------------------------------------------------------------------------

_FAKE_TOKEN_DATA = {"user_id": "user-abc", "scope": "VAULT_OWNER"}


def _make_app() -> FastAPI:
    """Return a self-contained FastAPI instance with the session router mounted."""
    app = FastAPI()

    # Patch heavy deps before the router module is imported into our app scope
    with (
        patch("api.middleware.require_vault_owner_token", return_value=_FAKE_TOKEN_DATA),
        patch("api.utils.firebase_admin.get_firebase_auth_app", return_value=MagicMock()),
    ):
        # Override the dependency so every request is pre-authenticated
        from api.middleware import require_vault_owner_token
        from api.routes.session import router

        app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN_DATA
        app.include_router(router)

    return app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(_make_app(), raise_server_exceptions=False)


# ===========================================================================
# get_consent_history - error path
# ===========================================================================


def test_consent_history_db_error_returns_500(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        side_effect=RuntimeError("db down"),
    ):
        resp = client.get("/api/consent/history?userId=user-abc&page=1&limit=10")
    assert resp.status_code == 500, resp.text


def test_consent_history_db_error_is_not_200(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        side_effect=Exception("unexpected"),
    ):
        resp = client.get("/api/consent/history?userId=user-abc")
    assert resp.status_code != 200, "DB failure must not silently return 200"


def test_consent_history_db_error_body_has_no_error_key(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        side_effect=Exception("unexpected"),
    ):
        resp = client.get("/api/consent/history?userId=user-abc")
    body = resp.json()
    assert "error" not in body or resp.status_code == 500


# ===========================================================================
# get_active_consents - error path
# ===========================================================================


def test_active_consents_db_error_returns_500(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_active_tokens",
        new_callable=AsyncMock,
        side_effect=RuntimeError("db down"),
    ):
        resp = client.get("/api/consent/active?userId=user-abc")
    assert resp.status_code == 500, resp.text


def test_active_consents_db_error_is_not_200(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_active_tokens",
        new_callable=AsyncMock,
        side_effect=Exception("unexpected"),
    ):
        resp = client.get("/api/consent/active?userId=user-abc")
    assert resp.status_code != 200, "DB failure must not silently return 200"


def test_active_consents_db_error_body_has_no_error_key(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_active_tokens",
        new_callable=AsyncMock,
        side_effect=Exception("unexpected"),
    ):
        resp = client.get("/api/consent/active?userId=user-abc")
    body = resp.json()
    assert "error" not in body or resp.status_code == 500


# ===========================================================================
# userId max_length=128 bounds
# ===========================================================================


def test_consent_history_userid_too_long_returns_422(client: TestClient):
    long_id = "x" * 129
    resp = client.get(f"/api/consent/history?userId={long_id}")
    assert resp.status_code == 422


def test_consent_history_userid_at_max_length_accepted(client: TestClient):
    max_id = "a" * 128
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        return_value={"items": [], "page": 1, "limit": 50, "total": 0},
    ):
        # token mismatch expected (128-char id != "user-abc"), but validation passes
        resp = client.get(f"/api/consent/history?userId={max_id}")
    assert resp.status_code in (200, 403), f"Unexpected {resp.status_code}"


def test_active_consents_userid_too_long_returns_422(client: TestClient):
    long_id = "y" * 129
    resp = client.get(f"/api/consent/active?userId={long_id}")
    assert resp.status_code == 422


def test_active_consents_userid_at_max_length_accepted(client: TestClient):
    max_id = "b" * 128
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_active_tokens",
        new_callable=AsyncMock,
        return_value=[],
    ):
        resp = client.get(f"/api/consent/active?userId={max_id}")
    assert resp.status_code in (200, 403), f"Unexpected {resp.status_code}"


# ===========================================================================
# page bounds on /consent/history
# ===========================================================================


def test_consent_history_page_zero_returns_422(client: TestClient):
    resp = client.get("/api/consent/history?userId=user-abc&page=0")
    assert resp.status_code == 422


def test_consent_history_page_negative_returns_422(client: TestClient):
    resp = client.get("/api/consent/history?userId=user-abc&page=-1")
    assert resp.status_code == 422


def test_consent_history_page_over_max_returns_422(client: TestClient):
    resp = client.get("/api/consent/history?userId=user-abc&page=10001")
    assert resp.status_code == 422


def test_consent_history_page_at_max_accepted(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        return_value={"items": [], "page": 10000, "limit": 50, "total": 0},
    ):
        resp = client.get("/api/consent/history?userId=user-abc&page=10000")
    assert resp.status_code in (200, 403)


def test_consent_history_page_one_accepted(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        return_value={"items": [], "page": 1, "limit": 50, "total": 0},
    ):
        resp = client.get("/api/consent/history?userId=user-abc&page=1")
    assert resp.status_code in (200, 403)


# ===========================================================================
# limit bounds on /consent/history
# ===========================================================================


def test_consent_history_limit_zero_returns_422(client: TestClient):
    resp = client.get("/api/consent/history?userId=user-abc&limit=0")
    assert resp.status_code == 422


def test_consent_history_limit_over_max_returns_422(client: TestClient):
    resp = client.get("/api/consent/history?userId=user-abc&limit=201")
    assert resp.status_code == 422


def test_consent_history_limit_at_max_accepted(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        return_value={"items": [], "page": 1, "limit": 200, "total": 0},
    ):
        resp = client.get("/api/consent/history?userId=user-abc&limit=200")
    assert resp.status_code in (200, 403)


def test_consent_history_limit_one_accepted(client: TestClient):
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        return_value={"items": [], "page": 1, "limit": 1, "total": 0},
    ):
        resp = client.get("/api/consent/history?userId=user-abc&limit=1")
    assert resp.status_code in (200, 403)


# ===========================================================================
# happy path sanity checks
# ===========================================================================


def test_consent_history_happy_path(client: TestClient):
    fake_item = {
        "agent_id": "agent-1",
        "action": "approve",
        "created_at": "2024-01-01T00:00:00",
    }
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_audit_log",
        new_callable=AsyncMock,
        return_value={"items": [fake_item], "page": 1, "limit": 50, "total": 1},
    ):
        resp = client.get("/api/consent/history?userId=user-abc")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert "grouped" in body


def test_active_consents_happy_path(client: TestClient):
    fake_token = {
        "developer": "developer:myapp",
        "scope": "read",
        "id": "tok-1",
        "issued_at": "2024-01-01",
        "expires_at": "2024-12-31",
        "time_remaining_ms": 1000,
    }
    with patch(
        "hushh_mcp.services.consent_db.ConsentDBService.get_active_tokens",
        new_callable=AsyncMock,
        return_value=[fake_token],
    ):
        resp = client.get("/api/consent/active?userId=user-abc")
    assert resp.status_code == 200
    body = resp.json()
    assert "grouped" in body
    assert "active" in body
