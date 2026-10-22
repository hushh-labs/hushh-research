"""Pure valuation prompt assembly from supplied public measurements."""


def valuation_prompt(ticker, market_data, peer_data, user_context):
    # 2. Build Context
    peer_context = (
        "\n".join(
            [
                f"- {p.get('ticker', 'N/A')}: P/E={p.get('pe_ratio', 'N/A')}, Growth={p.get('growth', 'N/A')}"
                for p in (peer_data or [])[:5]
            ]
        )
        if peer_data
        else "No peer data available."
    )

    user_risk = user_context.get("risk_tolerance", "Balanced") if user_context else "Balanced"

    labels = {
        "price": "Current Price (provider quote)",
        "pe_ratio": "P/E Ratio",
        "forward_pe": "Forward P/E",
        "pb_ratio": "P/B Ratio",
        "ps_ratio": "P/S Ratio",
        "ev_ebitda": "EV/EBITDA",
        "market_cap": "Market Cap",
        "dividend_yield": "Dividend Yield (fraction; 0.02 = 2%)",
        "52w_low": "52-Week Low",
        "52w_high": "52-Week High",
    }
    supplied_metrics = "\n".join(
        f"{label}: {market_data[key]}"
        for key, label in labels.items()
        if market_data.get(key) is not None
    )
    context = f"""
    --- VALUATION ANALYSIS TERMINAL ({ticker}) ---
    [Supplied market measurements; omitted fields are unavailable]
    {supplied_metrics}
    [Provider consensus; unavailable means no price targets]
    {market_data.get("target_consensus", {"status": "unavailable"})}
    [Peer Comparison]
    {peer_context}
    [Investor Profile]
    Risk Tolerance: {user_risk}
    """

    system_instruction = """
You are a **Quantitative Valuation Analyst** at an institutional investment firm.

Perform a comprehensive valuation analysis with focus on relative and intrinsic value.

### REPORT STRUCTURE (Strict JSON)
- `summary`: (String) 1-paragraph valuation assessment
- `valuation_verdict`: (String) "undervalued", "fair", or "overvalued"
- `valuation_metrics`: (Dict) Key metrics analyzed with values
- `peer_ranking`: (String) How this stock ranks vs peers
- `price_targets`: Copy only conservative/base_case/optimistic from the supplied provider consensus. Return {} when unavailable. Never estimate or invent targets.
- `upside_downside`: (Dict) {"upside_pct": X, "downside_pct": Y}
- `confidence`: (Float 0.0-1.0)
- `recommendation`: (String: "undervalued", "fair", "overvalued")

### RULES
- Use multiple valuation methods (P/E, EV/EBITDA, DCF if possible)
- Compare to sector averages
- Consider growth rates when evaluating multiples
- Keep wording concise and investor-friendly
- DO NOT use markdown inside JSON strings
"""

    return f"{system_instruction}\n\nCONTEXT:\n{context}"
