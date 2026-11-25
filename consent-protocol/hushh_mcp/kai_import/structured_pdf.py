"""Bounded extraction of searchable statement tables and printed controls."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
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

MAX_STRUCTURED_PDF_PAGES = 24
MAX_STRUCTURED_PDF_SECONDS = 3

_REFERENCE = {"symbol", "security_id", "quantity", "market_value"}
_ACCOUNT_FIELDS = {
    "account number": "account_number",
    "account holder": "account_name",
    "account type": "account_type",
    "base currency": "currency",
    "depository / clearing": None,
}
_CONTROLS = {
    "total positions": "declared_security_count",
    "number of holdings": "declared_security_count",
    "holdings count": "declared_security_count",
    "securities market value": "securities_market_value",
    "equity / etf market value": "securities_market_value",
    "aggregate cost basis": "cost_basis",
    "total cost basis": "cost_basis",
    "unrealized gain / (loss)": "gain",
    "cash balance": "cash_balance",
    "cash and sweep balance": "cash_balance",
    "pending receivables": "pending_receivables",
    "margin debit / hold": "margin_debit",
    "total net liquidation value": "ending_value",
    "total account value": "ending_value",
    "ending value": "ending_value",
    "beginning value": "beginning_value",
    "net deposits and withdrawals": "net_deposits_withdrawals",
    "change in value": "change_in_value",
    "total income": "income",
    "total fees": "fees",
    "transactions in period": "transaction_count",
    "dividend entries": "dividend_count",
}
_CONTEXT_LABELS = {"unrealized return", "market valuation method"}
_AUX_TABLES = {
    ("sector", "market value", "portfolio weight", "holdings"): "allocation",
    (
        "trade date",
        "settle date",
        "reference id",
        "ticker",
        "type",
        "qty",
        "price",
        "gross",
        "fees",
        "tax",
        "net cash flow",
    ): "transactions",
    (
        "pay date",
        "ticker",
        "gross distribution",
        "withholding / tds",
        "net distribution",
        "currency",
    ): "dividends",
    ("activity", "record count", "total fees", "net cash effect"): "activity",
    ("rank", "ticker", "name", "weight", "market value", "unrealized p&l"): "concentration",
}
_MONEY = re.compile(r"(?:(?P<code>[A-Z]{3})\s+)?(?P<amount>.+)")
_PERIOD = re.compile(
    r"^Reporting period:\s*(\d\d? [A-Z][a-z]{2} \d{4})\s*[-–]\s*(\d\d? [A-Z][a-z]{2} \d{4})(?:\s*\||$)"
)
_SIMPLE_DETAIL = re.compile(r"^(?:Statement date|As of date):\s*(\d{4}-\d{2}-\d{2})$", re.I)
_FOOTER = {"total", "securities total", "holdings total", "total securities"}
_COUNT_FIELDS = {"declared_security_count", "transaction_count", "dividend_count"}
_EXPLICIT_SECTIONS = {"positions", "holdings", "portfolio holdings", "holdings summary"}
_UNPARSED_FACT = re.compile(
    r"^(?:account (?:number|holder|type|value|balance)|(?:net )?liquidation value|cash balance|"
    r"opening balance|closing balance|historical values?|(?:balance|valuation) history|"
    r"(?:net )?(?:deposits|withdrawals)|statement period|currency|book cost)\b",
    re.I,
)
_REPORT_HEADING = re.compile(
    r"^(.{1,80}?)\s*\|\s*(?:synthetic brokerage test data|(?:brokerage |account )?statement)$", re.I
)


@dataclass
class _Statement:
    details: dict[str, str] = field(default_factory=dict)
    controls: dict[str, float] = field(default_factory=dict)
    rows: list[dict[str, Any]] = field(default_factory=list)
    references: dict[str, tuple[float, float, str, str]] = field(default_factory=dict)
    subtotals: list[dict[str, float]] = field(default_factory=list)
    allocations: list[float] = field(default_factory=list)
    transactions: set[str] = field(default_factory=set)
    dividends: list[float] = field(default_factory=list)
    activity: dict[str, tuple[float, float]] = field(default_factory=dict)
    concentration: list[tuple[str, float]] = field(default_factory=list)
    opaque_section: bool = False

    @property
    def currency(self) -> str:
        return self.details.get("currency", "")

    def detail(self, key: str, value: str) -> None:
        value = currency_code(value) if key == "currency" else value.strip()
        if key in self.details and self.details[key] != value:
            raise ValueError("structured_pdf_conflicting_statement_details")
        if value:
            self.details[key] = value

    def amount(self, value: str) -> float:
        if not (parts := _MONEY.fullmatch(value.strip())):
            raise ValueError("structured_pdf_amount_missing")
        if code := parts["code"]:
            self.detail("currency", code)
        amount = number(parts["amount"], currency=self.currency)
        if amount is None:
            raise ValueError("structured_pdf_amount_missing")
        return amount

    def printed(self, key: str, text: str) -> None:
        value = self.amount(text)
        if key in _COUNT_FIELDS and (value < 0 or not value.is_integer()):
            raise ValueError("structured_pdf_count_invalid")
        if key in self.controls and value != self.controls[key]:
            raise ValueError("structured_pdf_conflicting_total")
        self.controls[key] = value

    def supplemental(self, kind: str, row: tuple[str, ...]) -> None:
        if kind == "allocation" and len(row) == 4:
            self.allocations.append(self.amount(row[1]))
        elif kind == "transactions" and len(row) == 11:
            date.fromisoformat(row[0])
            if not row[2] or row[2] in self.transactions:
                raise ValueError("structured_pdf_repeated_transaction")
            self.transactions.add(row[2])
        elif kind == "dividends" and len(row) == 6:
            date.fromisoformat(row[0])
            self.detail("currency", row[5])
            gross, tax, net = map(self.amount, row[2:5])
            if not matches(Decimal(str(gross)) - Decimal(str(tax)), net):
                raise ValueError("structured_pdf_dividend_mismatch")
            self.dividends.append(gross)
        elif kind == "activity" and len(row) == 4:
            count, fees = self.amount(row[1]), self.amount(row[2])
            if row[0] in self.activity or count < 0 or not count.is_integer() or fees < 0:
                raise ValueError("structured_pdf_activity_mismatch")
            self.activity[row[0]] = (count, fees)
        elif kind == "concentration" and len(row) == 6:
            self.concentration.append((row[1].upper(), self.amount(row[4])))
        else:
            self.opaque_section = True

    def add_reference(self, mapped: dict[str, str]) -> None:
        symbol = mapped["symbol"].strip().upper()
        if symbol in self.references:
            raise ValueError("structured_pdf_duplicate_reference")
        self.references[symbol] = (
            self.amount(mapped["quantity"]),
            self.amount(mapped["market_value"]),
            mapped["security_id"],
            mapped.get("asset_type", ""),
        )


def _footer(row: tuple[str, ...], fields: tuple[str, ...], statement: _Statement) -> None:
    amounts = {
        "quantity",
        "cost_basis",
        "market_value",
        "unrealized_gain_loss",
        "unrealized_gain_loss_pct",
    }
    if len(row) == len(fields):
        mapped = {
            key: cell
            for key, cell in zip(fields[1:], row[1:], strict=True)
            if key in amounts and cell.strip()
        }
    else:
        reduced = [key for key in fields if key in amounts]
        mapped = dict(zip(reduced, row[1:], strict=True))
    if "market_value" not in mapped:
        raise ValueError("structured_pdf_total_missing")
    statement.subtotals.append(
        {
            key: statement.amount(text)
            for key, text in mapped.items()
            if key != "unrealized_gain_loss_pct"
        }
    )


def _reading_context(statement: _Statement, line: str, row: tuple[str, ...]) -> bool:
    if period := _PERIOD.match(line):
        statement.detail(
            "statement_period_start", datetime.strptime(period[1], "%d %b %Y").date().isoformat()
        )
        statement.detail(
            "statement_period_end", datetime.strptime(period[2], "%d %b %Y").date().isoformat()
        )
        return True
    if statement_date := _SIMPLE_DETAIL.fullmatch(line):
        statement.detail("statement_period_end", date.fromisoformat(statement_date[1]).isoformat())
        return True
    if len(row) == 1:
        key, sep, value = line.partition(":")
        if sep and label(key) in {
            "brokerage",
            "institution",
            "institution name",
            "currency",
            "base currency",
            "account number",
            "account holder",
            "account type",
        }:
            target = _ACCOUNT_FIELDS.get(label(key)) or (
                "currency" if label(key) == "currency" else "institution_name"
            )
            statement.detail(target, value)
            return True
        if sep and (control := _CONTROLS.get(label(key))):
            statement.printed(control, value)
            return True
    if len(row) % 2:
        return False
    if label(row[0]) in {"currency", "base currency"} and len(row) == 2:
        statement.detail("currency", row[1])
        return True
    if label(row[0]) not in _CONTROLS:
        return False
    for key, value in zip(row[::2], row[1::2], strict=True):
        if field_name := _CONTROLS.get(label(key)):
            statement.printed(field_name, value)
        elif label(key) not in _CONTEXT_LABELS:
            statement.opaque_section = True
    return True


def _read_page(statement: _Statement, text: str, page: int) -> None:
    fields: tuple[str, ...] | None = None
    section = ""
    for line_number, line in enumerate(text.splitlines(), 1):
        row = tuple(cell.strip() for cell in line.split("\t"))
        keys = tuple(label(cell) for cell in row)
        if keys[0] == "":
            continue
        if (
            page == 1
            and line_number == 1
            and (heading := _REPORT_HEADING.fullmatch(line.replace("\t", " ")))
        ):
            statement.detail("institution_name", heading[1])
        if fields is not None and section == "holdings" and keys[0] in _FOOTER:
            _footer(row, fields, statement)
            fields, section = None, ""
            continue
        if candidate := columns(row):
            fields, section = candidate, "holdings"
            if header_code := header_currency(row):
                statement.detail("currency", header_code)
        elif (candidate := columns(row, required=_REFERENCE)) and "price" not in candidate:
            fields, section = candidate, "reference"
        elif len(keys) > 1 and set(keys) <= _ACCOUNT_FIELDS.keys() and "account number" in keys:
            fields, section = keys, "account"
        elif section_name := _AUX_TABLES.get(keys):
            fields, section = keys, section_name
        elif _reading_context(statement, line.replace("\t", " "), row):
            fields, section = None, ""
        elif fields is not None and section in {"holdings", "reference", "account"}:
            cells = dict(zip(fields, row, strict=True))
            if row_currency := cells.get("currency"):
                statement.detail("currency", row_currency)
            if section == "holdings":
                statement.rows.append(
                    position(
                        cells, statement.currency, {"kind": "pdf", "page": page, "row": line_number}
                    )
                )
            elif section == "reference":
                statement.add_reference(cells)
            else:
                for key, cell in cells.items():
                    if target := _ACCOUNT_FIELDS[key]:
                        statement.detail(target, cell)
                fields, section = None, ""
        elif section and len(row) > 1:
            statement.supplemental(section, row)
        elif len(row) == 1:
            if _UNPARSED_FACT.match(line) and (":" in line or any(c.isdigit() for c in line)):
                statement.opaque_section = True
            fields, section = None, ""
        elif not (keys[-1].startswith("page ") or keys[0] in {"metric", *_EXPLICIT_SECTIONS}):
            statement.opaque_section = True


def _reconciled(statement: _Statement) -> dict[str, Any] | None:
    rows = statement.rows
    controls = statement.controls
    by_symbol = {row["symbol"]: row for row in rows}
    if not rows or len(rows) != len(by_symbol):
        return None
    market = sum_field(rows, "market_value")
    if "declared_security_count" in controls and controls["declared_security_count"] != len(rows):
        return None
    if "securities_market_value" in controls and not matches(
        market, controls["securities_market_value"]
    ):
        return None
    if (
        not statement.subtotals
        and not {"declared_security_count", "securities_market_value"} <= controls.keys()
    ):
        return None
    for key, control in (("cost_basis", "cost_basis"), ("unrealized_gain_loss", "gain")):
        if control in controls and (
            not all(key in row for row in rows)
            or not matches(sum_field(rows, key), controls[control])
        ):
            return None
    for key in {key for total in statement.subtotals for key in total}:
        if not all(key in row for row in rows) or not matches(
            sum_field(rows, key),
            sum(
                (Decimal(str(total[key])) for total in statement.subtotals if key in total),
                Decimal(0),
            ),
        ):
            return None
    if statement.currency:
        for row in rows:
            row.setdefault("currency", statement.currency)
    if statement.references:
        if statement.references.keys() != by_symbol.keys():
            return None
        for symbol, (quantity, value, identifier, asset_type) in statement.references.items():
            row = by_symbol[symbol]
            if not matches(row["quantity"], quantity) or not matches(row["market_value"], value):
                return None
            row["security_id"] = identifier
            if asset_type and not row.get("asset_type"):
                row["asset_type"] = asset_type
    if statement.allocations and not matches(
        sum(map(lambda v: Decimal(str(v)), statement.allocations)), market
    ):
        return None
    if any(
        symbol not in by_symbol or not matches(by_symbol[symbol]["market_value"], value)
        for symbol, value in statement.concentration
    ):
        return None
    cash = controls.get("cash_balance")
    total = controls.get("ending_value")
    if cash is not None and total is not None:
        reconciled = (
            market
            + Decimal(str(cash))
            + Decimal(str(controls.get("pending_receivables", 0)))
            - Decimal(str(controls.get("margin_debit", 0)))
        )
        if not matches(reconciled, total):
            return None
    summary = {
        k: controls[k]
        for k in (
            "declared_security_count",
            "securities_market_value",
            "pending_receivables",
            "ending_value",
            "beginning_value",
            "net_deposits_withdrawals",
            "change_in_value",
            "income",
            "fees",
        )
        if k in controls
    }
    if statement.dividends:
        if controls.get("dividend_count") != len(statement.dividends):
            statement.opaque_section = True
        else:
            summary.setdefault(
                "income", float(sum((Decimal(str(v)) for v in statement.dividends), Decimal(0)))
            )
    if statement.activity:
        counts = sum(count for count, _ in statement.activity.values())
        if counts != controls.get("transaction_count") or counts != len(statement.transactions):
            statement.opaque_section = True
        else:
            summary.setdefault(
                "fees",
                float(
                    sum((Decimal(str(fees)) for _, fees in statement.activity.values()), Decimal(0))
                ),
            )
    return {
        "statement_details": statement.details,
        "portfolio_summary": summary,
        "detailed_holdings": rows,
        "cash_balance": cash,
        "total_value": total,
    }


def structured_pdf(pages: list[str]) -> tuple[dict[str, Any], bool] | None:
    """Return independently reconciled holdings, and whether model completion is still needed."""
    statement = _Statement()
    try:
        for page, text in enumerate(pages, 1):
            if not text.strip():
                return None
            _read_page(statement, text, page)
        parsed = _reconciled(statement)
        return (parsed, statement.opaque_section) if parsed is not None else None
    except (KeyError, ValueError, ArithmeticError):
        return None
