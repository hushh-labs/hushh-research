"""
Tests for Kai analyze + losers input validation bounds.

Canonical attach points
-----------------------
api.routes.kai.analyze.analyze_ticker
  -> payload: AnalyzeRequest (user_id max_length=128, ticker max_length=20,
                               consent_token max_length=1024)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.kai.losers.analyze_portfolio_losers
  -> payload: AnalyzeLosersRequest (user_id max_length=128, losers max_length=200,
                                    holdings max_length=500)
  -> FastAPI returns HTTP 422 when any bound is exceeded

Pydantic model unit tests cover AnalyzeRequest, AnalyzeLosersRequest,
PortfolioLoser, PortfolioHolding. Route-level tests below confirm the
bounds fire at the HTTP layer via real TestClient requests.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.kai.analyze import AnalyzeRequest
from api.routes.kai.losers import AnalyzeLosersRequest, PortfolioHolding, PortfolioLoser

# ---------------------------------------------------------------------------
# AnalyzeRequest
# ---------------------------------------------------------------------------


class TestAnalyzeRequestBounds:
    def test_valid_request_passes(self):
        req = AnalyzeRequest(user_id="user_abc", ticker="AAPL")
        assert req.ticker == "AAPL"
        assert req.user_id == "user_abc"

    def test_ticker_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeRequest(user_id="user_abc", ticker="A" * 21)

    def test_ticker_empty_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeRequest(user_id="user_abc", ticker="")

    def test_ticker_exactly_max_length_passes(self):
        req = AnalyzeRequest(user_id="user_abc", ticker="A" * 20)
        assert len(req.ticker) == 20

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeRequest(user_id="u" * 129, ticker="AAPL")

    def test_user_id_exactly_max_length_passes(self):
        req = AnalyzeRequest(user_id="u" * 128, ticker="AAPL")
        assert len(req.user_id) == 128

    def test_consent_token_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeRequest(user_id="user_abc", ticker="AAPL", consent_token="t" * 1025)

    def test_consent_token_exactly_max_length_passes(self):
        req = AnalyzeRequest(user_id="user_abc", ticker="AAPL", consent_token="t" * 1024)
        assert len(req.consent_token) == 1024

    def test_consent_token_none_passes(self):
        req = AnalyzeRequest(user_id="user_abc", ticker="AAPL", consent_token=None)
        assert req.consent_token is None

    def test_risk_profile_invalid_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeRequest(user_id="user_abc", ticker="AAPL", risk_profile="reckless")

    def test_risk_profile_defaults_to_balanced(self):
        req = AnalyzeRequest(user_id="user_abc", ticker="AAPL")
        assert req.risk_profile == "balanced"

    def test_processing_mode_defaults_to_hybrid(self):
        req = AnalyzeRequest(user_id="user_abc", ticker="AAPL")
        assert req.processing_mode == "hybrid"


# ---------------------------------------------------------------------------
# PortfolioLoser
# ---------------------------------------------------------------------------


class TestPortfolioLoserBounds:
    def test_valid_symbol_passes(self):
        loser = PortfolioLoser(symbol="TSLA")
        assert loser.symbol == "TSLA"

    def test_symbol_empty_raises(self):
        with pytest.raises(ValidationError):
            PortfolioLoser(symbol="")

    def test_symbol_too_long_raises(self):
        with pytest.raises(ValidationError):
            PortfolioLoser(symbol="X" * 21)

    def test_symbol_exactly_max_length_passes(self):
        loser = PortfolioLoser(symbol="S" * 20)
        assert len(loser.symbol) == 20


# ---------------------------------------------------------------------------
# PortfolioHolding
# ---------------------------------------------------------------------------


class TestPortfolioHoldingBounds:
    def test_valid_symbol_passes(self):
        holding = PortfolioHolding(symbol="NVDA")
        assert holding.symbol == "NVDA"

    def test_symbol_empty_raises(self):
        with pytest.raises(ValidationError):
            PortfolioHolding(symbol="")

    def test_symbol_too_long_raises(self):
        with pytest.raises(ValidationError):
            PortfolioHolding(symbol="Y" * 21)


# ---------------------------------------------------------------------------
# AnalyzeLosersRequest
# ---------------------------------------------------------------------------


class TestAnalyzeLosersRequestBounds:
    def _make_losers(self, n: int) -> list[dict]:
        return [{"symbol": f"L{i:04d}"[:5]} for i in range(n)]

    def _make_holdings(self, n: int) -> list[dict]:
        return [{"symbol": f"H{i:04d}"[:5]} for i in range(n)]

    def test_valid_request_passes(self):
        req = AnalyzeLosersRequest(user_id="uid123")
        assert req.user_id == "uid123"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(user_id="u" * 129)

    def test_user_id_exactly_max_length_passes(self):
        req = AnalyzeLosersRequest(user_id="u" * 128)
        assert len(req.user_id) == 128

    def test_losers_list_over_200_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(user_id="uid123", losers=self._make_losers(201))

    def test_losers_list_exactly_200_passes(self):
        req = AnalyzeLosersRequest(user_id="uid123", losers=self._make_losers(200))
        assert len(req.losers) == 200

    def test_holdings_list_over_500_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(user_id="uid123", holdings=self._make_holdings(501))

    def test_holdings_list_exactly_500_passes(self):
        req = AnalyzeLosersRequest(user_id="uid123", holdings=self._make_holdings(500))
        assert len(req.holdings) == 500

    def test_symbol_too_long_inside_loser_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(
                user_id="uid123",
                losers=[{"symbol": "TOOLONGSYMBOL12345678"}],
            )

    def test_symbol_too_long_inside_holding_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(
                user_id="uid123",
                holdings=[{"symbol": "TOOLONGSYMBOL12345678"}],
            )

    def test_max_positions_below_min_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(user_id="uid123", max_positions=0)

    def test_max_positions_above_max_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLosersRequest(user_id="uid123", max_positions=51)

    def test_max_positions_boundary_values_pass(self):
        low = AnalyzeLosersRequest(user_id="uid123", max_positions=1)
        high = AnalyzeLosersRequest(user_id="uid123", max_positions=50)
        assert low.max_positions == 1
        assert high.max_positions == 50


# ===========================================================================
# Canonical route-level caller proof
# ===========================================================================

from api.middleware import require_vault_owner_token  # noqa: E402
from api.routes.kai import router as kai_router  # noqa: E402

# kai_router is the exact router object server.py mounts via
# app.include_router(kai_router) (see api/routes/kai/__init__.py). Hitting
# it directly here -- rather than re-mounting the bare analyze/losers
# sub-router with no prefix -- proves the bounds fire on the canonical
# production path (/api/kai/analyze, /api/kai/portfolio/analyze-losers),
# not just an unprefixed standalone copy.


def _vault_owner_stub():
    return {"user_id": "test-uid", "token": "fake", "scope": "vault.owner"}


def _kai_client() -> TestClient:
    app = FastAPI()
    app.include_router(kai_router)
    app.dependency_overrides[require_vault_owner_token] = _vault_owner_stub
    return TestClient(app, raise_server_exceptions=False)


_analyze_client = _kai_client
_losers_client = _kai_client


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.kai.analyze.analyze_ticker
# POST /api/kai/analyze  ->  AnalyzeRequest
# ---------------------------------------------------------------------------


class TestAnalyzeTickerRouteInputBounds:
    """
    api.routes.kai.analyze.analyze_ticker is the canonical owner of
    AnalyzeRequest validation for POST /analyze.

    Proves FastAPI returns HTTP 422 when request bodies exceed the
    model bounds, before any service I/O.
    """

    _URL = "/api/kai/analyze"

    def test_valid_body_passes_validation(self):
        """A minimal valid body must not be rejected by validation."""
        resp = _analyze_client().post(
            self._URL, json={"user_id": "uid-abc", "ticker": "AAPL"}
        )
        assert resp.status_code != 422

    def test_ticker_over_max_returns_422(self):
        """ticker > 20 chars must be rejected with 422 at the framework layer."""
        resp = _analyze_client().post(
            self._URL, json={"user_id": "uid-abc", "ticker": "A" * 21}
        )
        assert resp.status_code == 422

    def test_empty_ticker_returns_422(self):
        """Empty ticker must be rejected with 422 (min_length=1 guard)."""
        resp = _analyze_client().post(
            self._URL, json={"user_id": "uid-abc", "ticker": ""}
        )
        assert resp.status_code == 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _analyze_client().post(
            self._URL, json={"user_id": "u" * 129, "ticker": "AAPL"}
        )
        assert resp.status_code == 422

    def test_consent_token_over_max_returns_422(self):
        """consent_token > 1024 chars must be rejected with 422."""
        resp = _analyze_client().post(
            self._URL,
            json={"user_id": "uid-abc", "ticker": "AAPL", "consent_token": "t" * 1025},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.kai.losers.analyze_portfolio_losers
# POST /portfolio/analyze-losers  ->  AnalyzeLosersRequest
# ---------------------------------------------------------------------------


class TestAnalyzePortfolioLosersRouteInputBounds:
    """
    api.routes.kai.losers.analyze_portfolio_losers is the canonical owner of
    AnalyzeLosersRequest validation for POST /portfolio/analyze-losers.

    Proves FastAPI returns HTTP 422 when request bodies exceed the model
    bounds, before any service I/O.
    """

    _URL = "/api/kai/portfolio/analyze-losers"

    def test_valid_body_passes_validation(self):
        """A minimal valid body must not be rejected by validation."""
        resp = _losers_client().post(self._URL, json={"user_id": "uid-abc"})
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _losers_client().post(self._URL, json={"user_id": "u" * 129})
        assert resp.status_code == 422

    def test_losers_list_over_max_returns_422(self):
        """losers list with > 200 items must be rejected with 422."""
        losers = [{"symbol": "AAPL"}] * 201
        resp = _losers_client().post(
            self._URL, json={"user_id": "uid-abc", "losers": losers}
        )
        assert resp.status_code == 422

    def test_symbol_over_max_in_loser_returns_422(self):
        """A loser with symbol > 20 chars must be rejected with 422."""
        resp = _losers_client().post(
            self._URL,
            json={"user_id": "uid-abc", "losers": [{"symbol": "X" * 21}]},
        )
        assert resp.status_code == 422
