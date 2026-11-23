"""Decode literal cells of recognized, self-describing statement layouts."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from .csv_layout import CsvLayoutUnsupported, parse_csv_number

_PDF_LAYOUTS = {
    "Symbol Security description Quantity Price Market value Cost basis Gain / (loss)": (
        "quantity",
        "price",
        "market_value",
        "cost_basis",
        "unrealized_gain_loss",
    ),
    "Symbol Security description Quantity Price Cost basis Market value Gain / (loss)": (
        "quantity",
        "price",
        "cost_basis",
        "market_value",
        "unrealized_gain_loss",
    ),
    "Symbol Security / country Shares USD price Market value Cost basis": (
        "quantity",
        "price",
        "market_value",
        "cost_basis",
    ),
}
_PDF_MARKER = "SYNTHETIC TEST STATEMENT - NOT AN OFFICIAL RECORD"
_RANGE = re.compile(r"Holdings (\d+)-(\d+) of (\d+)")
_AMOUNT = r"(?:\(\$?\d[\d,]*\.\d+\)|[+-]?\$?\d[\d,]*(?:\.\d+)?)"
_CONTROL = re.compile(
    rf"CONTROL TOTAL - (\d+) securities \| Market value ({_AMOUNT}) "
    rf"\| Cost basis ({_AMOUNT}) \| Cash ({_AMOUNT}) \| Account value ({_AMOUNT})"
)
_ALIASES = {
    "symbol": ("Symbol", "Ticker"),
    "name": ("Name", "Security Name", "Description"),
    "quantity": ("Quantity", "Shares", "Qty"),
    "price": ("Price", "Current Price", "Last Price"),
    "market_value": ("Market Value", "Current Value"),
    "cost_basis": ("Cost Basis", "Total Cost"),
    "unrealized_gain_loss": ("Gain/Loss", "Gain Loss"),
}
_CSV_OTHER = {
    "Asset Type",
    "Sector",
    "Currency",
    "Statement Date",
    "Account Number",
    "Brokerage",
    "Fixture Notice",
}
_IDENTIFIER = re.compile(r"[A-Z][A-Z0-9.-]{0,14}")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_CENT = Decimal("0.01")
_MAX_ROWS = 150


def _amount(cell: str) -> float:
    value = parse_csv_number(cell, decimal=".", grouping=",")
    if value is None or abs(value) > 1e15:
        raise CsvLayoutUnsupported("declared_layout_number")
    return value


def _sum(rows: list[dict[str, Any]], field: str) -> Decimal:
    return sum((Decimal(str(row[field])) for row in rows), Decimal(0))


def _rows_match(rows: list[dict[str, Any]]) -> bool:
    symbols = {row["symbol"] for row in rows}
    if not rows or len(symbols) != len(rows):
        return False
    for row in rows:
        if not _IDENTIFIER.fullmatch(row["symbol"]) or not row["name"]:
            return False
        quantity, price, market, cost = (
            Decimal(str(row[key])) for key in ("quantity", "price", "market_value", "cost_basis")
        )
        if quantity < 0 or price < 0 or cost < 0 or abs(quantity * price - market) > _CENT:
            return False
        gain = row.get("unrealized_gain_loss")
        if gain is not None and abs(market - cost - Decimal(str(gain))) > _CENT:
            return False
    return True


def declared_csv(records: tuple[tuple[str, ...], ...]) -> dict[str, Any] | None:
    """Only exact holdings-only CSV contracts with explicit USD and typed rows."""
    if not 2 <= len(records) <= _MAX_ROWS + 1:
        return None
    header, *body = records
    if len(set(header)) != len(header):
        return None
    mapping: dict[str, str] = {}
    for name, aliases in _ALIASES.items():
        matches = set(aliases).intersection(header)
        if len(matches) != 1:
            return None
        mapping[name] = matches.pop()
    if set(header) - {"Fixture Notice"} != set(mapping.values()) | (
        _CSV_OTHER - {"Fixture Notice"}
    ):
        return None
    positions: list[dict[str, Any]] = []
    identity: tuple[str, str, str, str] | None = None
    try:
        for index, record in enumerate(body, 2):
            if sum(map(len, record)) > 2048:
                return None
            source = dict(zip(header, record, strict=True))
            keys = (
                source["Currency"],
                source["Statement Date"],
                source["Account Number"],
                source["Brokerage"],
            )
            currency, date, account, brokerage = keys
            if (
                currency != "USD"
                or not _DATE.fullmatch(date)
                or not account
                or not brokerage
                or (identity is not None and keys != identity)
                or source["Asset Type"] not in {"stock", "etf"}
            ):
                return None
            identity = keys
            row: dict[str, Any] = {
                name: source[column] if name in {"name", "symbol"} else _amount(source[column])
                for name, column in mapping.items()
            }
            row.update(
                asset_type=source["Asset Type"],
                sector=source["Sector"] or None,
                currency=currency,
                _import_source={"kind": "csv", "row": index},
            )
            positions.append(row)
    except ValueError:
        return None
    if identity is None or not _rows_match(positions):
        return None
    return {
        "statement_details": {
            "currency": identity[0],
            "statement_period_end": identity[1],
            "account_number": identity[2],
            "institution_name": identity[3],
        },
        "portfolio_summary": {},
        "detailed_holdings": positions,
        "cash_balance": None,
        "total_value": None,
    }


def is_declared_pdf(first_page: str) -> bool:
    return first_page.splitlines()[:1] == [_PDF_MARKER]


def _pdf_rows(
    lines: list[str], header_index: int, columns: tuple[str, ...], count: int, page: int
) -> list[dict[str, Any]]:
    expression = re.compile(
        r"([A-Z][A-Z0-9.-]*) (.+?) " + " ".join(f"({_AMOUNT})" for _ in columns)
    )
    pending = ""
    rows: list[dict[str, Any]] = []
    for line in lines[header_index + 1 :]:
        if not line:
            continue
        if len(rows) == count:
            if re.match(r"[A-Z][A-Z0-9.-]* .* \d[\d,.]*\s+\d", line):
                raise CsvLayoutUnsupported("unexpected_extra_pdf_row")
            break
        if len(pending) + len(line) > 1024:
            raise CsvLayoutUnsupported("pdf_wrapped_row_too_long")
        pending = f"{pending} {line}".strip()
        match = expression.fullmatch(pending)
        if match:
            symbol, name, *cells = match.groups()
            rows.append(
                {
                    "symbol": symbol,
                    "name": name,
                    **dict(zip(columns, map(_amount, cells), strict=True)),
                    "_import_source": {"kind": "pdf", "page": page, "row": len(rows) + 1},
                }
            )
            pending = ""
    if len(rows) != count:
        raise CsvLayoutUnsupported("declared_pdf_row_count")
    return rows


def declared_pdf(pages: list[str]) -> dict[str, Any] | None:
    """Recognize the explicitly marked QA format and verify its source controls."""
    rows: list[dict[str, Any]] = []
    totals: list[re.Match[str]] = []
    declared_counts: set[int] = set()
    try:
        for ordinal, text in enumerate(pages, 1):
            if not is_declared_pdf(text):
                return None
            lines = [line.strip() for line in text.splitlines()]
            totals.extend(match for line in lines if (match := _CONTROL.fullmatch(line)))
            ranges = [match for line in lines if (match := _RANGE.fullmatch(line))]
            headers = [i for i, line in enumerate(lines) if line in _PDF_LAYOUTS]
            if ordinal == 1 and not ranges and not headers:
                continue
            if len(ranges) != 1 or len(headers) != 1:
                return None
            first, last, declared = map(int, ranges[0].groups())
            if first != len(rows) + 1 or not first <= last <= declared <= _MAX_ROWS:
                return None
            declared_counts.add(declared)
            index = headers[0]
            section = _pdf_rows(lines, index, _PDF_LAYOUTS[lines[index]], last - first + 1, ordinal)
            subtotal = re.search(
                rf"(?m)^This page securities subtotal: ({_AMOUNT})$", text.replace("\r", "")
            )
            if subtotal and _sum(section, "market_value") != Decimal(str(_amount(subtotal[1]))):
                return None
            rows.extend(section)
        if declared_counts != {len(rows)} or len(totals) != 1 or not _rows_match(rows):
            return None
        count, market_text, cost_text, cash_text, total_text = totals[0].groups()
        market, cost, cash, total = map(_amount, (market_text, cost_text, cash_text, total_text))
    except ValueError:
        return None
    if (
        int(count) != len(rows)
        or _sum(rows, "market_value") != Decimal(str(market))
        or _sum(rows, "cost_basis") != Decimal(str(cost))
        or Decimal(str(market)) + Decimal(str(cash)) != Decimal(str(total))
    ):
        return None
    first_page = pages[0].splitlines()
    holder = re.search(
        r"(?m)^Account holder (.+?) Statement date (\d{4}-\d{2}-\d{2})\s*$", pages[0]
    )
    account = re.search(r"(?m)^Account number (\S+) Account type (.+?)\s*$", pages[0])
    if not holder or not account:
        return None
    return {
        "statement_details": {
            "currency": "USD",
            "institution_name": first_page[1].strip(),
            "account_name": holder[1],
            "statement_period_end": holder[2],
            "account_number": account[1],
            "account_type": account[2],
        },
        "portfolio_summary": {
            "declared_security_count": len(rows),
            "securities_market_value": market,
            "ending_value": total,
        },
        "detailed_holdings": rows,
        "cash_balance": cash,
        "total_value": total,
    }
