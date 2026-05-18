"""
Pure unit tests for the module-level helper functions in
hushh_mcp/services/ticker_db.py.

All functions under test are pure (no DB, no network, no async) and had
zero dedicated test coverage before this file.  They are called on every
ticker lookup, enrichment, and portfolio normalisation pass.

Functions covered
-----------------
_clean_text(value)
    str(value or "").strip()

_normalize_symbol(raw)
    Uppercase, sanitize to [A-Z0-9.-], reject non-tradable / pattern-miss.

_normalize_sector(value)
    Map well-known keywords → canonical sector name; reject invalid metadata.

_normalize_industry(value)
    Clean + length-cap (120); reject invalid metadata strings.

_is_cash_like_holding(holding)
    Detect cash positions by symbol, name hints, asset_type, or flag.

_infer_sector_from_holding(holding)
    Cascade through explicit fields then fall back to name-based inference.

_infer_industry_from_holding(holding)
    Pull industry/sic_description/asset_category from the holding dict.

_build_sector_tags(sector_primary, industry_primary)
    Build a deduplicated tag list of at most 6 entries.

_confidence_score(*, has_sector, has_industry, has_sic)
    Weight-based score: base 0.2 + sector 0.4 + industry 0.25 + sic 0.15.

_normalize_ticker_row(row)
    Row dict reshape: adds aliases, normalises sector_tags type.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.ticker_db import (
    _build_sector_tags,
    _clean_text,
    _confidence_score,
    _infer_industry_from_holding,
    _infer_sector_from_holding,
    _is_cash_like_holding,
    _normalize_industry,
    _normalize_sector,
    _normalize_symbol,
    _normalize_ticker_row,
)

# ===========================================================================
# _clean_text
# ===========================================================================


class TestCleanText:
    def test_normal_string_returned_stripped(self):
        assert _clean_text("  AAPL  ") == "AAPL"

    def test_none_returns_empty_string(self):
        assert _clean_text(None) == ""

    def test_empty_string_returns_empty_string(self):
        assert _clean_text("") == ""

    def test_zero_int_returns_empty_string(self):
        # str(0 or "") = str("") = "" because 0 is falsy
        assert _clean_text(0) == ""

    def test_nonzero_int_stringified(self):
        assert _clean_text(42) == "42"

    def test_false_returns_empty_string(self):
        # str(False or "") = str("") = "" → ""
        assert _clean_text(False) == ""

    def test_whitespace_only_returns_empty(self):
        assert _clean_text("   ") == ""


# ===========================================================================
# _normalize_symbol
# ===========================================================================


class TestNormalizeSymbol:
    def test_valid_ticker_returned_uppercase(self):
        assert _normalize_symbol("aapl") == "AAPL"

    def test_valid_ticker_with_dot(self):
        assert _normalize_symbol("BRK.B") == "BRK.B"

    def test_valid_ticker_with_hyphen(self):
        assert _normalize_symbol("BF-B") == "BF-B"

    def test_none_returns_empty(self):
        assert _normalize_symbol(None) == ""

    def test_empty_string_returns_empty(self):
        assert _normalize_symbol("") == ""

    def test_non_tradable_cash_symbol(self):
        assert _normalize_symbol("CASH") == "CASH"

    def test_non_tradable_sweep_symbol(self):
        assert _normalize_symbol("SWEEP") == "CASH"

    def test_non_tradable_mmf_symbol(self):
        assert _normalize_symbol("MMF") == "CASH"

    def test_non_tradable_qacds_returns_cash(self):
        assert _normalize_symbol("QACDS") == "CASH"

    def test_non_tradable_buy_returns_empty(self):
        assert _normalize_symbol("BUY") == ""

    def test_non_tradable_sell_returns_empty(self):
        assert _normalize_symbol("SELL") == ""

    def test_non_tradable_dividend_returns_empty(self):
        assert _normalize_symbol("DIVIDEND") == ""

    def test_too_long_ticker_returns_empty(self):
        # Pattern requires 1-6 chars total (^[A-Z][A-Z0-9.\-]{0,5}$)
        assert _normalize_symbol("TOOLONG") == ""

    def test_invalid_chars_stripped_valid_remainder_returned(self):
        # "TSLA!" → invalid chars stripped → "TSLA" which passes the pattern
        assert _normalize_symbol("TSLA!") == "TSLA"

    def test_all_invalid_chars_returns_empty(self):
        # "!@#$" → stripped of all chars → "" → returns ""
        assert _normalize_symbol("!@#$") == ""

    def test_six_char_valid_ticker(self):
        # Exactly 6 chars fits: 1 leading + 5 more
        assert _normalize_symbol("ABCDEF") == "ABCDEF"

    def test_lowercase_input_uppercased(self):
        assert _normalize_symbol("msft") == "MSFT"

    def test_starts_with_digit_returns_empty(self):
        # Pattern requires first char to be [A-Z]
        assert _normalize_symbol("1AAPL") == ""


# ===========================================================================
# _normalize_sector
# ===========================================================================


class TestNormalizeSector:
    def test_none_returns_none(self):
        assert _normalize_sector(None) is None

    def test_empty_string_returns_none(self):
        assert _normalize_sector("") is None

    def test_invalid_metadata_value_returns_none(self):
        for invalid in ("n/a", "unknown", "null", "unclassified", "other", "misc"):
            assert _normalize_sector(invalid) is None, f"Expected None for {invalid!r}"

    def test_technology_keyword_matched(self):
        assert _normalize_sector("Information Technology") == "Technology"

    def test_semiconductor_keyword_matched(self):
        assert _normalize_sector("Semiconductors") == "Technology"

    def test_bank_keyword_matched(self):
        assert _normalize_sector("Banking") == "Financials"

    def test_financial_keyword_matched(self):
        assert _normalize_sector("Financial Services") == "Financials"

    def test_health_keyword_matched(self):
        assert _normalize_sector("Healthcare") == "Healthcare"

    def test_pharma_keyword_matched(self):
        assert _normalize_sector("Pharmaceutical") == "Healthcare"

    def test_energy_keyword_matched(self):
        assert _normalize_sector("Energy Production") == "Energy"

    def test_oil_keyword_matched(self):
        assert _normalize_sector("Oil & Gas") == "Energy"

    def test_reit_keyword_matched(self):
        assert _normalize_sector("REIT") == "Real Estate"

    def test_utility_keyword_matched(self):
        assert _normalize_sector("Utility Companies") == "Utilities"

    def test_gold_keyword_matched(self):
        # "Gold Mining" contains both "mining" (→ Materials) and "gold" (→ Commodities).
        # The keyword scan iterates _SECTOR_KEYWORDS in insertion order; "mining"
        # appears before "gold", so "Materials" is returned first.
        assert _normalize_sector("Gold Mining") == "Materials"

    def test_gold_only_matched_to_commodities(self):
        # "Gold ETF" does NOT contain "mining", so "gold" wins → "Commodities"
        assert _normalize_sector("Gold ETF") == "Commodities"

    def test_bond_keyword_matched(self):
        assert _normalize_sector("Treasury Bond") == "Fixed Income Taxable"

    def test_municipal_keyword_matched(self):
        # "Municipal Bond" contains both "bond" (→ Fixed Income Taxable) and
        # "municipal" (→ Fixed Income Tax-Exempt).  "bond" appears first in
        # _SECTOR_KEYWORDS, so it wins.
        assert _normalize_sector("Municipal Bond") == "Fixed Income Taxable"

    def test_municipal_only_matched_to_tax_exempt(self):
        # "Municipal Notes" contains "municipal" but not "bond" → Tax-Exempt
        assert _normalize_sector("Municipal Notes") == "Fixed Income Tax-Exempt"

    def test_cash_keyword_matched(self):
        assert _normalize_sector("Cash Account") == "Cash & Cash Equivalents"

    def test_unknown_sector_returned_as_is_up_to_80_chars(self):
        raw = "SomeNicheIndustry"
        assert _normalize_sector(raw) == raw

    def test_long_unknown_sector_truncated_to_80(self):
        raw = "X" * 100
        assert _normalize_sector(raw) == "X" * 80


# ===========================================================================
# _normalize_industry
# ===========================================================================


class TestNormalizeIndustry:
    def test_none_returns_none(self):
        assert _normalize_industry(None) is None

    def test_empty_returns_none(self):
        assert _normalize_industry("") is None

    def test_invalid_metadata_returns_none(self):
        for val in ("n/a", "unknown", "other", "misc"):
            assert _normalize_industry(val) is None

    def test_valid_industry_returned(self):
        assert _normalize_industry("Software & Services") == "Software & Services"

    def test_stripped_whitespace(self):
        assert _normalize_industry("  Banking  ") == "Banking"

    def test_long_industry_truncated_to_120(self):
        raw = "Y" * 150
        assert _normalize_industry(raw) == "Y" * 120

    def test_exactly_120_chars_unchanged(self):
        raw = "Z" * 120
        assert _normalize_industry(raw) == raw


# ===========================================================================
# _is_cash_like_holding
# ===========================================================================


class TestIsCashLikeHolding:
    def test_cash_symbol_is_cash(self):
        assert _is_cash_like_holding({"symbol": "CASH"}) is True

    def test_sweep_symbol_is_cash(self):
        # _normalize_symbol("SWEEP") → "CASH"
        assert _is_cash_like_holding({"symbol": "SWEEP"}) is True

    def test_name_with_cash_hint_is_cash(self):
        assert _is_cash_like_holding({"symbol": "X", "name": "Cash and Equivalents"}) is True

    def test_name_with_sweep_hint_is_cash(self):
        assert _is_cash_like_holding({"symbol": "X", "name": "Sweep Account"}) is True

    def test_name_with_money_market_hint_is_cash(self):
        assert _is_cash_like_holding({"symbol": "X", "name": "Money Market Fund"}) is True

    def test_asset_type_with_cash_hint_is_cash(self):
        assert _is_cash_like_holding({"symbol": "AAPL", "asset_type": "Cash"}) is True

    def test_is_cash_equivalent_flag(self):
        assert _is_cash_like_holding({"symbol": "AAPL", "is_cash_equivalent": True}) is True

    def test_regular_equity_not_cash(self):
        assert _is_cash_like_holding({"symbol": "AAPL", "name": "Apple Inc."}) is False

    def test_empty_holding_not_cash(self):
        assert _is_cash_like_holding({}) is False

    def test_name_core_position_is_cash(self):
        assert _is_cash_like_holding({"name": "Core Position"}) is True

    def test_name_deposit_is_cash(self):
        assert _is_cash_like_holding({"name": "Bank Deposit Account"}) is True


# ===========================================================================
# _infer_sector_from_holding
# ===========================================================================


class TestInferSectorFromHolding:
    def test_explicit_sector_field_used(self):
        assert _infer_sector_from_holding({"sector": "Technology"}) == "Technology"

    def test_sector_primary_used_as_fallback(self):
        result = _infer_sector_from_holding({"sector_primary": "Financials"})
        assert result == "Financials"

    def test_asset_category_used_as_fallback(self):
        result = _infer_sector_from_holding({"asset_category": "Energy"})
        assert result == "Energy"

    def test_name_based_inference(self):
        # "semiconductor" in name → "Technology"
        result = _infer_sector_from_holding({"name": "Broadcom Semiconductor"})
        assert result == "Technology"

    def test_empty_holding_returns_none(self):
        assert _infer_sector_from_holding({}) is None

    def test_invalid_sector_field_falls_through(self):
        # sector="unknown" is invalid → falls through to name inference → None
        result = _infer_sector_from_holding({"sector": "unknown"})
        assert result is None

    def test_asset_type_used_as_fallback(self):
        result = _infer_sector_from_holding({"asset_type": "Healthcare"})
        assert result == "Healthcare"


# ===========================================================================
# _infer_industry_from_holding
# ===========================================================================


class TestInferIndustryFromHolding:
    def test_explicit_industry_field_used(self):
        assert _infer_industry_from_holding({"industry": "Semiconductors"}) == "Semiconductors"

    def test_industry_primary_field_used(self):
        result = _infer_industry_from_holding({"industry_primary": "Banking"})
        assert result == "Banking"

    def test_sic_description_used(self):
        result = _infer_industry_from_holding({"sic_description": "Software Publishing"})
        assert result == "Software Publishing"

    def test_asset_category_used(self):
        result = _infer_industry_from_holding({"asset_category": "Fixed Income"})
        assert result == "Fixed Income"

    def test_empty_holding_returns_none(self):
        assert _infer_industry_from_holding({}) is None

    def test_invalid_industry_returns_none(self):
        assert _infer_industry_from_holding({"industry": "unknown"}) is None


# ===========================================================================
# _build_sector_tags
# ===========================================================================


class TestBuildSectorTags:
    def test_both_present_returns_list_of_two(self):
        result = _build_sector_tags("Technology", "Semiconductors")
        assert result == ["Technology", "Semiconductors"]

    def test_no_duplicates(self):
        result = _build_sector_tags("Technology", "Technology")
        assert result == ["Technology"]

    def test_none_sector_primary_excluded(self):
        result = _build_sector_tags(None, "Healthcare")
        assert result == ["Healthcare"]

    def test_none_industry_primary_excluded(self):
        result = _build_sector_tags("Energy", None)
        assert result == ["Energy"]

    def test_both_none_returns_empty_list(self):
        assert _build_sector_tags(None, None) == []

    def test_empty_string_excluded(self):
        assert _build_sector_tags("", "Healthcare") == ["Healthcare"]

    def test_result_capped_at_6(self):
        # Function receives only sector_primary and industry_primary (2 items max)
        # Cap-of-6 is therefore never reached with current callers, but the
        # implementation uses [:6] — verify it doesn't break with two items
        result = _build_sector_tags("A", "B")
        assert len(result) <= 6


# ===========================================================================
# _confidence_score
# ===========================================================================


class TestConfidenceScore:
    def test_no_signals_returns_base_score(self):
        # base = 0.2
        assert _confidence_score(has_sector=False, has_industry=False) == pytest.approx(0.2)

    def test_sector_only_adds_0_4(self):
        # 0.2 + 0.4 = 0.6
        assert _confidence_score(has_sector=True, has_industry=False) == pytest.approx(0.6)

    def test_industry_only_adds_0_25(self):
        # 0.2 + 0.25 = 0.45
        assert _confidence_score(has_sector=False, has_industry=True) == pytest.approx(0.45)

    def test_sector_and_industry_adds_both(self):
        # 0.2 + 0.4 + 0.25 = 0.85
        assert _confidence_score(has_sector=True, has_industry=True) == pytest.approx(0.85)

    def test_sic_adds_0_15(self):
        # 0.2 + 0.15 = 0.35
        assert _confidence_score(
            has_sector=False, has_industry=False, has_sic=True
        ) == pytest.approx(0.35)

    def test_all_signals_sums_to_1(self):
        # 0.2 + 0.4 + 0.25 + 0.15 = 1.0
        assert _confidence_score(has_sector=True, has_industry=True, has_sic=True) == pytest.approx(
            1.0
        )

    def test_result_capped_at_1(self):
        # All signals already sum exactly to 1.0 — verify cap doesn't break
        score = _confidence_score(has_sector=True, has_industry=True, has_sic=True)
        assert score <= 1.0

    def test_sic_default_is_false(self):
        # Omitting has_sic should be same as has_sic=False
        assert _confidence_score(has_sector=True, has_industry=True) == _confidence_score(
            has_sector=True, has_industry=True, has_sic=False
        )

    def test_returns_float(self):
        score = _confidence_score(has_sector=False, has_industry=False)
        assert isinstance(score, float)


# ===========================================================================
# _normalize_ticker_row
# ===========================================================================


class TestNormalizeTickerRow:
    def test_ticker_field_preserved(self):
        row = {"ticker": "AAPL", "title": "Apple Inc."}
        result = _normalize_ticker_row(row)
        assert result["ticker"] == "AAPL"

    def test_sector_alias_equals_sector_primary(self):
        row = {"sector_primary": "Technology", "industry_primary": "Semiconductors"}
        result = _normalize_ticker_row(row)
        assert result["sector"] == "Technology"
        assert result["industry"] == "Semiconductors"

    def test_sector_tags_list_preserved(self):
        row = {"sector_tags": ["Technology", "AI"]}
        result = _normalize_ticker_row(row)
        assert result["sector_tags"] == ["Technology", "AI"]

    def test_sector_tags_non_list_coerced_to_empty(self):
        row = {"sector_tags": "Technology"}
        result = _normalize_ticker_row(row)
        assert result["sector_tags"] == []

    def test_tradable_defaults_to_true(self):
        result = _normalize_ticker_row({})
        assert result["tradable"] is True

    def test_tradable_false_preserved(self):
        result = _normalize_ticker_row({"tradable": False})
        assert result["tradable"] is False

    def test_missing_optional_fields_are_none(self):
        result = _normalize_ticker_row({})
        for field in ("ticker", "title", "cik", "exchange", "sic_code", "metadata_confidence"):
            assert result[field] is None, f"Expected {field} to be None"

    def test_metadata_confidence_preserved(self):
        result = _normalize_ticker_row({"metadata_confidence": 0.85})
        assert result["metadata_confidence"] == pytest.approx(0.85)
