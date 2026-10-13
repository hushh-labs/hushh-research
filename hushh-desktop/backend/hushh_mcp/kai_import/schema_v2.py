"""Kai portfolio import V2 required-key contract definitions."""

from __future__ import annotations

FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS: set[str] = {
    "statement_details",
    "portfolio_summary",
    "detailed_holdings",
    "cash_balance",
    "total_value",
}
