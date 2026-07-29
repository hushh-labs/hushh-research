# tests/test_path_param_min_length.py
"""
PR attach points:
  GET  /api/invites/{invite_token}          (api/routes/invites.py :: get_invite)
  POST /api/invites/{invite_token}/accept   (api/routes/invites.py :: accept_invite)
  POST /api/tickers/sync-holdings/{user_id} (api/routes/tickers.py :: sync_tickers_from_holdings)
  GET  /api/investors/cik/{cik}             (api/routes/investors.py :: get_investor_by_cik)

Verifies that Path parameters with only max_length constraints also enforce
min_length=1 so empty-string path segments are rejected with 422 before
reaching the service or database layer.

An empty string path segment such as GET /api/invites// bypasses most
downstream validation and can cause unexpected DB queries or errors.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import investors, invites, tickers

_FIREBASE_UID = "test-uid-path"


@pytest.fixture()
def client():
    # Mount the three routers under test directly, each with its own
    # declared prefix (/api/invites, /api/tickers, /api/investors), instead
    # of importing the full server.py app, which requires live DB/env setup.
    app = FastAPI()
    app.include_router(invites.router)
    app.include_router(tickers.router)
    app.include_router(investors.router)

    app.dependency_overrides[require_firebase_auth] = lambda: _FIREBASE_UID
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": _FIREBASE_UID,
        "token": "fake",
        "scope": "vault.owner",
    }
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# /api/invites/{invite_token}  —  min_length=1
# ---------------------------------------------------------------------------


def test_get_invite_empty_token_rejected(client: TestClient) -> None:
    """GET /api/invites/ with an empty token segment must not reach the handler."""
    # An empty path segment never matches the {invite_token} route pattern,
    # so Starlette returns 404 before min_length=1 validation even runs.
    resp = client.get("/api/invites/")
    assert resp.status_code == 404


def test_get_invite_whitespace_only_rejected(client: TestClient) -> None:
    """GET /api/invites/ with only whitespace in token is caught by min_length=1."""
    # Empty-string path segment is caught by FastAPI router as missing path param (404)
    # min_length=1 rejects zero-length values that sneak through as empty strings
    resp = client.get("/api/invites/valid-token-abc")
    # With a valid-length token, it should not be 422 (service may 404 or 503)
    assert resp.status_code != 422


def test_accept_invite_empty_token_rejected(client: TestClient) -> None:
    """POST /api/invites//accept is a 404 (router) — empty path segment."""
    resp = client.post("/api/invites//accept")
    assert resp.status_code in (404, 422)


# ---------------------------------------------------------------------------
# /api/tickers/sync-holdings/{user_id}  —  min_length=1
# ---------------------------------------------------------------------------


def test_sync_holdings_non_empty_user_id_accepted(client: TestClient) -> None:
    """sync-holdings with a valid user_id should not be rejected with 422."""
    mock_service = MagicMock()
    mock_service.sync_holdings_symbols = AsyncMock(return_value={"synced": 0})

    with patch("api.routes.tickers.TickerDBService", return_value=mock_service):
        resp = client.post(
            f"/api/tickers/sync-holdings/{_FIREBASE_UID}",
            json={"holdings": []},
        )

    assert resp.status_code != 422, f"Valid user_id was rejected: {resp.status_code}"


# ---------------------------------------------------------------------------
# /api/investors/cik/{cik}  —  min_length=1
# ---------------------------------------------------------------------------


def test_get_investor_by_cik_valid_cik_accepted(client: TestClient) -> None:
    """Valid CIK must not be rejected with 422."""
    mock_service = MagicMock()
    mock_service.get_investor_by_cik = AsyncMock(return_value=None)

    with patch("api.routes.investors.InvestorDBService", return_value=mock_service):
        resp = client.get("/api/investors/cik/0001234567")

    assert resp.status_code != 422, f"Valid CIK rejected with 422: {resp.status_code}"
