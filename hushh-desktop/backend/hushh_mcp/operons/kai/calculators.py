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


def calculate_financial_ratios(sec_filings: Dict[str, Any]) -> Dict[str, float]:
    """
    Calculate key financial ratios from SEC filings.

    Args:
        sec_filings: Parsed SEC filing data with expanded deep metrics

    Returns:
        Dict of financial metrics
    """
    # Extract real financial data from SEC filings
    latest_10k = sec_filings.get("latest_10k", {})

    revenue = latest_10k.get("revenue", 0)
    net_income = latest_10k.get("net_income", 0)
    total_assets = latest_10k.get("total_assets", 1)
    total_liabilities = latest_10k.get("total_liabilities", 0)

    # Use expanded deep metrics if available
    fcf = latest_10k.get("free_cash_flow", 0)
    long_term_debt = latest_10k.get("long_term_debt", 0)
    equity = latest_10k.get("equity") or max(total_assets - total_liabilities, 1)
    rnd = latest_10k.get("research_and_development", 0)
    ocf = latest_10k.get("operating_cash_flow", 0)

    # Calculate actual ratios
    profit_margin = (net_income / revenue) if revenue > 0 else 0
    return_on_equity = (net_income / equity) if equity > 0 else 0
    debt_to_equity = (long_term_debt / equity) if equity > 0 else (total_liabilities / equity)

    # Quant analyst ratios
    fcf_margin = (fcf / revenue) if revenue > 0 else 0
    rnd_intensity = (rnd / revenue) if revenue > 0 else 0
    earnings_quality = (ocf / net_income) if net_income > 0 else 0

    revenue_billions = revenue / 1_000_000_000 if revenue > 0 else 0
    fcf_billions = fcf / 1_000_000_000 if fcf != 0 else 0

    return {
        "ticker": sec_filings.get("ticker"),
        "cik": sec_filings.get("cik"),
        "entity_name": sec_filings.get("entity_name"),
        "revenue_billions": revenue_billions,
        "fcf_billions": fcf_billions,
        "profit_margin": profit_margin,
        "fcf_margin": fcf_margin,
        "debt_to_equity": debt_to_equity,
        "return_on_equity": return_on_equity,
        "rnd_intensity": rnd_intensity,
        "earnings_quality": earnings_quality,
        "total_assets_billions": total_assets / 1_000_000_000,
        "long_term_debt_billions": long_term_debt / 1_000_000_000,
        "research_and_development_billions": rnd / 1_000_000_000 if rnd > 0 else 0,
    }


def calculate_quant_metrics(sec_filings: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process historical trends to generate quant signals and growth rates.
    """
    latest_10k = sec_filings.get("latest_10k", {})

    def get_growth_rate(trend: List[Dict[str, Any]]) -> float:
        if len(trend) < 2:
            return 0.0
        latest = trend[-1]["value"]
        previous = trend[-2]["value"]
        if previous == 0:
            return 0.0
        return (latest - previous) / previous

    revenue_trend = latest_10k.get("revenue_trend", [])
    net_income_trend = latest_10k.get("net_income_trend", [])
    ocf_trend = latest_10k.get("ocf_trend", [])
    rnd_trend = latest_10k.get("rnd_trend", [])

    return {
        "revenue_growth_yoy": get_growth_rate(revenue_trend),
        "net_income_growth_yoy": get_growth_rate(net_income_trend),
        "ocf_growth_yoy": get_growth_rate(ocf_trend),
        "revenue_cagr_3y": ((revenue_trend[-1]["value"] / revenue_trend[0]["value"]) ** (1 / 3) - 1)
        if len(revenue_trend) >= 3 and revenue_trend[0]["value"] > 0
        else 0,
        "revenue_trend_data": [
            {"year": d["year"], "value": round(d["value"] / 1e9, 2)} for d in revenue_trend
        ],
        "net_income_trend_data": [
            {"year": d["year"], "value": round(d["value"] / 1e9, 2)} for d in net_income_trend
        ],
        "ocf_trend_data": [
            {"year": d["year"], "value": round(d["value"] / 1e9, 2)} for d in ocf_trend
        ],
        "rnd_trend_data": [
            {"year": d["year"], "value": round(d["value"] / 1e9, 2)} for d in rnd_trend
        ],
    }


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
    if metrics.get("revenue_growth_yoy", 0) > 0.1:
        strengths.append("Strong revenue growth (>10% YoY)")
    elif metrics.get("revenue_growth_yoy", 0) < 0:
        weaknesses.append("Declining revenue")

    # Profitability
    if metrics.get("profit_margin", 0) > 0.15:
        strengths.append("Healthy profit margins (>15%)")
    elif metrics.get("profit_margin", 0) < 0.05:
        weaknesses.append("Low profit margins (<5%)")

    # Debt levels
    if metrics.get("debt_to_equity", 0) < 0.5:
        strengths.append("Low debt levels")
    elif metrics.get("debt_to_equity", 0) > 1.5:
        weaknesses.append("High debt burden")

    # Liquidity
    if metrics.get("current_ratio", 0) > 1.5:
        strengths.append("Strong liquidity")
    elif metrics.get("current_ratio", 0) < 1.0:
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
    # Extract real data from market_data (from yfinance)
    pe_ratio = market_data.get("pe_ratio", 0)
    pb_ratio = market_data.get("pb_ratio", 0)
    dividend_yield = market_data.get("dividend_yield", 0)
    market_cap = market_data.get("market_cap", 0)
    # Calculate PS ratio if we have revenue data
    # (Would need to pass revenue from SEC data - future enhancement)
    ps_ratio = 0  # Placeholder

    # Enterprise value approximation (market cap for simplicity)
    enterprise_value_billions = market_cap / 1_000_000_000 if market_cap > 0 else 0

    # Price to FCF would need cash flow data
    price_to_fcf = 0  # Placeholder

    return {
        "pe_ratio": pe_ratio or 0,
        "pb_ratio": pb_ratio or 0,
        "ps_ratio": ps_ratio,
        "dividend_yield": dividend_yield or 0,
        "enterprise_value_billions": enterprise_value_billions,
        "price_to_fcf": price_to_fcf,
    }


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


# ============================================================================
# COMPOUND GROWTH PROJECTION
# ============================================================================


def calculate_compound_growth(
    principal: float,
    annual_rate: float,
    years: float,
    contributions_per_year: float = 0.0,
    compounds_per_year: int = 1,
) -> Dict[str, float]:
    """
    Project the future value of an investment under compound interest, with
    optional regular contributions (ordinary annuity: contributions land at
    the end of each compounding period, then earn interest going forward).

    This is precisely the kind of multi-step financial math Kai's local
    (on-device) chat mode is instructed to avoid answering directly (see
    agent_chat_service.py's local_math_guardrail) -- small LLMs, local and
    cloud alike, are unreliable at exactly this. A deterministic calculator
    has no such failure mode, which is the whole point of exposing it as an
    MCP tool any orchestrator (Hermes, Kai) can call for a precise answer
    instead of asking a model to compute it.

    Formula (per-period rate r = annual_rate / compounds_per_year, over
    n = years * compounds_per_year periods):
        FV_principal = P * (1 + r)^n
        FV_contributions = C * [(1 + r)^n - 1] / r   (future value of an
            ordinary annuity, C = contribution per compounding period)

    Args:
        principal: Starting amount.
        annual_rate: Annual interest rate as a decimal (e.g. 0.07 for 7%).
        years: Number of years to project (may be fractional).
        contributions_per_year: Total additional amount contributed per
            year, spread evenly across compounding periods. 0 by default.
        compounds_per_year: Compounding frequency (1 = annual, 12 = monthly,
            365 = daily). Must be a positive integer.

    Returns:
        Dict with future_value, total_contributions, total_principal_and_contributions,
        and total_interest_earned.

    Raises:
        ValueError: if years < 0, compounds_per_year <= 0, or principal/
            contributions_per_year < 0 -- deterministic tools should reject
            nonsensical input rather than silently returning a meaningless
            number.
    """
    if years < 0:
        raise ValueError("years must be >= 0")
    if compounds_per_year <= 0:
        raise ValueError("compounds_per_year must be a positive integer")
    if principal < 0 or contributions_per_year < 0:
        raise ValueError("principal and contributions_per_year must be >= 0")

    n_periods = years * compounds_per_year
    contribution_per_period = contributions_per_year / compounds_per_year

    if annual_rate == 0:
        # Degenerate case: (1+r)^n - 1)/r is undefined at r=0 (0/0), and
        # simplifies to n_periods * contribution_per_period directly.
        future_value_principal = principal
        future_value_contributions = contribution_per_period * n_periods
    else:
        r = annual_rate / compounds_per_year
        growth_factor = (1.0 + r) ** n_periods
        future_value_principal = principal * growth_factor
        future_value_contributions = (
            contribution_per_period * (growth_factor - 1.0) / r if r != 0 else 0.0
        )

    future_value = future_value_principal + future_value_contributions
    total_contributions = contribution_per_period * n_periods
    total_principal_and_contributions = principal + total_contributions

    return {
        "future_value": future_value,
        "total_contributions": total_contributions,
        "total_principal_and_contributions": total_principal_and_contributions,
        "total_interest_earned": future_value - total_principal_and_contributions,
    }
