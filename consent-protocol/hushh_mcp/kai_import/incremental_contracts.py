"""Contracts for model-owned layouts and provisional extraction units."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _array(items: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": items}


_INT = {"type": "integer"}
_TEXT = {"type": "string"}
_RANGE = _object({"first": _INT, "last": _INT})
CSV_LAYOUT_SCHEMA = _object(
    {
        "decision": {"type": "string", "enum": ["mapped", "full_document"]},
        "header_row": {"anyOf": [_INT, {"type": "null"}]},
        "columns": _array(_object({"field": _TEXT, "column": _INT})),
        "position_ranges": _array(_RANGE),
        "other_ranges": _array(
            _object(
                {
                    "first": _INT,
                    "last": _INT,
                    "purpose": {
                        "type": "string",
                        "enum": ["header", "metadata", "summary", "disclosure", "blank"],
                    },
                }
            )
        ),
        "metadata": _array(_object({"field": _TEXT, "row": _INT, "column": _INT})),
        "decimal_separator": {"type": "string", "enum": [".", ","]},
        "group_separator": {"type": "string", "enum": ["", ".", ",", " ", "'"]},
        "currency": {"anyOf": [_TEXT, {"type": "null"}]},
    }
)


def page_extraction_schema(statement_schema: dict[str, Any]) -> dict[str, Any]:
    """Keep the canonical statement vocabulary, with explicitly sparse rows.

    Extra source-derived scalar fields remain valid. The existing managed Azure
    adapter uses its exact host-validated JSON path for this open-map contract,
    so it does not force every absent holding field into generated output.
    """
    schema = deepcopy(statement_schema)
    schema["properties"].update(
        {
            "requires_full_document": {"type": "boolean"},
            "continuation_pending": {"type": "boolean"},
            "continuation_context": {"type": "string"},
            "currency": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        }
    )
    schema["required"] = [
        *schema["required"],
        "requires_full_document",
        "continuation_pending",
        "continuation_context",
        "currency",
    ]
    row = schema["properties"]["detailed_holdings"]["items"]
    row["properties"]["starts_on_previous_page"] = {"type": "boolean"}
    row["additionalProperties"] = {
        "anyOf": [
            {"type": "string"},
            {"type": "number"},
            {"type": "boolean"},
            {"type": "null"},
        ]
    }
    return schema


class DocumentContextRequired(ValueError):
    """Page-local facts cannot safely settle the whole statement."""


class StatementAccumulator:
    def __init__(self) -> None:
        self.parsed: dict[str, Any] = {
            "statement_details": {},
            "portfolio_summary": {},
            "detailed_holdings": [],
            "cash_balance": None,
            "total_value": None,
            "historical_values": [],
        }
        self.currency: str | None = None

    def add(self, facts: dict[str, Any], holdings: list[dict[str, Any]]) -> None:
        for section in ("statement_details", "portfolio_summary"):
            incoming = facts.get(section, {})
            if not isinstance(incoming, dict):
                raise DocumentContextRequired("section_shape")
            for key, value in incoming.items():
                self._merge(self.parsed[section], key, value)
        for field in ("cash_balance", "total_value"):
            self._merge(self.parsed, field, facts.get(field))
        currency = facts.get("currency")
        if currency is not None:
            if (
                not isinstance(currency, str)
                or len(currency) != 3
                or not currency.isascii()
                or not currency.isalpha()
            ):
                raise DocumentContextRequired("currency_shape")
            currency = currency.upper()
            if self.currency is not None and self.currency != currency:
                raise DocumentContextRequired("currency_conflict")
            self.currency = currency
        history = facts.get("historical_values", [])
        if not isinstance(history, list):
            raise DocumentContextRequired("history_shape")
        by_date = {row["date"]: row for row in self.parsed["historical_values"]}
        for row in history:
            if not isinstance(row, dict) or not isinstance(row.get("date"), str):
                raise DocumentContextRequired("history_shape")
            previous = by_date.get(row["date"])
            if previous is not None and previous != row:
                raise DocumentContextRequired("history_conflict")
            by_date[row["date"]] = row
        self.parsed["historical_values"] = list(by_date.values())
        self.parsed["detailed_holdings"].extend(holdings)

    @staticmethod
    def _merge(target: dict[str, Any], key: str, value: Any) -> None:
        # A page-local null means no new evidence, never erase an earlier fact.
        if value is None:
            return
        if target.get(key) is not None and target[key] != value:
            raise DocumentContextRequired("statement_fact_conflict")
        target[key] = value


def nested_csv_facts(flat: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"statement_details": {}, "portfolio_summary": {}}
    for key, value in flat.items():
        if "." in key:
            section, field = key.split(".", 1)
            result[section][field] = value
        else:
            result[key] = value
    return result
