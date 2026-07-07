# tests/test_kai_stream_ticker_gate.py
"""
Unit tests for the symbol-master membership gate on analysis-starting routes.

Regression context: voice STT misheard "Nvidia" as "YOUR". "YOUR" passes the
format-only _normalize_ticker_or_422 check, so a full multi-agent debate ran
against a nonexistent company and produced a composite score from fallback
defaults while every agent reported no coverage.

_require_known_ticker_or_422 closes that hole: a fresh debate/analysis start
now requires a real symbol-master match. The gate deliberately:
  - allows symbols when the ticker cache is empty (infra state must not block
    all analysis; classify() falls back to pattern acceptance)
  - rejects known-but-non-tradable identifiers
  - rejects unknown symbols when the cache is loaded
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from api.routes.kai.stream import _require_known_ticker_or_422


def _classification(reason: str, tradable: bool) -> SimpleNamespace:
    return SimpleNamespace(reason=reason, tradable=tradable)


class TestKnownTickerGate:
    def test_symbol_master_match_tradable_passes(self):
        with (
            patch("api.routes.kai.stream.get_symbol_master_service") as service,
            patch("hushh_mcp.services.ticker_cache.ticker_cache") as cache,
        ):
            service.return_value.classify.return_value = _classification(
                "symbol_master_match", tradable=True
            )
            cache.loaded = True
            assert _require_known_ticker_or_422("NVDA") == "NVDA"

    def test_symbol_master_match_non_tradable_rejected(self):
        with (
            patch("api.routes.kai.stream.get_symbol_master_service") as service,
            patch("hushh_mcp.services.ticker_cache.ticker_cache") as cache,
        ):
            service.return_value.classify.return_value = _classification(
                "symbol_master_match", tradable=False
            )
            cache.loaded = True
            with pytest.raises(HTTPException) as exc:
                _require_known_ticker_or_422("XXII")
            assert exc.value.status_code == 422
            assert exc.value.detail["code"] == "ANALYZE_TICKER_NOT_TRADABLE"

    def test_unknown_symbol_with_loaded_cache_rejected(self):
        """The exact 'YOUR' regression: pattern-valid, not a real symbol."""
        with (
            patch("api.routes.kai.stream.get_symbol_master_service") as service,
            patch("hushh_mcp.services.ticker_cache.ticker_cache") as cache,
        ):
            service.return_value.classify.return_value = _classification(
                "ticker_pattern_fallback", tradable=True
            )
            cache.loaded = True
            with pytest.raises(HTTPException) as exc:
                _require_known_ticker_or_422("YOUR")
            assert exc.value.status_code == 422
            assert exc.value.detail["code"] == "ANALYZE_TICKER_UNKNOWN"

    def test_trade_action_token_rejected(self):
        with (
            patch("api.routes.kai.stream.get_symbol_master_service") as service,
            patch("hushh_mcp.services.ticker_cache.ticker_cache") as cache,
        ):
            service.return_value.classify.return_value = _classification(
                "trade_action_token", tradable=False
            )
            cache.loaded = True
            with pytest.raises(HTTPException) as exc:
                _require_known_ticker_or_422("BUY")
            assert exc.value.status_code == 422
            assert exc.value.detail["code"] == "ANALYZE_TICKER_UNKNOWN"

    def test_cash_equivalent_rejected(self):
        with (
            patch("api.routes.kai.stream.get_symbol_master_service") as service,
            patch("hushh_mcp.services.ticker_cache.ticker_cache") as cache,
        ):
            service.return_value.classify.return_value = _classification(
                "cash_equivalent", tradable=False
            )
            cache.loaded = True
            with pytest.raises(HTTPException) as exc:
                _require_known_ticker_or_422("CASH")
            assert exc.value.status_code == 422

    def test_unverifiable_when_cache_empty_passes_through(self):
        """Cold-start/DB-miss must not turn into a hard analysis outage."""
        with (
            patch("api.routes.kai.stream.get_symbol_master_service") as service,
            patch("hushh_mcp.services.ticker_cache.ticker_cache") as cache,
        ):
            service.return_value.classify.return_value = _classification(
                "ticker_pattern_fallback", tradable=True
            )
            cache.loaded = False
            assert _require_known_ticker_or_422("NVDA") == "NVDA"
