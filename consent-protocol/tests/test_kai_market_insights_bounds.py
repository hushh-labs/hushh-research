"""Verify CWE-400: kai market insights query parameters are bounded."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import market_insights


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(market_insights.router, prefix="/api/kai")
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test_user_123",
        "token": "test",
    }
    return app


def test_market_insights_rejects_oversized_symbols():
    """GET /market/insights/{user_id} must reject symbols > 512 characters."""
    client = TestClient(_build_app())
    response = client.get(
        "/api/kai/market/insights/test_user_123",
        params={"symbols": "x" * 513},
    )
    assert response.status_code == 422


def test_market_insights_rejects_oversized_pick_source():
    """GET /market/insights/{user_id} must reject pick_source > 256 characters."""
    client = TestClient(_build_app())
    response = client.get(
        "/api/kai/market/insights/test_user_123",
        params={"pick_source": "x" * 257},
    )
    assert response.status_code == 422


def test_stock_preview_rejects_oversized_symbol():
    """GET /stock-preview/{user_id} must reject symbol > 20 characters."""
    client = TestClient(_build_app())
    response = client.get(
        "/api/kai/stock-preview/test_user_123",
        params={"symbol": "x" * 21},
    )
    assert response.status_code == 422


def test_stock_preview_rejects_oversized_pick_source():
    """GET /stock-preview/{user_id} must reject pick_source > 256 characters."""
    client = TestClient(_build_app())
    response = client.get(
        "/api/kai/stock-preview/test_user_123",
        params={"pick_source": "x" * 257},
    )
    assert response.status_code == 422
