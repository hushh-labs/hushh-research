"""Tests for the Indian market service layer."""

from __future__ import annotations

from hushh_mcp.services.indian_market_service import (
    is_indian_symbol,
    normalize_indian_symbol,
    resolve_index_symbol,
    resolve_spoken_to_symbol,
)
from hushh_mcp.services.symbol_master_service import get_symbol_master_service

# ---------------------------------------------------------------------------
# normalize_indian_symbol
# ---------------------------------------------------------------------------

class TestNormalizeIndianSymbol:
    def test_bare_symbol_gets_ns_suffix_by_default(self):
        assert normalize_indian_symbol("RELIANCE") == "RELIANCE.NS"

    def test_preserves_existing_ns_suffix(self):
        assert normalize_indian_symbol("RELIANCE.NS") == "RELIANCE.NS"

    def test_preserves_existing_bo_suffix(self):
        assert normalize_indian_symbol("RELIANCE.BO") == "RELIANCE.BO"

    def test_lowercase_uppercased(self):
        assert normalize_indian_symbol("reliance") == "RELIANCE.NS"

    def test_bse_default_exchange(self):
        assert normalize_indian_symbol("TCS", default_exchange="BSE") == "TCS.BO"

    def test_symbol_with_ampersand(self):
        assert normalize_indian_symbol("M&M") == "M&M.NS"


# ---------------------------------------------------------------------------
# is_indian_symbol
# ---------------------------------------------------------------------------

class TestIsIndianSymbol:
    def test_ns_suffix_is_indian(self):
        assert is_indian_symbol("RELIANCE.NS") is True

    def test_bo_suffix_is_indian(self):
        assert is_indian_symbol("ITC.BO") is True

    def test_us_symbol_not_indian(self):
        assert is_indian_symbol("AAPL") is False

    def test_empty_string(self):
        assert is_indian_symbol("") is False

    def test_case_insensitive(self):
        assert is_indian_symbol("tcs.ns") is True


# ---------------------------------------------------------------------------
# resolve_index_symbol
# ---------------------------------------------------------------------------

class TestResolveIndexSymbol:
    def test_nifty_resolves(self):
        assert resolve_index_symbol("nifty") == "^NSEI"

    def test_sensex_resolves(self):
        assert resolve_index_symbol("sensex") == "^BSESN"

    def test_bank_nifty_resolves(self):
        assert resolve_index_symbol("bank nifty") == "^NSEBANK"

    def test_case_insensitive_lookup(self):
        assert resolve_index_symbol("NIFTY 50") == "^NSEI"

    def test_unknown_returns_none(self):
        assert resolve_index_symbol("dow jones") is None


# ---------------------------------------------------------------------------
# resolve_spoken_to_symbol
# ---------------------------------------------------------------------------

class TestResolveSpokenToSymbol:
    def test_reliance_alias(self):
        assert resolve_spoken_to_symbol("reliance") == "RELIANCE.NS"

    def test_ril_alias(self):
        assert resolve_spoken_to_symbol("ril") == "RELIANCE.NS"

    def test_tcs_alias(self):
        assert resolve_spoken_to_symbol("tcs") == "TCS.NS"

    def test_hdfc_bank_alias(self):
        assert resolve_spoken_to_symbol("hdfc bank") == "HDFCBANK.NS"

    def test_unknown_returns_none(self):
        assert resolve_spoken_to_symbol("microsoft") is None


# ---------------------------------------------------------------------------
# SymbolMasterService Indian extensions
# ---------------------------------------------------------------------------

class TestSymbolMasterServiceIndian:
    def setup_method(self):
        self.svc = get_symbol_master_service()

    def test_is_indian_symbol_via_service(self):
        assert self.svc.is_indian_symbol("RELIANCE.NS") is True
        assert self.svc.is_indian_symbol("AAPL") is False

    def test_normalize_preserves_ns_suffix(self):
        assert self.svc.normalize("RELIANCE.NS") == "RELIANCE.NS"

    def test_normalize_preserves_bo_suffix(self):
        assert self.svc.normalize("ITC.BO") == "ITC.BO"

    def test_normalize_bare_symbol_unchanged(self):
        # Bare US-style symbols should still work
        result = self.svc.normalize("AAPL")
        assert result == "AAPL"

    def test_classify_indian_symbol_trust_tier(self):
        classification = self.svc.classify("RELIANCE.NS")
        assert classification.trust_tier == "indian_exchange_ticker"
        assert classification.tradable is True

    def test_classify_us_symbol_not_indian(self):
        classification = self.svc.classify("AAPL")
        assert classification.trust_tier != "indian_exchange_ticker"


# ---------------------------------------------------------------------------
# IndianMarketService (unit — no network calls needed for static data)
# ---------------------------------------------------------------------------

class TestIndianMarketServiceStaticSearch:
    def test_search_by_symbol_prefix(self):
        from hushh_mcp.services.indian_market_service import get_indian_market_service
        svc = get_indian_market_service()
        results = svc.search_symbol("reliance")
        assert any("RELIANCE" in r["symbol"] for r in results)

    def test_search_by_company_name(self):
        from hushh_mcp.services.indian_market_service import get_indian_market_service
        svc = get_indian_market_service()
        results = svc.search_symbol("tata consultancy")
        assert any("TCS" in r["symbol"] for r in results)

    def test_empty_query_returns_empty(self):
        from hushh_mcp.services.indian_market_service import get_indian_market_service
        svc = get_indian_market_service()
        assert svc.search_symbol("") == []

    def test_limit_respected(self):
        from hushh_mcp.services.indian_market_service import get_indian_market_service
        svc = get_indian_market_service()
        results = svc.search_symbol("a", limit=3)
        assert len(results) <= 3
