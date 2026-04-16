"""Normalization and analytics builders for Kai portfolio import V2."""

from __future__ import annotations

import math
from collections import Counter
from datetime import datetime, timezone
from typing import Any


def _to_num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").replace("%", "").strip()
        if not cleaned:
            return None
        negative = cleaned.startswith("(") and cleaned.endswith(")")
        cleaned = cleaned.replace("(", "").replace(")", "")
        try:
            num = float(cleaned)
            return -num if negative else num
        except ValueError:
            return None
    return None


def _to_text(value: Any) -> str:
    return str(value or "").strip()


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _statement_period(account_info: dict[str, Any]) -> dict[str, Any]:
    return {
        "start": account_info.get("statement_period_start") or None,
        "end": account_info.get("statement_period_end") or None,
    }


def _allocation_mix_from_holdings(
    holdings: list[dict[str, Any]], total_value: float
) -> list[dict[str, Any]]:
    buckets: dict[str, float] = {
        "cash_equivalent": 0.0,
        "equity": 0.0,
        "fixed_income": 0.0,
        "real_asset": 0.0,
        "other": 0.0,
    }
    for row in holdings:
        bucket = _to_text(row.get("instrument_kind")).lower() or "other"
        if bucket not in buckets:
            bucket = "other"
        buckets[bucket] += _to_num(row.get("market_value")) or 0.0

    out: list[dict[str, Any]] = []
    denom = total_value if total_value > 0 else sum(buckets.values())
    denom = denom if denom > 0 else 1.0
    for key, value in buckets.items():
        out.append(
            {
                "bucket": key,
                "value": round(value, 2),
                "pct": round((value / denom) * 100.0, 4),
            }
        )
    return out


def build_financial_portfolio_canonical_v2(
    *,
    raw_extract_v2: dict[str, Any],
    account_info: dict[str, Any],
    account_summary: dict[str, Any],
    holdings: list[dict[str, Any]],
    asset_allocation: list[dict[str, Any]] | dict[str, Any] | None,
    total_value: float,
    cash_balance: float | None,
    quality_report_v2: dict[str, Any],
) -> dict[str, Any]:
    statement_period = _statement_period(account_info)
    statement_details = _as_dict(raw_extract_v2.get("statement_details"))
    account_metadata = _as_dict(raw_extract_v2.get("account_metadata"))

    cash_ledger_rows = [row for row in holdings if bool(row.get("is_cash_equivalent"))]
    cash_ledger_value = round(
        sum((_to_num(row.get("market_value")) or 0.0) for row in cash_ledger_rows),
        2,
    )

    return {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "account_info": {
            "account_number": account_info.get("account_number"),
            "account_type": account_info.get("account_type"),
            "account_holder": account_info.get("holder_name") or account_info.get("account_holder"),
            "brokerage_name": account_info.get("brokerage") or account_info.get("brokerage_name"),
            "institution_name": account_info.get("institution_name"),
            "statement_period": statement_period,
            "statement_details": statement_details,
            "account_metadata": account_metadata,
        },
        "account_summary": account_summary,
        "holdings": holdings,
        "asset_allocation": asset_allocation,
        "cash_ledger": {
            "rows": cash_ledger_rows,
            "total_cash_equivalent_value": cash_ledger_value,
            "cash_balance": cash_balance,
        },
        "total_value": total_value,
        "cash_balance": cash_balance,
        "statement_period": statement_period,
        "quality_report_v2": quality_report_v2,
    }


def build_financial_analytics_v2(
    *,
    canonical_portfolio_v2: dict[str, Any],
    raw_extract_v2: dict[str, Any],
) -> dict[str, Any]:
    holdings = _as_list(canonical_portfolio_v2.get("holdings"))
    total_value = _to_num(canonical_portfolio_v2.get("total_value")) or 0.0
    allocation_mix = _allocation_mix_from_holdings(holdings, total_value)

    investable = [row for row in holdings if bool(row.get("is_investable"))]
    sector_counter: dict[str, float] = {}
    for row in investable:
        sector = _to_text(row.get("sector")) or "Unknown"
        sector_counter[sector] = sector_counter.get(sector, 0.0) + (
            _to_num(row.get("market_value")) or 0.0
        )
    sector_exposure = sorted(
        [
            {
                "sector": sector,
                "value": round(value, 2),
                "pct": round((value / total_value) * 100.0, 4) if total_value > 0 else 0.0,
            }
            for sector, value in sector_counter.items()
        ],
        key=lambda row: float(_to_num(row.get("value")) or 0.0),
        reverse=True,
    )

    ranked_positions = sorted(
        (
            {
                "symbol": _to_text(row.get("symbol")) or "UNKNOWN",
                "name": _to_text(row.get("name")) or "Unknown",
                "market_value": _to_num(row.get("market_value")) or 0.0,
            }
            for row in holdings
        ),
        key=lambda row: float(_to_num(row.get("market_value")) or 0.0),
        reverse=True,
    )
    concentration: list[dict[str, Any]] = []
    for row in ranked_positions[:10]:
        market_value = _to_num(row.get("market_value")) or 0.0
        if market_value <= 0:
            continue
        concentration.append(
            {
                **row,
                "market_value": market_value,
                "weight_pct": round((market_value / total_value) * 100.0, 4)
                if total_value > 0
                else 0.0,
            }
        )

    gain_loss_counter: Counter[str] = Counter({"gain": 0, "loss": 0, "flat": 0})
    losers_count = 0
    winners_count = 0
    loss_value = 0.0
    for row in investable:
        gain_loss = _to_num(row.get("unrealized_gain_loss"))
        if gain_loss is None:
            continue
        if gain_loss > 0:
            gain_loss_counter["gain"] += 1
            winners_count += 1
        elif gain_loss < 0:
            gain_loss_counter["loss"] += 1
            losers_count += 1
            loss_value += abs(gain_loss)
        else:
            gain_loss_counter["flat"] += 1

    income_breakdown = {
        "estimated_annual_income_total": round(
            sum((_to_num(row.get("estimated_annual_income")) or 0.0) for row in holdings),
            2,
        ),
        "estimated_yield_weighted_pct": round(
            (
                sum((_to_num(row.get("estimated_annual_income")) or 0.0) for row in holdings)
                / total_value
                * 100.0
            )
            if total_value > 0
            else 0.0,
            4,
        ),
        "income_summary": _as_dict(raw_extract_v2.get("income_summary")),
    }

    reconciliation_summary = _as_dict(raw_extract_v2.get("reconciliation_summary"))
    quality = _as_dict(canonical_portfolio_v2.get("quality_report_v2"))
    parser_score = _to_num(quality.get("parser_quality_score")) or 0.0

    return {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "allocation_mix": allocation_mix,
        "sector_exposure": sector_exposure,
        "concentration": concentration,
        "gain_loss_distribution": [
            {"band": "gain", "count": int(gain_loss_counter["gain"])},
            {"band": "loss", "count": int(gain_loss_counter["loss"])},
            {"band": "flat", "count": int(gain_loss_counter["flat"])},
        ],
        "income_breakdown": income_breakdown,
        "reconciliation_metrics": {
            "statement": reconciliation_summary,
            "portfolio_total_value": total_value,
            "cash_balance": canonical_portfolio_v2.get("cash_balance"),
        },
        "quality_metrics": {
            "parser_quality_score": round(parser_score, 4),
            "allocation_coverage_pct": _to_num(quality.get("allocation_coverage_pct")) or 0.0,
            "symbol_trust_coverage_pct": _to_num(quality.get("symbol_trust_coverage_pct")) or 0.0,
            "investable_positions_count": int(quality.get("investable_positions_count") or 0),
            "cash_positions_count": int(quality.get("cash_positions_count") or 0),
            "holdings_count": int(quality.get("holdings_count") or 0),
        },
        "debate_readiness": {
            "investable_symbols": [
                _to_text(row.get("symbol")) for row in investable if _to_text(row.get("symbol"))
            ],
            "eligible_count": len(investable),
            "excluded_cash_count": len(
                [row for row in holdings if bool(row.get("is_cash_equivalent"))]
            ),
            "quality_score": round(parser_score, 4),
        },
        "optimize_signals": {
            "losers_count": losers_count,
            "winners_count": winners_count,
            "loss_value": round(loss_value, 2),
            "investable_universe_count": len(investable),
        },
    }
