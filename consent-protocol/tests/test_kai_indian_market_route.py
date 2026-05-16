"""Route-level integration tests for the Indian market endpoints.

Canonical caller proof: the FastAPI router registered at
  api/routes/kai/__init__.py (included in server.py)
calls indian_market_service and the broker adapters.

These tests drive the HTTP surface directly (TestClient) so the
dependency chain  route → service → adapter  is exercised end-to-end
without any mocking at the route boundary.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Import-time stubs — mirror the pattern used by test_kai_voice_rollout_guardrails
# so that transitive imports through api.routes.kai don't fail in the local
# env (asyncpg / db / google.genai / sse_starlette absent).
# ---------------------------------------------------------------------------
if "asyncpg" not in sys.modules:
    _asyncpg = types.ModuleType("asyncpg")
    _asyncpg.Pool = type("Pool", (), {})  # type: ignore[attr-defined]
    _asyncpg.UndefinedColumnError = type("UndefinedColumnError", (Exception,), {})  # type: ignore[attr-defined]
    _asyncpg.UndefinedTableError = type("UndefinedTableError", (Exception,), {})  # type: ignore[attr-defined]
    sys.modules["asyncpg"] = _asyncpg
for _attr in ("UndefinedColumnError", "UndefinedTableError"):
    if not hasattr(sys.modules["asyncpg"], _attr):
        setattr(sys.modules["asyncpg"], _attr, type(_attr, (Exception,), {}))

if "db" not in sys.modules:
    _db = types.ModuleType("db")
    _db.__path__ = []  # type: ignore[attr-defined]
    sys.modules["db"] = _db
if "db.db_client" not in sys.modules:
    _db_client = types.ModuleType("db.db_client")
    _db_client.get_db = lambda: (_ for _ in ()).throw(RuntimeError("db not available"))  # type: ignore[attr-defined]
    _db_client.DatabaseExecutionError = type("DatabaseExecutionError", (Exception,), {})  # type: ignore[attr-defined]
    sys.modules["db.db_client"] = _db_client
if "db.connection" not in sys.modules:
    _db_conn = types.ModuleType("db.connection")
    async def _noop_get_pool():  # pragma: no cover
        return None
    _db_conn.get_pool = _noop_get_pool  # type: ignore[attr-defined]
    sys.modules["db.connection"] = _db_conn

for _mod in ("google", "google.genai", "google.genai.types"):
    if _mod not in sys.modules:
        sys.modules[_mod] = types.ModuleType(_mod)
sys.modules["google"].genai = sys.modules["google.genai"]  # type: ignore[attr-defined]
sys.modules["google.genai"].types = sys.modules["google.genai.types"]  # type: ignore[attr-defined]

if "sse_starlette" not in sys.modules:
    sys.modules["sse_starlette"] = types.ModuleType("sse_starlette")
if "sse_starlette.sse" not in sys.modules:
    _sse = types.ModuleType("sse_starlette.sse")
    _sse.EventSourceResponse = type("EventSourceResponse", (), {"__init__": lambda self, *a, **kw: None})  # type: ignore[attr-defined]
    sys.modules["sse_starlette.sse"] = _sse
sys.modules["sse_starlette"].EventSourceResponse = sys.modules["sse_starlette.sse"].EventSourceResponse  # type: ignore[attr-defined]

# Stub the kai package so __init__.py (which imports all sub-routers) is bypassed
ROOT = Path(__file__).resolve().parents[1]
if "api.routes.kai" not in sys.modules:
    _kai_pkg = types.ModuleType("api.routes.kai")
    _kai_pkg.__path__ = [str(ROOT / "api" / "routes" / "kai")]  # type: ignore[attr-defined]
    sys.modules["api.routes.kai"] = _kai_pkg

from api.routes.kai.indian_market import router  # noqa: E402


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


# ---------------------------------------------------------------------------
# /kai/indian-market/status — always works, no external calls
# ---------------------------------------------------------------------------


def test_indian_market_status_returns_enabled_and_provider():
    """GET /status proves the router → ZerodhaKiteConfig / UpstoxConfig call chain."""
    client = TestClient(_build_app())
    response = client.get("/kai/indian-market/status")

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["data_provider"] == "yfinance"
    assert "zerodha" in body["broker_providers"]
    assert "upstox" in body["broker_providers"]


def test_indian_market_status_broker_providers_have_configured_flag():
    client = TestClient(_build_app())
    body = client.get("/kai/indian-market/status").json()
    for provider in ("zerodha", "upstox"):
        assert "configured" in body["broker_providers"][provider]
        assert "missing" in body["broker_providers"][provider]


# ---------------------------------------------------------------------------
# /kai/indian-market/search — router → IndianMarketService.search_symbol()
# ---------------------------------------------------------------------------


def test_indian_market_search_returns_results_for_reliance():
    """GET /search proves router → IndianMarketService (bundled JSON, no network)."""
    client = TestClient(_build_app())
    response = client.get("/kai/indian-market/search", params={"q": "reliance"})

    assert response.status_code == 200
    body = response.json()
    assert "results" in body
    assert body["query"] == "reliance"
    assert body["count"] >= 1
    assert any("RELIANCE" in r.get("symbol", "") for r in body["results"])


def test_indian_market_search_requires_query_param():
    client = TestClient(_build_app())
    response = client.get("/kai/indian-market/search")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# /kai/indian-market/portfolio — router → ZerodhaKiteAdapter / UpstoxAdapter
# ---------------------------------------------------------------------------


def test_indian_market_portfolio_zerodha_returns_401_when_unconfigured():
    """GET /portfolio?broker=zerodha returns 401 when keys absent — adapter is called."""
    client = TestClient(_build_app())
    response = client.get("/kai/indian-market/portfolio", params={"broker": "zerodha"})
    assert response.status_code == 401
    assert "zerodha" in response.json()["detail"].lower()


def test_indian_market_portfolio_upstox_returns_401_when_unconfigured():
    client = TestClient(_build_app())
    response = client.get("/kai/indian-market/portfolio", params={"broker": "upstox"})
    assert response.status_code == 401
    assert "upstox" in response.json()["detail"].lower()


def test_indian_market_portfolio_unknown_broker_returns_400():
    client = TestClient(_build_app())
    response = client.get("/kai/indian-market/portfolio", params={"broker": "robinhood"})
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# /kai/indian-market/indices — router → IndianMarketService.get_indices()
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_indian_market_indices_route_calls_service():
    """GET /indices proves router → IndianMarketService.get_indices() (network patched)."""
    fake_indices = [
        {"symbol": "^NSEI", "display_name": "Nifty 50", "price": 22000.0, "change_pct": 0.5},
        {"symbol": "^BSESN", "display_name": "Sensex", "price": 73000.0, "change_pct": 0.3},
    ]
    with patch(
        "hushh_mcp.services.indian_market_service.IndianMarketService.get_indices",
        new_callable=AsyncMock,
        return_value=fake_indices,
    ):
        client = TestClient(_build_app())
        response = client.get("/kai/indian-market/indices")

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert body["indices"][0]["symbol"] == "^NSEI"
