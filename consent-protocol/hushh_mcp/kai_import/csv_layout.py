"""Decode CSV values only through an agent-authored, source-indexed layout.

The model owns column meaning and row roles. This module owns CSV syntax,
reference/coverage validation and numeric decoding, never brokerage heuristics.
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any


class CsvLayoutUnsupported(ValueError):
    """The compact mapping cannot safely represent this source."""


@dataclass(frozen=True)
class CsvBatch:
    start: int
    rows: tuple[tuple[str, ...], ...]

    @property
    def end(self) -> int:
        return self.start + len(self.rows) - 1


def read_csv_records(content: bytes) -> tuple[tuple[str, ...], ...]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    try:
        return tuple(tuple(row) for row in csv.reader(io.StringIO(text), strict=True))
    except csv.Error as exc:
        raise CsvLayoutUnsupported("csv_syntax") from exc


def csv_batches(
    rows: tuple[tuple[str, ...], ...], *, max_rows: int = 150, max_chars: int = 45_000
) -> list[CsvBatch]:
    batches: list[CsvBatch] = []
    start, size = 0, 0
    for index, row in enumerate(rows):
        length = sum(len(cell) for cell in row) + len(row) * 4
        if length > max_chars:
            raise CsvLayoutUnsupported("csv_record_too_large")
        if index > start and (index - start >= max_rows or size + length > max_chars):
            batches.append(CsvBatch(start, rows[start:index]))
            start, size = index, 0
        size += length
    if start < len(rows):
        batches.append(CsvBatch(start, rows[start:]))
    return batches


def _index(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise CsvLayoutUnsupported("csv_reference_invalid")
    return value


def _range_rows(groups: Any, batch: CsvBatch) -> set[int]:
    if not isinstance(groups, list):
        raise CsvLayoutUnsupported("csv_roles_invalid")
    result: set[int] = set()
    for group in groups:
        if not isinstance(group, dict):
            raise CsvLayoutUnsupported("csv_roles_invalid")
        first = _index(group.get("first"), batch.start, batch.end)
        last = _index(group.get("last"), first, batch.end)
        current = set(range(first, last + 1))
        if result.intersection(current):
            raise CsvLayoutUnsupported("csv_role_overlap")
        result.update(current)
    return result


def parse_csv_number(value: str, *, decimal: str, grouping: str) -> float | None:
    text = value.strip()
    if not text:
        return None
    if decimal not in {".", ","} or grouping not in {"", ".", ",", " ", "'"} or decimal == grouping:
        raise CsvLayoutUnsupported("csv_number_format_invalid")
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1].strip()
    text = text.replace("\u2212", "-")
    for symbol in ("$", "£", "€", "₹", "%"):
        text = text.replace(symbol, "")
    text = text.strip()
    if negative and text.startswith(("-", "+")):
        raise CsvLayoutUnsupported("csv_number_invalid")
    unsigned = text.removeprefix("-").removeprefix("+")
    parts = unsigned.split(decimal)
    if len(parts) > 2 or (len(parts) == 2 and not parts[1].isdigit()):
        raise CsvLayoutUnsupported("csv_number_invalid")
    integral = parts[0]
    if grouping and grouping in integral:
        groups = integral.split(grouping)
        if not (
            1 <= len(groups[0]) <= 3
            and groups[0].isdigit()
            and all(len(group) == 3 and group.isdigit() for group in groups[1:])
        ):
            raise CsvLayoutUnsupported("csv_number_invalid")
    if grouping:
        text = text.replace(grouping, "")
    text = text.replace(decimal, ".").strip()
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)", text):
        raise CsvLayoutUnsupported("csv_number_invalid")
    try:
        result = float(Decimal(text))
    except (InvalidOperation, ValueError) as exc:
        raise CsvLayoutUnsupported("csv_number_invalid") from exc
    if not math.isfinite(result):
        raise CsvLayoutUnsupported("csv_number_invalid")
    return -result if negative else result


def decode_csv_batch(
    records: tuple[tuple[str, ...], ...],
    batch: CsvBatch,
    layout: dict[str, Any],
    *,
    field_kinds: dict[str, str],
    metadata_kinds: dict[str, str],
    visible_header: int | None,
) -> tuple[list[dict[str, Any]], dict[str, Any], int | None]:
    if layout.get("decision") != "mapped":
        raise CsvLayoutUnsupported("csv_layout_requires_document")
    positions = _range_rows(layout.get("position_ranges"), batch)
    ignored = _range_rows(layout.get("other_ranges"), batch)
    populated = {
        batch.start + i for i, row in enumerate(batch.rows) if any(cell.strip() for cell in row)
    }
    if positions & ignored or not populated.issubset(positions | ignored):
        raise CsvLayoutUnsupported("csv_row_coverage_incomplete")
    header = layout.get("header_row")
    if header is not None:
        header = _index(header, 0, len(records) - 1)
        if header != visible_header and not batch.start <= header <= batch.end:
            raise CsvLayoutUnsupported("csv_unseen_header")
    columns = layout.get("columns")
    if not isinstance(columns, list) or (positions and (header is None or not columns)):
        raise CsvLayoutUnsupported("csv_columns_missing")
    mapping: dict[str, int] = {}
    for item in columns:
        field = item.get("field") if isinstance(item, dict) else None
        if field not in field_kinds or field in mapping or header is None:
            raise CsvLayoutUnsupported("csv_column_invalid")
        mapping[field] = _index(item.get("column"), 0, len(records[header]) - 1)
    decimal, grouping = layout.get("decimal_separator"), layout.get("group_separator")
    if not isinstance(decimal, str) or not isinstance(grouping, str):
        raise CsvLayoutUnsupported("csv_number_format_invalid")

    def value(cell: str, kind: str) -> Any:
        if kind == "number":
            return parse_csv_number(cell, decimal=decimal, grouping=grouping)
        return cell.strip() or None

    holdings: list[dict[str, Any]] = []
    for index in sorted(positions):
        record = records[index]
        if not any(cell.strip() for cell in record):
            continue
        if header is None or len(record) != len(records[header]):
            raise CsvLayoutUnsupported("csv_row_width_changed")
        holding = {
            field: value(record[column], field_kinds[field]) for field, column in mapping.items()
        }
        if not any(
            holding.get(field)
            for field in (
                "symbol",
                "ticker",
                "symbol_cusip",
                "cusip",
                "security_id",
                "name",
                "description",
            )
        ):
            raise CsvLayoutUnsupported("csv_position_identity_missing")
        holding["_import_source"] = {"kind": "csv", "row": index + 1}
        holdings.append(holding)

    facts: dict[str, Any] = {}
    metadata = layout.get("metadata")
    if not isinstance(metadata, list):
        raise CsvLayoutUnsupported("csv_metadata_invalid")
    for item in metadata:
        field = item.get("field") if isinstance(item, dict) else None
        if field not in metadata_kinds or field in facts:
            raise CsvLayoutUnsupported("csv_metadata_invalid")
        row = _index(item.get("row"), batch.start, batch.end)
        if row in positions:
            raise CsvLayoutUnsupported("csv_metadata_role_overlap")
        column = _index(item.get("column"), 0, len(records[row]) - 1)
        facts[field] = value(records[row][column], metadata_kinds[field])
    currency = layout.get("currency")
    if currency is not None:
        if (
            not isinstance(currency, str)
            or len(currency) != 3
            or not currency.isascii()
            or not currency.isalpha()
        ):
            raise CsvLayoutUnsupported("csv_currency_invalid")
        facts["currency"] = currency.upper()
    return holdings, facts, header
