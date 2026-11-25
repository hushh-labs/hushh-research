"""Literal column contracts used by bounded portfolio table extraction."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from .csv_layout import parse_csv_number

_ALIASES = {
    "symbol": "symbol|ticker|ticker symbol|security symbol",
    "name": "name|security name|description|security description|security / fund|security / asset|investment|company|security",
    "quantity": "quantity|qty|shares|units|position quantity",
    "price": "price|share price|price per share|unit price|current price|last price|usd price|closing price|market price|last traded price",
    "market_value": "market value|current value|position value|market value usd|market value (usd)|value (usd)|total market value|current market value",
    "cost_basis": "cost basis|book cost|total cost|total cost basis|adjusted cost basis|book value|cost basis (usd)",
    "unrealized_gain_loss": "gain/loss|gain loss|gain / loss|gain / (loss)|gain/loss $|gain/loss (usd)|unrealized gain/loss|unrealized gain / loss|unrealized p&l|u/r p&l|unrealized gain/loss ($)|total gain/loss",
    "unrealized_gain_loss_pct": "gain/loss %|gain / loss %|unrealized gain/loss %|p&l %|total gain/loss %",
    "asset_type": "asset type|asset class|security type|instrument type",
    "sector": "sector",
    "industry": "industry",
    "currency": "currency|currency code",
    "symbol_cusip": "cusip|security cusip",
    "security_id": "isin|security identifier|isin / synthetic identifier",
    "est_annual_income": "estimated annual income|est. annual income|annual income",
    "est_yield": "estimated yield|est. yield|yield",
    "acquisition_date": "acquisition date|date acquired|purchase date",
    "account_id": "holding account id",
    "_avg_cost": "avg cost|average cost|average price|average cost per share",
    "_weight": "% of account|weight|weight %|portfolio weight",
    "_daily_pct": "price change %|day %|day change %|daily return %",
    "_exchange": "exchange",
    "_custody": "custody",
    "_statement_date": "statement date|statement period end|as of date",
    "_account_number": "account number",
    "_institution": "brokerage|institution|institution name",
    "_notice": "fixture notice",
}
_COLUMNS = {label: key for key, aliases in _ALIASES.items() for label in aliases.split("|")}
_REQUIRED = {"symbol", "quantity", "price", "market_value"}
_TEXT_FIELDS = {
    "symbol",
    "name",
    "asset_type",
    "sector",
    "industry",
    "currency",
    "symbol_cusip",
    "security_id",
    "acquisition_date",
    "account_id",
}
_PERCENT_FIELDS = {"unrealized_gain_loss_pct", "est_yield", "_daily_pct", "_weight"}
_OPTIONAL_BLANK = {"", "--", "—", "n/a", "na"}
_MONEY_SIGNS = {
    "$": {"USD", "CAD", "AUD", "HKD", "SGD", "NZD"},
    "€": {"EUR"},
    "£": {"GBP"},
    "₹": {"INR"},
    "¥": {"JPY", "CNY"},
}
_CURRENCIES = {"USD", "CAD", "AUD", "HKD", "SGD", "NZD", "EUR", "GBP", "INR", "JPY", "CNY", "CHF"}
_MONEY_FIELDS = {
    "price",
    "market_value",
    "cost_basis",
    "unrealized_gain_loss",
    "est_annual_income",
    "_avg_cost",
}
_MONEY_HEADER = re.compile(r"^(.+?)\s+(?:\(([a-z]{3})\)|([a-z]{3}))$")
_SYMBOL = re.compile(r"(?:[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*|[0-9]+)")
_PLACEHOLDERS = {"NULL", "NA", "NAN", "NONE", "UNKNOWN", "UNAVAILABLE"}
_AMOUNT = re.compile(
    r"(?P<sign>[+-]?)(?P<currency>[$€£₹¥]?)(?P<value>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?P<percent>%?)"
)
CENT = Decimal("0.01")


def label(text: str) -> str:
    return " ".join(text.strip().casefold().split())


def _column(cell: str) -> tuple[str, str]:
    normalized = label(cell)
    if match := _MONEY_HEADER.fullmatch(normalized):
        code = (match[2] or match[3]).upper()
        if code in _CURRENCIES and (key := _COLUMNS.get(match[1])) in _MONEY_FIELDS:
            return key, code
    return _COLUMNS.get(normalized, ""), ""


def header_currency(cells: tuple[str, ...]) -> str:
    codes = {code for _, code in map(_column, cells) if code}
    if len(codes) > 1:
        raise ValueError("structured_header_currency_conflict")
    return next(iter(codes), "")


def columns(cells: tuple[str, ...], *, required: set[str] | None = None) -> tuple[str, ...] | None:
    mapped = tuple(key for key, _ in map(_column, cells))
    if "" in mapped or len(mapped) != len(set(mapped)):
        return None
    return mapped if (required if required is not None else _REQUIRED) <= set(mapped) else None


def number(
    value: str, *, currency: str = "", percent: bool = False, units: bool = False
) -> float | None:
    text = value.strip().replace("−", "-")
    if label(text) in _OPTIONAL_BLANK:
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1].strip()
    match = _AMOUNT.fullmatch(text)
    if match is None or (negative and match["sign"]):
        raise ValueError("structured_number_invalid")
    sign = match["currency"]
    if sign and (units or percent or currency not in _MONEY_SIGNS[sign]):
        raise ValueError("structured_currency_ambiguous")
    if "," in match["value"] and "." not in match["value"] and currency != "USD":
        raise ValueError("structured_number_locale_undetermined")
    if match["percent"] and not percent:
        raise ValueError("structured_percent_invalid")
    result = parse_csv_number(
        ("-" if negative else match["sign"]) + match["value"], decimal=".", grouping=","
    )
    if result is None or abs(result) > 1e12:
        raise ValueError("structured_amount_out_of_range")
    return result


def currency_code(value: str) -> str:
    code = value.strip().upper()
    if code not in _CURRENCIES:
        raise ValueError("structured_currency_unknown")
    return code


def matches(left: float | Decimal, right: float | Decimal) -> bool:
    return abs(Decimal(str(left)) - Decimal(str(right))) <= CENT


def sum_field(rows: list[dict[str, Any]], key: str) -> Decimal:
    return sum((Decimal(str(row[key])) for row in rows), Decimal(0))


def position(cells: dict[str, str], currency: str, source: dict[str, Any]) -> dict[str, Any]:
    symbol = cells["symbol"].strip().upper()
    if (
        len(symbol) > 10
        or symbol.replace(".", "").replace("-", "") in _PLACEHOLDERS
        or not _SYMBOL.fullmatch(symbol)
    ):
        raise ValueError("structured_symbol_invalid")
    if declared_currency := cells.get("currency", "").strip():
        row_currency = currency_code(declared_currency)
        if currency and currency != row_currency:
            raise ValueError("structured_currency_conflict")
        currency = row_currency
    result: dict[str, Any] = {"symbol": symbol, "_import_source": source}
    for key, value in cells.items():
        if key == "symbol" or key == "currency" or label(value) in _OPTIONAL_BLANK:
            continue
        if key in _TEXT_FIELDS:
            result[key] = value.strip()
        elif key in _PERCENT_FIELDS:
            parsed = number(value, percent=True)
            if not key.startswith("_"):
                result[key] = parsed
        elif not key.startswith("_"):
            parsed = number(value, currency=currency, units=key == "quantity")
            result[key] = parsed
    if currency:
        result["currency"] = currency
    if not {"quantity", "price", "market_value"} <= result.keys():
        raise ValueError("structured_position_incomplete")
    quantity, price, value = (result[key] for key in ("quantity", "price", "market_value"))
    if quantity < 0 or price < 0 or value < 0:
        raise ValueError("structured_position_unsupported")
    if not matches(Decimal(str(quantity)) * Decimal(str(price)), value):
        raise ValueError("structured_market_value_mismatch")
    cost, gain = result.get("cost_basis"), result.get("unrealized_gain_loss")
    if cost is not None and (
        cost < 0
        or (gain is not None and not matches(Decimal(str(value)) - Decimal(str(cost)), gain))
    ):
        raise ValueError("structured_gain_mismatch")
    average_cost = number(cells.get("_avg_cost", ""), currency=currency)
    if average_cost is not None and (
        cost is None or not matches(Decimal(str(quantity)) * Decimal(str(average_cost)), cost)
    ):
        raise ValueError("structured_average_cost_mismatch")
    return result
