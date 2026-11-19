"""Kai portfolio import V2 required-key contract definitions."""

from __future__ import annotations

FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS: set[str] = {
    "statement_details",
    "portfolio_summary",
    "detailed_holdings",
    "cash_balance",
    "total_value",
}

INSTRUMENT_KINDS_V2 = ("equity", "fixed_income", "real_asset", "cash_equivalent", "other")

# Exact legacy type aliases are schema normalization, not issuer-name inference.
_ASSET_TYPE_KINDS = {
    **dict.fromkeys(
        (
            "equity",
            "equities",
            "stock",
            "stocks",
            "common_stock",
            "preferred",
            "preferred_stock",
            "adr",
        ),
        "equity",
    ),
    **dict.fromkeys(
        (
            "fixed_income",
            "bond",
            "bonds",
            "treasury",
            "treasury_bill",
            "treasury_note",
            "treasury_bond",
            "municipal_bond",
            "certificate_of_deposit",
            "cd",
        ),
        "fixed_income",
    ),
    **dict.fromkeys(
        ("real_asset", "real_assets", "real_estate", "reit", "commodity", "commodities", "gold"),
        "real_asset",
    ),
    **dict.fromkeys(
        (
            "cash",
            "cash_equivalent",
            "cash_equivalents",
            "money_market",
            "money_market_fund",
            "sweep",
        ),
        "cash_equivalent",
    ),
}


def normalize_instrument_kind_v2(
    instrument_kind: object,
    asset_type: object,
    *,
    security_listing_status: object = None,
    symbol_kind: object = None,
    is_sec_common_equity_ticker: bool = False,
) -> str:
    """Resolve allocation from declared kind, exact aliases, and listing metadata."""
    kind = str(instrument_kind or "").strip().lower()
    if kind in INSTRUMENT_KINDS_V2 and kind != "other":
        return kind
    asset_key = str(asset_type or "").strip().lower().replace("-", "_").replace(" ", "_")
    # ETF/fund alone does not establish its underlying asset category.
    asset_kind = _ASSET_TYPE_KINDS.get(asset_key)
    if asset_kind is not None:
        return asset_kind

    status = str(security_listing_status or "").strip().lower()
    listing_kind = str(symbol_kind or "").strip().lower()
    if status == "cash_or_sweep":
        return "cash_equivalent"
    if status == "fixed_income":
        return "fixed_income"
    if status == "non_sec_common_equity" or listing_kind == "fund_or_etf_ticker":
        return "other"
    if (
        status == "sec_common_equity"
        or listing_kind == "us_common_equity_ticker"
        or is_sec_common_equity_ticker
    ):
        return "equity"
    return "other"
