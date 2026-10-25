"""Compatibility projection of the statement extractor's declared output."""

from typing import Any

from .balance_history import normalize_balance_history


def build_raw_statement_extract(
    *,
    statement_details: dict[str, Any],
    portfolio_summary: dict[str, Any],
    detailed_holdings: list[dict[str, Any]],
    cash_balance: Any,
    total_value: Any,
    historical_values: Any,
) -> dict[str, Any]:
    return {
        "statement_details": statement_details,
        "portfolio_summary": portfolio_summary,
        "detailed_holdings": detailed_holdings,
        "cash_balance": cash_balance,
        "total_value": total_value,
        # Compatibility defaults for existing consumers.
        "account_metadata": {},
        "asset_allocation": [],
        "portfolio_detail": {},
        "transactions": {},
        "reconciliation_summary": {},
        "investment_objective": {},
        "management_contacts": {},
        "derived_metrics": {},
        "income_summary": {},
        "realized_gain_loss": {},
        "cash_flow": {},
        "cash_management": {},
        "projections_and_mrd": {},
        "historical_values": normalize_balance_history(historical_values),
        "ytd_metrics": {},
        "legal_and_disclosures": {},
    }
