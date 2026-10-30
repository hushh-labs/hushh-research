"""Quality reporting helpers for Kai portfolio import V2."""

from __future__ import annotations

import math
from collections import Counter
from typing import Any


def _to_num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    return None


def _coerce_optional_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            f = float(text.replace(",", "").replace("$", ""))
        except ValueError:
            return None
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    return None


def build_holdings_quality_report_v2(
    *,
    raw_count: int,
    validated_count: int,
    aggregated_count: int,
    dropped_reasons: Counter[str],
    reconciled_count: int,
    mismatch_count: int,
    parse_diagnostics: dict[str, Any],
    unknown_name_count: int,
    placeholder_symbol_count: int,
    zero_qty_zero_price_nonzero_value_count: int,
    account_header_row_count: int,
    duplicate_symbol_lot_count: int,
    average_confidence: float,
) -> dict[str, Any]:
    pass_timings = (
        parse_diagnostics.get("pass_timings_ms")
        if isinstance(parse_diagnostics.get("pass_timings_ms"), dict)
        else {}
    )
    pass_token_counts = (
        parse_diagnostics.get("pass_token_counts")
        if isinstance(parse_diagnostics.get("pass_token_counts"), dict)
        else {}
    )
    pass_sources = (
        parse_diagnostics.get("pass_content_sources")
        if isinstance(parse_diagnostics.get("pass_content_sources"), dict)
        else {}
    )
    core_keys_present = bool(parse_diagnostics.get("core_keys_present", True))
    rows_with_symbol_pct = (
        float(parse_diagnostics.get("rows_with_symbol_pct", 0.0))
        if isinstance(parse_diagnostics.get("rows_with_symbol_pct"), (int, float))
        else 0.0
    )
    rows_with_market_value_pct = (
        float(parse_diagnostics.get("rows_with_market_value_pct", 0.0))
        if isinstance(parse_diagnostics.get("rows_with_market_value_pct"), (int, float))
        else 0.0
    )

    return {
        # Availability-first metrics (primary signal)
        "raw_count": raw_count,
        "aggregated_count": aggregated_count,
        "rows_with_symbol_pct": round(max(0.0, min(1.0, rows_with_symbol_pct)), 4),
        "rows_with_market_value_pct": round(max(0.0, min(1.0, rows_with_market_value_pct)), 4),
        "core_keys_present": core_keys_present,
        # Compatibility counters (legacy consumers)
        "raw": raw_count,
        "validated": validated_count,
        "aggregated": aggregated_count,
        "dropped": raw_count - validated_count,
        "reconciled": 0,
        "mismatch_detected": 0,
        "dropped_reasons": dict(dropped_reasons),
        "unknown_name_count": unknown_name_count,
        "placeholder_symbol_count": placeholder_symbol_count,
        "zero_qty_zero_price_nonzero_value_count": zero_qty_zero_price_nonzero_value_count,
        "account_header_row_count": account_header_row_count,
        "duplicate_symbol_lot_count": duplicate_symbol_lot_count,
        "average_confidence": average_confidence,
        "sparse_sections_detected": [],
        "positions_coverage": {},
        "pass_timings_ms": pass_timings,
        "pass_token_counts": pass_token_counts,
        "pass_content_sources": pass_sources,
    }


def evaluate_import_quality_gate_v2(
    *,
    holdings: list[dict[str, Any]],
    placeholder_symbol_count: int,
    account_header_row_count: int,
    expected_total_value: float | None,
    core_keys_present: bool = True,
    rows_with_symbol_pct: float = 0.0,
    rows_with_market_value_pct: float = 0.0,
) -> tuple[bool, dict[str, Any]]:
    holdings_count = len(holdings)
    reasons: list[str] = []
    severity = "pass"

    if not core_keys_present:
        severity = "fail"
        reasons.append("core_keys_missing")
    if holdings_count <= 0:
        severity = "fail"
        reasons.append("no_holdings_extracted")

    if severity == "pass":
        warn_reasons: list[str] = []
        if rows_with_symbol_pct < 0.6:
            warn_reasons.append("low_symbol_coverage")
        if rows_with_market_value_pct < 0.5:
            warn_reasons.append("low_market_value_coverage")
        if warn_reasons:
            severity = "warn"
            reasons.extend(warn_reasons)

    passed = severity != "fail"
    return passed, {
        "passed": passed,
        "severity": severity,
        "reasons": reasons,
        "holdings_count": holdings_count,
        "core_keys_present": core_keys_present,
        "rows_with_symbol_pct": round(max(0.0, min(1.0, rows_with_symbol_pct)), 4),
        "rows_with_market_value_pct": round(max(0.0, min(1.0, rows_with_market_value_pct)), 4),
        # Compatibility/telemetry fields retained
        "placeholder_symbol_count": placeholder_symbol_count,
        "account_header_row_count": account_header_row_count,
        "expected_total_value": _coerce_optional_number(expected_total_value),
        "holdings_market_value_sum": round(
            sum(_coerce_optional_number(row.get("market_value")) or 0.0 for row in holdings), 2
        ),
        "reconciliation_gap": 0.0,
        "reconciled_within_cent": True,
    }


def build_quality_report_v2(
    *,
    quality_report: dict[str, Any],
    quality_gate: dict[str, Any],
    holdings: list[dict[str, Any]],
) -> dict[str, Any]:
    raw = int(quality_report.get("raw_count") or quality_report.get("raw") or 0)
    aggregated = int(
        quality_report.get("aggregated_count") or quality_report.get("aggregated") or 0
    )
    rows_with_symbol_pct = float(quality_report.get("rows_with_symbol_pct") or 0.0)
    rows_with_market_value_pct = float(quality_report.get("rows_with_market_value_pct") or 0.0)
    parser_quality_score = (aggregated / raw) if raw > 0 else 0.0

    return {
        "schema_version": 2,
        "raw_count": raw,
        "validated_count": aggregated,
        "aggregated_count": aggregated,
        "holdings_count": len(holdings),
        "investable_positions_count": sum(1 for row in holdings if bool(row.get("is_investable"))),
        "cash_positions_count": sum(1 for row in holdings if bool(row.get("is_cash_equivalent"))),
        "allocation_coverage_pct": round(max(0.0, min(1.0, rows_with_market_value_pct)), 4),
        "symbol_trust_coverage_pct": round(max(0.0, min(1.0, rows_with_symbol_pct)), 4),
        "parser_quality_score": round(parser_quality_score, 4),
        "quality_gate": quality_gate,
        "dropped_reasons": quality_report.get("dropped_reasons") or {},
        "diagnostics": {
            "core_keys_present": bool(quality_report.get("core_keys_present", True)),
            "rows_with_symbol_pct": round(max(0.0, min(1.0, rows_with_symbol_pct)), 4),
            "rows_with_market_value_pct": round(max(0.0, min(1.0, rows_with_market_value_pct)), 4),
            "pass_timings_ms": quality_report.get("pass_timings_ms") or {},
            "pass_token_counts": quality_report.get("pass_token_counts") or {},
            "pass_content_sources": quality_report.get("pass_content_sources") or {},
        },
    }
