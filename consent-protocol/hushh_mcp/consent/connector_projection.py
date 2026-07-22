"""Deterministic post-decryption projections for trusted connectors.

These helpers run only after an authorized connector validates and decrypts a
Hussh scoped export. They do not alter consent, encryption, or the public MCP
tool contract. The projections are deliberately linear-time and never call an
LLM.
"""

from __future__ import annotations

from typing import Any

FINANCIAL_STATEMENT_BUNDLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "payload_type": {"type": "string", "const": "financial_statement_bundle.v1"},
        "statement_count": {"type": "integer", "minimum": 0},
        "holding_count": {"type": "integer", "minimum": 0},
        "statements": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "statement_ref": {"type": "string"},
                    "brokerage": {"type": "string"},
                    "account_type": {"type": "string"},
                    "statement_period_start": {"type": "string"},
                    "statement_period_end": {"type": "string"},
                    "beginning_value": {"type": "number"},
                    "ending_value": {"type": "number"},
                    "cash_balance": {"type": "number"},
                },
                "required": ["statement_ref"],
            },
        },
        "holdings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "holding_ref": {"type": "string"},
                    "statement_ref": {"type": "string"},
                    "position_index": {"type": "integer"},
                    "symbol": {"type": "string"},
                    "name": {"type": "string"},
                    "quantity": {"type": "number"},
                    "price": {"type": "number"},
                    "market_value": {"type": "number"},
                    "cost_basis": {"type": "number"},
                    "unrealized_gain_loss": {"type": "number"},
                    "asset_type": {"type": "string"},
                    "sector": {"type": "string"},
                    "is_cash_equivalent": {"type": "boolean"},
                    "is_investable": {"type": "boolean"},
                },
                "required": ["holding_ref", "statement_ref", "position_index"],
            },
        },
    },
    "required": [
        "payload_type",
        "statement_count",
        "holding_count",
        "statements",
        "holdings",
    ],
}


def _present_primitives(source: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    projected: dict[str, Any] = {}
    for field in fields:
        value = source.get(field)
        if not isinstance(value, (str, int, float, bool)):
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        projected[field] = value
    return projected


def normalize_financial_statement_bundle(
    decrypted_scope: dict[str, Any],
) -> dict[str, Any]:
    """Project financial documents to top-level statement and holding rows.

    ``statement_ref`` preserves the relationship between the two collections
    without nesting holdings beneath statements. Missing optional values are
    omitted rather than inferred.
    """

    financial = decrypted_scope.get("financial")
    documents = financial.get("documents") if isinstance(financial, dict) else None
    source_statements = documents.get("statements") if isinstance(documents, dict) else None
    if not isinstance(source_statements, list):
        source_statements = []

    statements: list[dict[str, Any]] = []
    holdings: list[dict[str, Any]] = []
    for statement_index, raw_statement in enumerate(source_statements):
        if not isinstance(raw_statement, dict):
            continue
        statement_ref = str(raw_statement.get("id") or f"statement_{statement_index}")
        account_info = raw_statement.get("account_info")
        account_info = account_info if isinstance(account_info, dict) else {}
        account_summary = raw_statement.get("account_summary")
        account_summary = account_summary if isinstance(account_summary, dict) else {}
        statements.append(
            {
                "statement_ref": statement_ref,
                **_present_primitives(
                    account_info,
                    (
                        "brokerage",
                        "account_type",
                        "statement_period_start",
                        "statement_period_end",
                    ),
                ),
                **_present_primitives(
                    account_summary,
                    ("beginning_value", "ending_value", "cash_balance"),
                ),
            }
        )

        raw_holdings = raw_statement.get("holdings")
        if not isinstance(raw_holdings, list):
            continue
        for position_index, raw_holding in enumerate(raw_holdings):
            if not isinstance(raw_holding, dict):
                continue
            holdings.append(
                {
                    "holding_ref": f"{statement_ref}:{position_index}",
                    "statement_ref": statement_ref,
                    "position_index": position_index,
                    **_present_primitives(
                        raw_holding,
                        (
                            "symbol",
                            "name",
                            "quantity",
                            "price",
                            "market_value",
                            "cost_basis",
                            "unrealized_gain_loss",
                            "asset_type",
                            "sector",
                            "is_cash_equivalent",
                            "is_investable",
                        ),
                    ),
                }
            )

    return {
        "payload_type": "financial_statement_bundle.v1",
        "statement_count": len(statements),
        "holding_count": len(holdings),
        "statements": statements,
        "holdings": holdings,
    }
