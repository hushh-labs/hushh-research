def _make_filing(
    *,
    revenue=1_000_000_000,
    net_income=150_000_000,
    total_assets=2_000_000_000,
    total_liabilities=800_000_000,
    free_cash_flow=120_000_000,
    long_term_debt=400_000_000,
    equity=None,
    research_and_development=50_000_000,
    operating_cash_flow=200_000_000,
    ticker="TEST",
    cik="0001234567",
) -> dict:
    latest = {
        "revenue": revenue,
        "net_income": net_income,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "free_cash_flow": free_cash_flow,
        "long_term_debt": long_term_debt,
        "research_and_development": research_and_development,
        "operating_cash_flow": operating_cash_flow,
    }
    if equity is not None:
        latest["equity"] = equity
    return {"ticker": ticker, "cik": cik, "entity_name": "Test Corp", "latest_10k": latest}
