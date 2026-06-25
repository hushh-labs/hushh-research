# consent-protocol/tests/test_portfolio_route_bounds.py
"""
CWE-400 bounds tests for kai/portfolio.py route parameters.

Verifies that oversized path, query, and form params are rejected with 422
before any business logic is reached.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import middleware as api_middleware
from api.routes.kai import portfolio as portfolio_mod


def _stub_auth():
    return {"user_id": "uid_test_123"}


def _make_app():
    app = FastAPI()
    app.include_router(portfolio_mod.router, prefix="/api/kai")
    app.dependency_overrides[api_middleware.require_vault_owner_token] = _stub_auth
    return app


@pytest.fixture(scope="module")
def client():
    return TestClient(_make_app(), raise_server_exceptions=False)


_LONG_128 = "x" * 129


def test_portfolio_summary_user_id_too_long(client):
    resp = client.get(f"/api/kai/portfolio/summary/{_LONG_128}")
    assert resp.status_code == 422


def test_portfolio_summary_user_id_ok(client):
    resp = client.get("/api/kai/portfolio/summary/uid_test_123")
    # Auth passes; 404/500 expected from missing backend, not 422
    assert resp.status_code != 422


def test_dashboard_picks_user_id_too_long(client):
    resp = client.get(f"/api/kai/dashboard/profile-picks/{_LONG_128}")
    assert resp.status_code == 422


def test_dashboard_picks_symbols_too_long(client):
    resp = client.get(
        "/api/kai/dashboard/profile-picks/uid_test_123",
        params={"symbols": "A" * 2049},
    )
    assert resp.status_code == 422


def test_dashboard_picks_symbols_ok(client):
    resp = client.get(
        "/api/kai/dashboard/profile-picks/uid_test_123",
        params={"symbols": "AAPL,MSFT,GOOG"},
    )
    assert resp.status_code != 422


def test_import_run_active_user_id_too_long(client):
    resp = client.get(
        "/api/kai/portfolio/import/run/active",
        params={"user_id": _LONG_128},
    )
    assert resp.status_code == 422


def test_import_run_stream_run_id_too_long(client):
    resp = client.get(f"/api/kai/portfolio/import/run/{_LONG_128}/stream?user_id=uid_test_123")
    assert resp.status_code == 422


def test_import_run_stream_user_id_too_long(client):
    resp = client.get(
        "/api/kai/portfolio/import/run/run_123/stream",
        params={"user_id": _LONG_128},
    )
    assert resp.status_code == 422


def test_cancel_run_run_id_too_long(client):
    resp = client.post(f"/api/kai/portfolio/import/run/{_LONG_128}/cancel?user_id=uid_test_123")
    assert resp.status_code == 422


def test_cancel_run_user_id_too_long(client):
    resp = client.post(
        "/api/kai/portfolio/import/run/run_123/cancel",
        params={"user_id": _LONG_128},
    )
    assert resp.status_code == 422
