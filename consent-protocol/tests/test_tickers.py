from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import tickers as tickers_module


def test_search_result_limit_enforcement_forwards_max_limit(monkeypatch):
    captured: dict[str, int | str] = {}

    class FakeTickerCache:
        loaded = True

        def search(self, query: str, *, limit: int):
            captured["query"] = query
            captured["limit"] = limit
            return [{"symbol": f"TICKER{i}"} for i in range(limit)]

    monkeypatch.setattr(tickers_module, "ticker_cache", FakeTickerCache())

    app = FastAPI()
    app.include_router(tickers_module.router)
    client = TestClient(app)

    response = client.get("/api/tickers/search", params={"q": "AAPL", "limit": "100"})

    assert response.status_code == 200
    assert captured == {"query": "AAPL", "limit": 100}
    assert len(response.json()) == 100
