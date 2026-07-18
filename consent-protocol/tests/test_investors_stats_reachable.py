"""
Regression proof: GET /api/investors/stats was shadowed by GET /api/investors/{investor_id}
because FastAPI resolves routes in declaration order. Moving /stats above /{investor_id}
makes the endpoint reachable.

Canonical attach point:
    api.routes.investors.get_investor_stats -> GET /api/investors/stats
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.investors as investors_module
from api.routes.investors import router


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


class TestInvestorStatsReachable:
    def test_stats_route_returns_non_422(self):
        """Prove /stats is not captured as investor_id=stats (which would 422)."""
        app = _build_app()
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(
            investors_module.InvestorDBService,
            "get_investor_stats",
            new=AsyncMock(return_value={"total": 0, "by_type": {}}),
        ):
            resp = client.get("/api/investors/stats")
        assert resp.status_code != 422, (
            "422 means /stats was captured as /{investor_id} - route order not fixed"
        )

    def test_stats_route_returns_200(self):
        """Prove /stats resolves to the stats handler and returns 200 with mocked DB."""
        app = _build_app()
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(
            investors_module.InvestorDBService,
            "get_investor_stats",
            new=AsyncMock(return_value={"total": 42, "by_type": {"fund_manager": 10}}),
        ):
            resp = client.get("/api/investors/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_profiles"] == 42

    def test_investor_id_route_still_works(self):
        """Prove /{investor_id} still resolves correctly after reorder."""
        app = _build_app()
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(
            investors_module.InvestorDBService,
            "get_investor_by_id",
            new=AsyncMock(return_value=None),
        ):
            resp = client.get("/api/investors/999")
        # 404 (not found) means the route matched correctly; 422 would mean validation failure
        assert resp.status_code != 422
        assert resp.status_code == 404
