"""Synthetic quality-rule tests for Kai portfolio import normalization."""

from collections import Counter

import pytest

from api.routes.kai.portfolio import (
    _aggregate_holdings_by_symbol,
    _normalize_import_holding_light,
    _normalize_raw_holding_row,
    _validate_holding_row,
)
from hushh_mcp.kai_import.normalize_v2 import _allocation_mix_from_holdings
from hushh_mcp.kai_import.quality_v2 import build_holdings_quality_report_v2


@pytest.mark.parametrize(
    ("symbol", "name", "asset_type", "instrument_kind", "expected_kind"),
    [
        ("MCD", "McDonald's Corporation", "stock", None, "equity"),
        ("GS", "The Goldman Sachs Group, Inc.", "stock", None, "equity"),
        ("MCD", "McDonald's Corporation", "stock", "equity", "equity"),
        ("GS", "The Goldman Sachs Group, Inc.", "stock", "equity", "equity"),
        ("AGG", "Aggregate Bond ETF", "etf", "fixed_income", "fixed_income"),
        ("VNQ", "Real Estate ETF", "etf", "real_asset", "real_asset"),
        ("GLD", "Gold Shares ETF", "etf", "real_asset", "real_asset"),
        ("CD", "Certificate of Deposit", "certificate_of_deposit", None, "fixed_income"),
        ("", "Cash balance", "cash", None, "cash_equivalent"),
        ("GS", "The Goldman Sachs Group, Inc.", "stock", "other", "other"),
        ("MCD", "McDonald's Corporation", None, None, "other"),
        ("AGG", "Aggregate Bond ETF", "etf", None, "other"),
    ],
)
def test_current_import_preserves_declared_instrument_classification(
    symbol, name, asset_type, instrument_kind, expected_kind
):
    row = _normalize_import_holding_light(
        {
            "symbol": symbol,
            "name": name,
            "asset_type": asset_type,
            "instrument_kind": instrument_kind,
            "quantity": 2,
            "price": 100,
            "market_value": 200,
        },
        0,
    )
    assert row["instrument_kind"] == expected_kind
    assert row["market_value"] == 200
    assert row["is_cash_equivalent"] == (expected_kind == "cash_equivalent")
    if expected_kind == "equity":
        assert row["analyze_eligible"] is True
        assert row["security_listing_status"] == "sec_common_equity"
    if expected_kind == "other":
        assert row["analyze_eligible"] is False


def test_current_import_keeps_issuer_fragments_out_of_allocation():
    inputs = [
        ("MCD", "McDonald's Corporation", "stock", 22892.26),
        ("GS", "The Goldman Sachs Group, Inc.", "stock", 8564.26),
        ("AAPL", "Other equity position", "stock", 521122.03),
        ("CASH", "Cash balance", "cash", 7432.18),
    ]
    rows = [
        _normalize_import_holding_light(
            {"symbol": symbol, "name": name, "asset_type": asset_type, "market_value": value},
            index,
        )
        for index, (symbol, name, asset_type, value) in enumerate(inputs)
    ]
    allocation = {
        item["bucket"]: item["value"] for item in _allocation_mix_from_holdings(rows, 560010.73)
    }
    assert allocation["equity"] == 552578.55
    assert allocation["cash_equivalent"] == 7432.18
    assert allocation["fixed_income"] == 0
    assert allocation["real_asset"] == 0


def _validate_many(rows):
    validated = []
    dropped = Counter()
    for i, row in enumerate(rows):
        normalized = _normalize_raw_holding_row(row, i)
        ok, reason = _validate_holding_row(normalized)
        if not ok:
            dropped[reason or "unknown"] += 1
            continue
        validated.append(normalized)
    return validated, dropped


def test_placeholder_rows_are_removed_from_validated_set():
    rows = [
        {
            "name": "Unknown",
            "quantity": None,
            "price": None,
            "market_value": 900226.92,
        },
        {
            "symbol": "MSFT",
            "name": "Microsoft",
            "quantity": 5,
            "price": 350,
            "market_value": 1750,
        },
    ]

    validated, dropped = _validate_many(rows)
    assert len(validated) == 1
    assert validated[0]["symbol"] == "MSFT"
    assert sum(dropped.values()) >= 1


def test_account_header_like_rows_are_dropped():
    rows = [
        {
            "name": "John W. Doe - Traditional IRA",
            "quantity": None,
            "price": None,
            "market_value": None,
        },
        {
            "symbol": "AAPL",
            "name": "Apple",
            "quantity": 1,
            "price": 180,
            "market_value": 180,
        },
    ]

    validated, dropped = _validate_many(rows)
    assert len(validated) == 1
    assert dropped["account_header_row"] == 1


def test_zero_data_rows_are_dropped():
    rows = [
        {
            "symbol": "ABCD",
            "name": "Some Security",
            "quantity": None,
            "price": None,
            "market_value": None,
        }
    ]

    validated, dropped = _validate_many(rows)
    assert validated == []
    assert dropped["missing_financial_data"] == 1


def test_aggregation_math_merges_symbol_rows_correctly():
    rows = [
        {
            "symbol": "TSLA",
            "name": "Tesla",
            "quantity": 2,
            "price": 200,
            "market_value": 400,
            "cost_basis": 300,
            "unrealized_gain_loss": 100,
        },
        {
            "symbol": "TSLA",
            "name": "Tesla",
            "quantity": 3,
            "price": 220,
            "market_value": 660,
            "cost_basis": 500,
            "unrealized_gain_loss": 160,
        },
    ]

    validated, dropped = _validate_many(rows)
    assert dropped == {}

    aggregated = _aggregate_holdings_by_symbol(validated)
    assert len(aggregated) == 1
    result = aggregated[0]
    assert result["quantity"] == 5
    assert result["market_value"] == 1060
    assert result["cost_basis"] == 800
    assert result["unrealized_gain_loss"] == 260
    assert result["lots_count"] == 2
    assert "confidence" in result
    assert 0.0 <= result["confidence"] <= 1.0
    assert isinstance(result.get("provenance"), dict)


def test_quality_report_includes_required_quality_counters():
    report = build_holdings_quality_report_v2(
        raw_count=10,
        validated_count=7,
        aggregated_count=6,
        dropped_reasons=Counter({"account_header_row": 1, "placeholder_symbol": 2}),
        reconciled_count=3,
        mismatch_count=1,
        parse_diagnostics={"mode": "strict_json_only"},
        unknown_name_count=0,
        placeholder_symbol_count=0,
        zero_qty_zero_price_nonzero_value_count=0,
        account_header_row_count=1,
        duplicate_symbol_lot_count=1,
        average_confidence=0.84,
    )

    assert report["raw"] == 10
    assert report["validated"] == 7
    assert report["aggregated"] == 6
    assert report["dropped"] == 3
    assert report["dropped_reasons"]["account_header_row"] == 1
    assert report["duplicate_symbol_lot_count"] == 1
    assert report["average_confidence"] == 0.84
    assert "pass_timings_ms" in report
    assert "pass_token_counts" in report
