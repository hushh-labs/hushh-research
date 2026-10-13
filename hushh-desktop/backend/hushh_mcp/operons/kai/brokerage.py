"""Pure Kai brokerage operons.

These functions work on normalized brokerage payloads and stay free of database
or Plaid transport concerns. They are the first agent-facing boundary on top of
the read-only brokerage service slice.
"""

from __future__ import annotations

from collections import Counter
from typing import Any


def _to_float(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.replace(",", "").replace("$", "").strip())
        except Exception:
            return 0.0
    return 0.0


def _to_int(value: Any) -> int:
    try:
        return int(_to_float(value))
    except Exception:
        return 0


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


def build_brokerage_holdings_context(
    portfolio_data: dict[str, Any] | None,
    *,
    source: str | None = None,
) -> dict[str, Any]:
    portfolio = portfolio_data if isinstance(portfolio_data, dict) else {}
    holdings = portfolio.get("holdings") if isinstance(portfolio.get("holdings"), list) else []
    normalized_holdings: list[dict[str, Any]] = []
    total_value = 0.0
    for row in holdings:
        if not isinstance(row, dict):
            continue
        market_value = _to_float(row.get("market_value"))
        total_value += market_value
        normalized_holdings.append(
            {
                "symbol": _clean_text(row.get("symbol"), default="UNKNOWN").upper(),
                "name": _clean_text(row.get("name"), default="Unknown"),
                "quantity": _to_float(row.get("quantity")),
                "market_value": market_value,
                "weight": _to_float(row.get("weight")),
                "instrument_type": _clean_text(row.get("instrument_type") or row.get("asset_type"))
                or None,
            }
        )

    normalized_holdings.sort(key=lambda row: row["market_value"], reverse=True)
    top_positions = normalized_holdings[:10]
    concentration_top3 = round(sum(row["market_value"] for row in top_positions[:3]), 2)
    concentration_top10 = round(sum(row["market_value"] for row in top_positions), 2)

    return {
        "source": source or _clean_text(portfolio.get("source"), default="brokerage"),
        "total_value": round(total_value, 2),
        "holdings_count": len(normalized_holdings),
        "top_positions": top_positions,
        "top3_concentration_value": concentration_top3,
        "top10_concentration_value": concentration_top10,
    }


def summarize_brokerage_activity(
    transactions: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    rows = transactions if isinstance(transactions, list) else []
    counts: Counter[str] = Counter()
    dividend_total = 0.0
    fee_total = 0.0
    net_cash_flow = 0.0
    realized_gain_loss = 0.0

    for row in rows:
        if not isinstance(row, dict):
            continue
        tx_type = _clean_text(row.get("type"), default="UNKNOWN").upper()
        counts[tx_type] += 1

        amount = _to_float(row.get("amount") or row.get("net_amount"))
        fees = _to_float(row.get("fees"))
        gain_loss = _to_float(row.get("realized_gain_loss") or row.get("realized_gain_loss_amount"))
        net_cash_flow += amount
        fee_total += fees
        realized_gain_loss += gain_loss

        if "DIVIDEND" in tx_type:
            dividend_total += amount

    return {
        "transaction_count": sum(counts.values()),
        "counts_by_type": dict(counts),
        "dividend_total": round(dividend_total, 2),
        "fee_total": round(fee_total, 2),
        "net_cash_flow": round(net_cash_flow, 2),
        "realized_gain_loss": round(realized_gain_loss, 2),
    }


def build_brokerage_freshness_context(
    source_metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    metadata = source_metadata if isinstance(source_metadata, dict) else {}
    return {
        "source_type": _clean_text(metadata.get("source_type"), default="brokerage"),
        "sync_status": _clean_text(metadata.get("sync_status"), default="idle"),
        "last_synced_at": _clean_text(metadata.get("last_synced_at")) or None,
        "institution_names": [
            _clean_text(name)
            for name in (metadata.get("institution_names") or [])
            if _clean_text(name)
        ],
        "item_count": _to_int(metadata.get("item_count")),
        "account_count": _to_int(metadata.get("account_count")),
        "is_editable": bool(metadata.get("is_editable", False)),
    }


def prepare_order_intent(
    *,
    user_id: str,
    symbol: str,
    side: str,
    reason: str,
    source: str,
    quantity: float | None = None,
    notional: float | None = None,
) -> dict[str, Any]:
    return {
        "status": "draft",
        "user_id": user_id,
        "symbol": _clean_text(symbol).upper(),
        "side": _clean_text(side).lower(),
        "reason": _clean_text(reason),
        "portfolio_source": _clean_text(source, default="statement"),
        "quantity": quantity,
        "notional": notional,
        "approval_required": True,
    }
