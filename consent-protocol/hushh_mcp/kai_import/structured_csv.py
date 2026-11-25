"""Read self-describing CSV holdings with complete accounting for source rows."""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from .holding_columns import (
    columns,
    currency_code,
    header_currency,
    label,
    matches,
    number,
    position,
    sum_field,
)

_MAX_ROWS = 1_050
_MAX_CELL = 1_024
_CASH = {"cash & cash investments", "cash and cash investments", "cash and sweep balance"}
_TOTAL = {"account total", "total account value", "portfolio total", "total portfolio value"}
_PREAMBLE = re.compile(
    r"Positions for account (?P<kind>[^.]{1,45}) \.\.\.(?P<account>\d{1,8}) "
    r"as of \d{1,2}:\d{2} (?:AM|PM) ET, (?P<date>\d{1,2}/\d{1,2}/\d{4})"
)
_SCHWAB_COLUMNS = {
    "symbol",
    "name",
    "quantity",
    "price",
    "_daily_pct",
    "market_value",
    "cost_basis",
    "unrealized_gain_loss_pct",
    "unrealized_gain_loss",
    "_weight",
    "asset_type",
}
_METADATA = {
    "_statement_date": "statement_period_end",
    "_account_number": "account_number",
    "_institution": "institution_name",
    "currency": "currency",
}
_CAPTIONS = {"holdings", "portfolio holdings", "positions", "open positions"}
_AS_OF = re.compile(r"(?:portfolio holdings|holdings|positions) as of (\d{4}-\d{2}-\d{2})", re.I)
_META_LABELS = {
    "statement date": "statement_period_end",
    "as of date": "statement_period_end",
    "account number": "account_number",
    "brokerage": "institution_name",
    "institution": "institution_name",
    "account type": "account_type",
    "account holder": "account_name",
    "currency": "currency",
}


def _set_detail(details: dict[str, str], key: str, value: str) -> None:
    value = value.strip()
    if not value:
        return
    if key == "statement_period_end":
        value = date.fromisoformat(value).isoformat()
    if key == "currency":
        value = currency_code(value)
    if key in details and details[key] != value:
        raise ValueError("structured_multiple_accounts")
    details[key] = value


def _details(records: list[tuple[str, ...]], mapping: tuple[str, ...]) -> dict[str, str]:
    details: dict[str, str] = {}
    for row in records:
        if len(row) == 2 and (key := _META_LABELS.get(label(row[0]))):
            _set_detail(details, key, row[1])
            continue
        if len(row) == 1 and label(row[0]) in _CAPTIONS:
            continue
        if len(row) == 1 and (as_of := _AS_OF.fullmatch(row[0].strip())):
            _set_detail(details, "statement_period_end", as_of[1])
            continue
        match = _PREAMBLE.fullmatch(row[0]) if len(row) == 1 else None
        if match and set(mapping) == _SCHWAB_COLUMNS and len(records) == 1:
            return {
                "currency": "USD",
                "statement_period_end": datetime.strptime(match["date"], "%m/%d/%Y")
                .date()
                .isoformat(),
                "account_number": "..." + match["account"],
                "account_type": match["kind"].strip(),
            }
        raise ValueError("structured_unknown_csv_preamble")
    return details


def _control(cells: dict[str, str], currency: str, *, cash: bool) -> dict[str, float]:
    allowed = {"symbol", "_weight", "currency"} | (
        {"market_value", "name", "asset_type"}
        if cash
        else {"market_value", "cost_basis", "unrealized_gain_loss", "unrealized_gain_loss_pct"}
    )
    populated = {key for key, value in cells.items() if value and value not in {"--", "—"}}
    if populated - allowed:
        raise ValueError("structured_unknown_control_field")
    for key in ("_weight", "unrealized_gain_loss_pct"):
        number(cells.get(key, ""), percent=True)
    result: dict[str, float] = {}
    for key in ("market_value", "cost_basis", "unrealized_gain_loss"):
        value = number(cells.get(key, ""), currency=currency)
        if value is not None:
            result[key] = value
    if "market_value" not in result:
        raise ValueError("structured_control_missing_market_value")
    return result


def _decode(
    indexed: list[tuple[int, tuple[str, ...]]], at: int, mapping: tuple[str, ...]
) -> dict[str, Any]:
    details = _details([row for _, row in indexed[:at]], mapping)
    if header_code := header_currency(indexed[at][1]):
        _set_detail(details, "currency", header_code)
    body = indexed[at + 1 :]
    records = [(line, dict(zip(mapping, row, strict=True))) for line, row in body]
    for _, record in records:
        for field, key in _METADATA.items():
            _set_detail(details, key, record.get(field, ""))
    currency = details.get("currency", "")
    rows: list[dict[str, Any]] = []
    cash: dict[str, float] | None = None
    total: dict[str, float] | None = None
    for line, record in records:
        if total is not None:
            raise ValueError("structured_rows_after_account_total")
        identifier = label(record["symbol"])
        if identifier in _TOTAL:
            total = _control(record, currency, cash=False)
        elif identifier in _CASH and cash is None:
            cash = _control(record, currency, cash=True)
        elif cash is None:
            rows.append(position(record, currency, {"kind": "csv", "row": line}))
        else:
            raise ValueError("structured_rows_after_cash")
    if not rows or len({row["symbol"] for row in rows}) != len(rows):
        raise ValueError("structured_csv_positions_unconfirmed")
    if cash is not None and (
        total is None or any(row["symbol"] in {"CASH", "MMF", "SWEEP"} for row in rows)
    ):
        raise ValueError("structured_cash_without_account_total")
    cash_value = cash["market_value"] if cash is not None else None
    account_value = total["market_value"] if total is not None else None
    if total is not None:
        securities = sum_field(rows, "market_value")
        if not matches(securities + Decimal(str(cash_value or 0)), total["market_value"]):
            raise ValueError("structured_account_total_mismatch")
        for key in ("cost_basis", "unrealized_gain_loss"):
            if key in total and (
                not all(key in row for row in rows) or not matches(sum_field(rows, key), total[key])
            ):
                raise ValueError("structured_account_total_mismatch")
    return {
        "statement_details": details,
        "portfolio_summary": {"ending_value": account_value} if total is not None else {},
        "detailed_holdings": rows,
        "cash_balance": cash_value,
        "total_value": account_value,
    }


def structured_csv(records: tuple[tuple[str, ...], ...]) -> dict[str, Any] | None:
    """Accept one strict holding table with recognized optional statement controls."""
    if not 2 <= len(records) <= _MAX_ROWS:
        return None
    indexed = [(i, row) for i, row in enumerate(records, 1) if any(cell.strip() for cell in row)]
    candidates = [
        (i, mapping) for i, (_, row) in enumerate(indexed[:12]) if (mapping := columns(row))
    ]
    if len(candidates) != 1:
        return None
    index, mapping = candidates[0]
    if any(len(cell) > _MAX_CELL for _, row in indexed for cell in row):
        return None
    try:
        return _decode(indexed, index, mapping)
    except (KeyError, ValueError):
        return None
