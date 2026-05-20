"""
Hermetic tests for input-bound validation on the investor routes.

All tests use an isolated FastAPI app that mounts only the investor router
with the InvestorDBService stubbed out.  No database, no network.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import api.routes.investors as investors_module
from api.routes.investors import _BULK_INVESTOR_MAX, router

# ---------------------------------------------------------------------------
# Minimal test app
# ---------------------------------------------------------------------------


def _build_client() -> TestClient:
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


_VALID_INVESTOR: dict[str, Any] = {"name": "Warren Buffett"}


# ---------------------------------------------------------------------------
# InvestorCreateRequest field constraints
# ---------------------------------------------------------------------------


class TestInvestorCreateRequestBounds:
    def test_name_max_length_accepted(self):
        from api.routes.investors import InvestorCreateRequest

        obj = InvestorCreateRequest(name="A" * 200)
        assert len(obj.name) == 200

    def test_name_over_max_length_rejected(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="A" * 201)

    def test_cik_max_length_accepted(self):
        from api.routes.investors import InvestorCreateRequest

        obj = InvestorCreateRequest(name="X", cik="1" * 20)
        assert obj.cik == "1" * 20

    def test_cik_over_max_length_rejected(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", cik="1" * 21)

    def test_firm_max_length_accepted(self):
        from api.routes.investors import InvestorCreateRequest

        obj = InvestorCreateRequest(name="X", firm="F" * 200)
        assert len(obj.firm) == 200

    def test_firm_over_max_length_rejected(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", firm="F" * 201)

    def test_title_max_length_accepted(self):
        from api.routes.investors import InvestorCreateRequest

        obj = InvestorCreateRequest(name="X", title="T" * 100)
        assert len(obj.title) == 100

    def test_title_over_max_length_rejected(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", title="T" * 101)

    def test_biography_max_length_accepted(self):
        from api.routes.investors import InvestorCreateRequest

        obj = InvestorCreateRequest(name="X", biography="B" * 10_000)
        assert len(obj.biography) == 10_000

    def test_biography_over_max_length_rejected(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", biography="B" * 10_001)

    def test_insider_company_ticker_max_length_accepted(self):
        from api.routes.investors import InvestorCreateRequest

        obj = InvestorCreateRequest(name="X", insider_company_ticker="A" * 10)
        assert len(obj.insider_company_ticker) == 10

    def test_insider_company_ticker_over_max_length_rejected(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", insider_company_ticker="A" * 11)

    def test_risk_tolerance_max_length(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", risk_tolerance="R" * 51)

    def test_time_horizon_max_length(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", time_horizon="T" * 51)

    def test_portfolio_turnover_max_length(self):
        from pydantic import ValidationError

        from api.routes.investors import InvestorCreateRequest

        with pytest.raises(ValidationError):
            InvestorCreateRequest(name="X", portfolio_turnover="P" * 51)


# ---------------------------------------------------------------------------
# GET /search - name query param bounds
# ---------------------------------------------------------------------------


class TestSearchQueryBounds:
    def test_name_below_min_length_returns_422(self):
        client = _build_client()
        r = client.get("/api/investors/search", params={"name": "A"})
        assert r.status_code == 422

    def test_name_at_min_length_passes_validation(self):
        client = _build_client()
        with patch.object(
            investors_module.InvestorDBService,
            "search_investors",
            new=AsyncMock(return_value=[]),
        ):
            r = client.get("/api/investors/search", params={"name": "AB"})
        assert r.status_code == 200

    def test_name_at_max_length_passes_validation(self):
        client = _build_client()
        with patch.object(
            investors_module.InvestorDBService,
            "search_investors",
            new=AsyncMock(return_value=[]),
        ):
            r = client.get("/api/investors/search", params={"name": "A" * 200})
        assert r.status_code == 200

    def test_name_over_max_length_returns_422(self):
        client = _build_client()
        r = client.get("/api/investors/search", params={"name": "A" * 201})
        assert r.status_code == 422

    def test_limit_above_max_returns_422(self):
        client = _build_client()
        r = client.get("/api/investors/search", params={"name": "AB", "limit": 51})
        assert r.status_code == 422

    def test_limit_below_min_returns_422(self):
        client = _build_client()
        r = client.get("/api/investors/search", params={"name": "AB", "limit": 0})
        assert r.status_code == 422

    def test_missing_name_returns_422(self):
        client = _build_client()
        r = client.get("/api/investors/search")
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# GET /cik/{cik} - path param bounds
# ---------------------------------------------------------------------------


class TestCIKPathBounds:
    def test_cik_at_max_length_accepted(self):
        client = _build_client()
        cik = "1" * 20
        with patch.object(
            investors_module.InvestorDBService,
            "get_investor_by_cik",
            new=AsyncMock(return_value=None),
        ):
            r = client.get(f"/api/investors/cik/{cik}")
        assert r.status_code == 404  # not found but validation passed

    def test_cik_over_max_length_returns_422(self):
        client = _build_client()
        cik = "1" * 21
        r = client.get(f"/api/investors/cik/{cik}")
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# POST /bulk - list length cap
# ---------------------------------------------------------------------------


class TestBulkCreateBounds:
    def test_bulk_constant_is_positive(self):
        assert _BULK_INVESTOR_MAX > 0

    def test_bulk_within_limit_accepted(self):
        client = _build_client()
        payload = [{"name": f"Investor {i}"} for i in range(3)]
        with patch.object(
            investors_module.InvestorDBService,
            "upsert_investor",
            new=AsyncMock(return_value={"id": 1}),
        ):
            r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 201
        assert r.json()["created"] == 3

    def test_bulk_exactly_at_limit_accepted(self):
        client = _build_client()
        payload = [{"name": f"Investor {i}"} for i in range(_BULK_INVESTOR_MAX)]
        with patch.object(
            investors_module.InvestorDBService,
            "upsert_investor",
            new=AsyncMock(return_value={"id": 1}),
        ):
            r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 201

    def test_bulk_one_over_limit_returns_422(self):
        client = _build_client()
        payload = [{"name": f"Investor {i}"} for i in range(_BULK_INVESTOR_MAX + 1)]
        r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 422

    def test_bulk_far_over_limit_returns_422(self):
        client = _build_client()
        payload = [{"name": f"Investor {i}"} for i in range(_BULK_INVESTOR_MAX + 100)]
        r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 422

    def test_bulk_over_limit_error_message_mentions_limit(self):
        client = _build_client()
        payload = [{"name": f"Investor {i}"} for i in range(_BULK_INVESTOR_MAX + 1)]
        r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 422
        body = r.json()
        detail = body.get("detail", "")
        assert str(_BULK_INVESTOR_MAX) in detail

    def test_bulk_empty_list_returns_201(self):
        client = _build_client()
        r = client.post("/api/investors/bulk", json=[])
        assert r.status_code == 201
        assert r.json()["created"] == 0

    def test_bulk_invalid_investor_name_too_long_returns_422(self):
        client = _build_client()
        payload = [{"name": "A" * 201}]
        r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 422

    def test_bulk_investor_missing_name_returns_422(self):
        client = _build_client()
        payload = [{"firm": "Some Firm"}]  # name is required
        r = client.post("/api/investors/bulk", json=payload)
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# Constant sanity
# ---------------------------------------------------------------------------


class TestModuleConstants:
    def test_bulk_max_is_500(self):
        assert _BULK_INVESTOR_MAX == 500

    def test_bulk_max_is_int(self):
        assert isinstance(_BULK_INVESTOR_MAX, int)
