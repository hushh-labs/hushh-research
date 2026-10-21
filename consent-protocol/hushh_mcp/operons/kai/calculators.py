# hushh_mcp/operons/kai/calculators.py

"""
Kai Calculator Operons

Pure calculation functions for financial analysis.
These are lightweight helpers used by analysis operons.

No consent validation needed - these are just math!
"""

import math
from typing import Any, Dict, List, Tuple

# ============================================================================
# FINANCIAL RATIO CALCULATORS
# ============================================================================


def _measured(value: Any) -> float | None:
    return (
        float(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        else None
    )


def _ratio(numerator: Any, denominator: Any) -> float | None:
    n, d = _measured(numerator), _measured(denominator)
    return n / d if n is not None and d is not None and d > 0 else None


def calculate_financial_ratios(sec_filings: Dict[str, Any]) -> Dict[str, Any]:
    latest = sec_filings.get("latest_10k", {})

    def value(name):
        return _measured(latest.get(name))

    equity = value("equity")
    if (
        equity is None
        and value("total_assets") is not None
        and value("total_liabilities") is not None
    ):
        equity = value("total_assets") - value("total_liabilities")
    result = {
        "ticker": sec_filings.get("ticker"),
        "cik": sec_filings.get("cik"),
        "entity_name": sec_filings.get("entity_name"),
        "period_end": latest.get("period_end"),
        "profit_margin": _ratio(value("net_income"), value("revenue")),
        "fcf_margin": _ratio(value("free_cash_flow"), value("revenue")),
        "return_on_equity": _ratio(value("net_income"), equity),
        "debt_to_equity": _ratio(value("long_term_debt"), equity),
        "debt_to_equity_basis": "Noncurrent long-term debt / equity; excludes current debt and short-term borrowings",
        "current_ratio": _ratio(value("current_assets"), value("current_liabilities")),
        "rnd_intensity": _ratio(value("research_and_development"), value("revenue")),
        "earnings_quality": _ratio(value("operating_cash_flow"), value("net_income")),
    }
    for source, output in (
        ("revenue", "revenue_billions"),
        ("free_cash_flow", "fcf_billions"),
        ("total_assets", "total_assets_billions"),
        ("long_term_debt", "long_term_debt_billions"),
        ("research_and_development", "research_and_development_billions"),
    ):
        amount = value(source)
        result[output] = amount / 1e9 if amount is not None else None
    result["revenue_growth_yoy"] = calculate_quant_metrics(sec_filings)["revenue_growth_yoy"]
    return result


def calculate_quant_metrics(sec_filings: Dict[str, Any]) -> Dict[str, Any]:
    latest = sec_filings.get("latest_10k", {})

    def trend(name):
        return [row for row in latest.get(name, []) if _measured(row.get("value")) is not None]

    def growth(rows):
        if len(rows) < 2 or int(rows[-1]["year"]) - int(rows[-2]["year"]) != 1:
            return None
        previous = _measured(rows[-2]["value"])
        return (rows[-1]["value"] - previous) / abs(previous) if previous else None

    revenue = trend("revenue_trend")
    cagr = None
    if len(revenue) >= 4:
        window = revenue[-4:]
        years = [int(row["year"]) for row in window]
        if (
            all(b - a == 1 for a, b in zip(years, years[1:], strict=False))
            and window[0]["value"] > 0
            and window[-1]["value"] >= 0
        ):
            cagr = (window[-1]["value"] / window[0]["value"]) ** (1 / (years[-1] - years[0])) - 1
    result = {"revenue_cagr_3y": cagr}
    for source, output in (
        ("revenue_trend", "revenue"),
        ("net_income_trend", "net_income"),
        ("ocf_trend", "ocf"),
        ("rnd_trend", "rnd"),
    ):
        rows = trend(source)
        result[f"{output}_growth_yoy"] = growth(rows)
        result[f"{output}_trend_data"] = [
            {"year": row["year"], "value": round(row["value"] / 1e9, 2)} for row in rows
        ]
    return result


def assess_fundamental_health(metrics: Dict[str, float]) -> Tuple[List[str], List[str], float]:
    """
    Assess fundamental health from financial ratios.

    Args:
        metrics: Financial ratios

    Returns:
        Tuple of (strengths, weaknesses, health_score)
    """
    strengths = []
    weaknesses = []

    # Revenue growth
    if metrics.get("revenue_growth_yoy") is not None and metrics["revenue_growth_yoy"] > 0.1:
        strengths.append("Strong revenue growth (>10% YoY)")
    elif metrics.get("revenue_growth_yoy") is not None and metrics["revenue_growth_yoy"] < 0:
        weaknesses.append("Declining revenue")

    # Profitability
    if metrics.get("profit_margin") is not None and metrics["profit_margin"] > 0.15:
        strengths.append("Healthy profit margins (>15%)")
    elif metrics.get("profit_margin") is not None and metrics["profit_margin"] < 0.05:
        weaknesses.append("Low profit margins (<5%)")

    # Debt levels
    if metrics.get("debt_to_equity") is not None and metrics["debt_to_equity"] < 0.5:
        strengths.append("Low debt levels")
    elif metrics.get("debt_to_equity") is not None and metrics["debt_to_equity"] > 1.5:
        weaknesses.append("High debt burden")

    # Liquidity
    if metrics.get("current_ratio") is not None and metrics["current_ratio"] > 1.5:
        strengths.append("Strong liquidity")
    elif metrics.get("current_ratio") is not None and metrics["current_ratio"] < 1.0:
        weaknesses.append("Liquidity concerns")

    # Calculate health score (0-1)
    strength_score = min(len(strengths) / 4, 1.0)
    weakness_penalty = min(len(weaknesses) / 4, 0.5)
    health_score = max(strength_score - weakness_penalty, 0.0)

    return strengths, weaknesses, health_score


# ============================================================================
# SENTIMENT CALCULATORS
# ============================================================================


def calculate_sentiment_score(news_articles: List[Dict[str, Any]]) -> float:
    """
    Calculate aggregate sentiment score from news articles.

    Args:
        news_articles: List of news dicts with title, description

    Returns:
        Sentiment score from -1 (very negative) to +1 (very positive)
    """
    if not news_articles:
        return 0.0

    # Mock sentiment calculation
    # In production, use NLP library like transformers or TextBlob

    positive_keywords = ["growth", "strong", "beat", "upgrade", "bullish", "positive"]
    negative_keywords = ["decline", "miss", "downgrade", "bearish", "negative", "concern"]

    scores = []
    for article in news_articles:
        text = f"{article.get('title', '')} {article.get('description', '')}".lower()

        pos_count = sum(1 for kw in positive_keywords if kw in text)
        neg_count = sum(1 for kw in negative_keywords if kw in text)

        # Simple sentiment score
        if pos_count > neg_count:
            scores.append(0.5)
        elif neg_count > pos_count:
            scores.append(-0.5)
        else:
            scores.append(0.0)

    return sum(scores) / len(scores) if scores else 0.0


def extract_catalysts_from_news(news_articles: List[Dict[str, Any]]) -> List[str]:
    """
    Extract key catalysts/events from news.

    Args:
        news_articles: List of news dicts

    Returns:
        List of catalyst strings
    """
    catalysts = []

    catalyst_keywords = [
        "earnings",
        "acquisition",
        "product launch",
        "FDA approval",
        "partnership",
        "contract",
        "innovation",
        "expansion",
    ]

    for article in news_articles[:10]:  # Top 10 articles
        title = article.get("title", "").lower()

        for keyword in catalyst_keywords:
            if keyword in title:
                catalysts.append(article.get("title", "")[:100])
                break

    return catalysts[:5]  # Top 5 catalysts


# ============================================================================
# VALUATION CALCULATORS
# ============================================================================


def calculate_valuation_metrics(market_data: Dict[str, Any]) -> Dict[str, float]:
    """
    Calculate valuation metrics from market data.

    Args:
        market_data: Current price, market cap, financials (from yfinance)

    Returns:
        Dict of valuation metrics
    """
    result = {
        name: _measured(market_data.get(name))
        for name in (
            "pe_ratio",
            "pb_ratio",
            "forward_pe",
            "ps_ratio",
            "ev_ebitda",
            "dividend_yield",
            "52w_low",
            "52w_high",
            "market_cap",
            "price_to_fcf",
        )
    }
    enterprise = _measured(market_data.get("enterprise_value"))
    result["enterprise_value_billions"] = enterprise / 1e9 if enterprise is not None else None
    return result


# ============================================================================
# RETURN & VOLATILITY CALCULATORS (AlphaAgents Paper Section 2.2.3)
# ============================================================================

TRADING_DAYS_PER_YEAR = 252  # Standard for US equity markets


def calculate_annualized_return(prices: List[float]) -> float:
    """
    Calculate annualized cumulative return from a price series.

    Formula from AlphaAgents paper:
        R_cumulative = (P_T / P_0) - 1
        R_annualized = (1 + R_cumulative)^(252 / T) - 1

    where T is the number of trading days, P_0 is the first price, P_T is the last.

    Args:
        prices: List of daily closing prices (oldest first).

    Returns:
        Annualized return as a decimal (e.g. 0.12 for 12%).
        Returns 0.0 if insufficient data.
    """
    if not prices or len(prices) < 2:
        return 0.0

    p0 = prices[0]
    pt = prices[-1]

    if p0 <= 0:
        return 0.0

    t = len(prices) - 1  # Number of trading day intervals
    r_cumulative = (pt / p0) - 1.0

    # Annualize: (1 + R_cum)^(252/T) - 1
    try:
        r_annualized = (1.0 + r_cumulative) ** (TRADING_DAYS_PER_YEAR / t) - 1.0
    except (OverflowError, ZeroDivisionError):
        return 0.0

    return r_annualized


def calculate_annualized_volatility(prices: List[float]) -> float:
    """
    Calculate annualized volatility (standard deviation of daily log returns).

    Formula from AlphaAgents paper:
        r_i = ln(P_i / P_{i-1})           (daily log return)
        sigma_daily = std(r_1 ... r_T)
        sigma_annualized = sigma_daily * sqrt(252)

    Args:
        prices: List of daily closing prices (oldest first).

    Returns:
        Annualized volatility as a decimal (e.g. 0.25 for 25%).
        Returns 0.0 if insufficient data.
    """
    if not prices or len(prices) < 3:
        return 0.0

    # Compute daily log returns
    log_returns: List[float] = []
    for i in range(1, len(prices)):
        if prices[i] > 0 and prices[i - 1] > 0:
            log_returns.append(math.log(prices[i] / prices[i - 1]))

    if len(log_returns) < 2:
        return 0.0

    # Standard deviation of log returns
    mean_r = sum(log_returns) / len(log_returns)
    variance = sum((r - mean_r) ** 2 for r in log_returns) / (len(log_returns) - 1)
    sigma_daily = math.sqrt(variance)

    # Annualize
    sigma_annualized = sigma_daily * math.sqrt(TRADING_DAYS_PER_YEAR)

    return sigma_annualized


def calculate_sharpe_ratio(
    prices: List[float],
    risk_free_rate: float = 0.05,
) -> float:
    """
    Calculate annualized Sharpe ratio from a price series.

    Formula:
        Sharpe = (R_annualized - R_f) / sigma_annualized

    Args:
        prices: List of daily closing prices (oldest first).
        risk_free_rate: Annualized risk-free rate (default 5% ~ US T-bill).

    Returns:
        Sharpe ratio. Returns 0.0 if volatility is zero or data insufficient.
    """
    r_ann = calculate_annualized_return(prices)
    sigma_ann = calculate_annualized_volatility(prices)

    if sigma_ann <= 0:
        return 0.0

    return (r_ann - risk_free_rate) / sigma_ann


def calculate_return_and_risk_metrics(
    prices: List[float], risk_free_rate: float = 0.05
) -> Dict[str, float]:
    """
    Convenience wrapper returning all return/risk metrics at once.

    Args:
        prices: List of daily closing prices (oldest first).
        risk_free_rate: Annualized risk-free rate.

    Returns:
        Dict with annualized_return, annualized_volatility, sharpe_ratio.
    """
    return {
        "annualized_return": calculate_annualized_return(prices),
        "annualized_volatility": calculate_annualized_volatility(prices),
        "sharpe_ratio": calculate_sharpe_ratio(prices, risk_free_rate),
    }
