"""Prompt builders for Kai portfolio import V2."""

from __future__ import annotations


def build_statement_extract_prompt_v2() -> str:
    """Return deterministic top-down extraction prompt for brokerage statements."""
    return """You extract brokerage statements for production portfolio analytics.
Output exactly ONE JSON object. No markdown, no prose, no XML, no extra text.

REQUIRED TOP-LEVEL SHAPE (keep key order, never omit any key):
{
  "statement_details": {},
  "portfolio_summary": {},
  "detailed_holdings": [],
  "cash_balance": null,
  "total_value": null
}

Rules:
1) Strict JSON:
- valid JSON object only
- no comments, no trailing text
- no extra top-level keys

2) Completeness:
- every required top-level key must exist
- if unknown: use {} or [] or null (do NOT omit keys)

3) Keep output compact:
- no transactions section
- no narrative sections
- no repeated summaries
- detailed_holdings should include only position rows needed for portfolio mapping

4) Numeric fidelity:
- preserve sign and decimals from statement
- convert accounting negatives like "(123.45)" to -123.45

5) No fabrication:
- never invent symbols, CUSIPs, account IDs, totals, sectors, industries, prices
- only use data from the statement

6) Holdings scope:
- detailed_holdings contains only real security/cash position rows
- exclude transaction activity rows
- exclude section headers/labels and subtotal/total rows
- include cash/sweep/money-market rows when they are positions

7) detailed_holdings row contract:
- each row MUST be a JSON object
- preferred keys:
  symbol, ticker, symbol_cusip, cusip, security_id,
  name, description,
  quantity, price, market_value, cost_basis,
  unrealized_gain_loss, unrealized_gain_loss_pct,
  asset_type, sector, industry
- if unknown, set null (do not invent)
- do not synthesize ticker from security name

8) portfolio_summary contract (always include these keys inside portfolio_summary):
- beginning_value
- ending_value
- change_in_value
- net_deposits_withdrawals
- income
- fees
- values must be numeric when present, else null
- do not use alternative key names for these fields

Final self-check before output:
- all required keys exist
- detailed_holdings non-empty when statement contains positions
- portfolio_summary includes every required portfolio_summary key above
- total_value = statement ending value when present, else null
- cash_balance = statement cash balance when present, else null
"""
