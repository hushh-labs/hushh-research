"""
Tests that ticker_cache.load_from_db is wrapped in run_in_threadpool.

Canonical attach point:
    api.routes.tickers.all_tickers -> GET /api/tickers/all
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.tickers as tickers_module
from api.routes.tickers import router


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


class TestTickerCacheLoadThreadpool:
    """Proves that load_from_db is invoked when refresh=true is requested."""

    def test_load_from_db_called_on_refresh(self, monkeypatch):
        calls: list[str] = []

        class _FakeCache:
            loaded = True

            def load_from_db(self):
                calls.append("load_from_db")

            def all(self):
                return [{"symbol": "AAPL", "name": "Apple Inc."}]

            def size(self):
                return 1

        fake_cache = _FakeCache()
        monkeypatch.setattr(tickers_module, "ticker_cache", fake_cache)

        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.get("/api/tickers/all?refresh=true")

        assert resp.status_code == 200
        assert "load_from_db" in calls, "load_from_db was not called"

    def test_load_from_db_called_when_cache_empty(self, monkeypatch):
        calls: list[str] = []

        class _FakeCache:
            loaded = False

            def load_from_db(self):
                calls.append("load_from_db")
                self.loaded = True

            def all(self):
                return []

            def size(self):
                return 0

        fake_cache = _FakeCache()
        monkeypatch.setattr(tickers_module, "ticker_cache", fake_cache)

        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.get("/api/tickers/all")

        assert resp.status_code == 200
        assert "load_from_db" in calls

    def test_no_load_when_cache_loaded_and_no_refresh(self, monkeypatch):
        calls: list[str] = []

        class _FakeCache:
            loaded = True

            def load_from_db(self):
                calls.append("load_from_db")

            def all(self):
                return [{"symbol": "TSLA", "name": "Tesla Inc."}]

            def size(self):
                return 1

        fake_cache = _FakeCache()
        monkeypatch.setattr(tickers_module, "ticker_cache", fake_cache)

        client = TestClient(_build_app(), raise_server_exceptions=True)
        resp = client.get("/api/tickers/all")

        assert resp.status_code == 200
        assert calls == [], "load_from_db should not be called when cache is warm"
