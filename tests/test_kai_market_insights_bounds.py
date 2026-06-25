"""Tests proving market insights route query parameter bounds (CWE-400)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import market_insights


def _build_app() -> FastAPI:
    app = FastAPI()

    def _mock_require_vault_owner_token():
        return {"user_id": "user_123", "token": "valid_token"}

    app.dependency_overrides[require_vault_owner_token] = _mock_require_vault_owner_token
    app.include_router(market_insights.router)
    return app


def test_market_insights_rejects_oversized_symbols_query():
    client = TestClient(_build_app())
    response = client.get(
        "/market/insights/user_123",
        params={"symbols": "x" * 513},
    )

    assert response.status_code == 422


def test_market_insights_rejects_oversized_pick_source_query():
    client = TestClient(_build_app())
    response = client.get(
        "/market/insights/user_123",
        params={"pick_source": "x" * 257},
    )

    assert response.status_code == 422


def test_stock_preview_rejects_oversized_symbol_query():
    client = TestClient(_build_app())
    response = client.get(
        "/stock-preview/user_123",
        params={"symbol": "x" * 21},
    )

    assert response.status_code == 422


def test_stock_preview_rejects_oversized_pick_source_query():
    client = TestClient(_build_app())
    response = client.get(
        "/stock-preview/user_123",
        params={"symbol": "AAPL", "pick_source": "x" * 257},
    )

    assert response.status_code == 422
