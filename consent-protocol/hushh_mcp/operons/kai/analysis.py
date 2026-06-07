# hushh_mcp/operons/kai/analysis.py

"""
Kai Analysis Operons

Core business logic for stock analysis with explicit consent validation.
Each function is a single-purpose operon that validates TrustLinks before execution.

Pattern:
1. Validate consent token FIRST
2. Perform business logic
3. Return structured result
"""

import logging
from typing import Any, Dict, List

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import UserID

from .calculators import (
    assess_fundamental_health,
    calculate_financial_ratios,
    calculate_sentiment_score,
    extract_catalysts_from_news,
)

logger = logging.getLogger(__name__)


# ============================================================================
# OPERON: analyze_fundamentals
# ============================================================================


def analyze_fundamentals(
    ticker: str,
    user_id: UserID,
    sec_filings: Dict[str, Any],
    consent_token: str,
) -> Dict[str, Any]:
    """
    Operon: Analyze company fundamentals from SEC filings.

    TrustLink Required: agent.kai.analyze

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        sec_filings: Retrieved SEC filing data containing 10-K/10-Q
        consent_token: Valid consent token

    Returns:
        Dict with fundamental analysis insights:
        - summary: Text summary
        - key_metrics: Financial ratios and metrics
        - strengths: List of positive factors
        - weaknesses: List of negative factors
        - confidence: Confidence score (0-1)
        - recommendation: "buy", "hold", or "reduce"

    Raises:
        PermissionError: If TrustLink validation fails
    """
    # Step 1: Validate TrustLink
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        logger.error(f"[Fundamental Operon] TrustLink validation failed: {reason}")
        raise PermissionError(f"TrustLink validation failed: {reason}")

    if token.user_id != user_id:
        raise PermissionError(f"Token user mismatch: expected {user_id}, got {token.user_id}")

    logger.info("[Fundamental Operon] Analyzing %s (user=[redacted])", ticker)

    # Step 2: Calculate financial metrics
    metrics = calculate_financial_ratios(sec_filings)

    # Step 3: Assess fundamental health
    strengths, weaknesses, health_score = assess_fundamental_health(metrics)

    # Step 4: Generate summary
    summary = _generate_fundamental_summary(ticker, metrics, health_score)

    # Step 5: Determine recommendation
    recommendation = _fundamental_to_recommendation(health_score, metrics)

    return {
        "summary": summary,
        "key_metrics": metrics,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "confidence": health_score,
        "recommendation": recommendation,
    }


# ============================================================================
# OPERON: analyze_sentiment
# ============================================================================


def analyze_sentiment(
    ticker: str,
    user_id: UserID,
    news_articles: List[Dict[str, Any]],
    consent_token: str,
) -> Dict[str, Any]:
    """
    Operon: Analyze market sentiment from news articles.

    TrustLink Required: agent.kai.analyze

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        news_articles: List of news article dicts with title, description, publishedAt
        consent_token: Valid consent token

    Returns:
        Dict with sentiment analysis:
        - summary: Text summary
        - sentiment_score: Aggregate score (-1 to +1)
        - key_catalysts: List of identified catalysts
        - confidence: Confidence score (0-1)
        - recommendation: "buy", "hold", or "reduce"

    Raises:
        PermissionError: If TrustLink validation fails
    """
    # Validate TrustLink
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        logger.error(f"[Sentiment Operon] TrustLink validation failed: {reason}")
        raise PermissionError(f"TrustLink validation failed: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info("[Sentiment Operon] Analyzing %s (user=[redacted])", ticker)

    # Calculate aggregate sentiment
    sentiment_score = calculate_sentiment_score(news_articles)

    # Extract key catalysts
    catalysts = extract_catalysts_from_news(news_articles)

    # Generate summary
    summary = _generate_sentiment_summary(ticker, sentiment_score, catalysts)

    # Determine confidence based on article count and recency
    confidence = _calculate_sentiment_confidence(news_articles, sentiment_score)

    # Recommendation
    recommendation = _sentiment_to_recommendation(sentiment_score)

    return {
        "summary": summary,
        "sentiment_score": sentiment_score,
        "key_catalysts": catalysts,
        "confidence": confidence,
        "recommendation": recommendation,
    }


# ============================================================================
# OPERON: analyze_valuation
# ============================================================================


def analyze_valuation(
    ticker: str,
    user_id: UserID,
    market_data: Dict[str, Any],
    peer_data: List[Dict[str, Any]],
    consent_token: str,
) -> Dict[str, Any]:
    """
    Operon: Perform valuation analysis with peer comparison.

    TrustLink Required: agent.kai.analyze

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        market_data: Current market data (price, PE, volume, etc.)
        peer_data: Peer company data for comparison
        consent_token: Valid consent token

    Returns:
        Dict with valuation analysis:
        - summary: Text summary
        - valuation_metrics: P/E, P/B, DCF estimate, etc.
        - peer_comparison: Comparison to industry peers
        - confidence: Confidence score (0-1)
        - recommendation: "buy", "hold", or "reduce"

    Raises:
        PermissionError: If TrustLink validation fails
    """
    # Validate TrustLink
    valid, reason, token = validate_token(consent_token, ConsentScope("agent.kai.analyze"))

    if not valid:
        logger.error(f"[Valuation Operon] TrustLink validation failed: {reason}")
        raise PermissionError(f"TrustLink validation failed: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info("[Valuation Operon] Analyzing %s (user=[redacted])", ticker)

    # Calculate valuation metrics
    from .calculators import calculate_valuation_metrics

    metrics = calculate_valuation_metrics(market_data)

    # Peer comparison
    peer_comparison = _compare_to_peers(metrics, peer_data)

    # Generate summary
    summary = _generate_valuation_summary(ticker, metrics, peer_comparison)

    # Confidence
    confidence = _calculate_valuation_confidence(metrics, peer_comparison)

    # Recommendation
    recommendation = _valuation_to_recommendation(metrics, peer_comparison)

    return {
        "summary": summary,
        "valuation_metrics": metrics,
        "peer_comparison": peer_comparison,
        "confidence": confidence,
        "recommendation": recommendation,
    }


# ============================================================================
# PRIVATE HELPER FUNCTIONS
# ============================================================================


def _generate_fundamental_summary(
    ticker: str, metrics: Dict[str, float], health_score: float
) -> str:
    """Generate human-readable fundamental summary."""
    revenue_growth = metrics.get("revenue_growth_yoy", 0)
    profit_margin = metrics.get("profit_margin", 0)

    if health_score > 0.75:
        tone = "Strong"
    elif health_score > 0.5:
        tone = "Solid"
    else:
        tone = "Weak"

    return (
        f"{tone} fundamentals with {revenue_growth:.1%} YoY revenue growth "
        f"and {profit_margin:.1%} profit margin."
    )


def _generate_sentiment_summary(ticker: str, sentiment_score: float, catalysts: List[str]) -> str:
    """Generate human-readable sentiment summary."""
    if sentiment_score > 0.3:
        tone = "Positive"
    elif sentiment_score > -0.3:
        tone = "Neutral"
    else:
        tone = "Negative"

    catalyst_text = f"Key catalyst: {catalysts[0]}" if catalysts else "No major catalysts"

    return f"{tone} market sentiment. {catalyst_text}"


def _generate_valuation_summary(
    ticker: str, metrics: Dict[str, float], peer_comparison: Dict[str, Any]
) -> str:
    """Generate human-readable valuation summary."""
    pe_ratio = metrics.get("pe_ratio", 0)
    vs_peers = peer_comparison.get("vs_peer_avg", "in_line")

    if vs_peers == "undervalued":
        return f"Undervalued at {pe_ratio:.1f}x P/E vs peers"
    elif vs_peers == "overvalued":
        return f"Overvalued at {pe_ratio:.1f}x P/E vs peers"
    else:
        return f"Fair valuation at {pe_ratio:.1f}x P/E"


def _fundamental_to_recommendation(health_score: float, metrics: Dict) -> str:
    """Convert fundamental health score to recommendation."""
    if health_score > 0.7:
        return "buy"
    elif health_score > 0.4:
        return "hold"
    else:
        return "reduce"


def _sentiment_to_recommendation(sentiment_score: float) -> str:
    """Convert sentiment score to recommendation."""
    if sentiment_score > 0.3:
        return "buy"
    elif sentiment_score > -0.3:
        return "hold"
    else:
        return "reduce"


def _valuation_to_recommendation(metrics: Dict[str, float], peer_comparison: Dict[str, Any]) -> str:
    """Convert valuation metrics to recommendation."""
    vs_peers = peer_comparison.get("vs_peer_avg", "in_line")

    if vs_peers == "undervalued":
        return "buy"
    elif vs_peers == "overvalued":
        return "reduce"
    else:
        return "hold"


def _calculate_sentiment_confidence(articles: List[Dict], sentiment_score: float) -> float:
    """Calculate confidence based on article count and score consistency."""
    if len(articles) < 5:
        return 0.5  # Low confidence with few articles

    # Higher confidence with more articles and extreme scores
    base_confidence = min(len(articles) / 20, 0.8)
    score_boost = abs(sentiment_score) * 0.2

    return min(base_confidence + score_boost, 1.0)


def _calculate_valuation_confidence(
    metrics: Dict[str, float], peer_comparison: Dict[str, Any]
) -> float:
    """Calculate confidence based on data completeness."""
    # More complete data = higher confidence
    metric_count = sum(1 for v in metrics.values() if v is not None and v > 0)
    total_possible = 6  # PE, PB, PS, dividend_yield, etc.

    return min(metric_count / total_possible, 1.0)


def _compare_to_peers(metrics: Dict[str, float], peer_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compare valuation metrics to peer average."""
    if not peer_data:
        return {"vs_peer_avg": "in_line", "peer_count": 0}

    # Calculate peer average P/E
    peer_pes = [p.get("pe_ratio", 0) for p in peer_data if p.get("pe_ratio")]
    if not peer_pes:
        return {"vs_peer_avg": "in_line", "peer_count": len(peer_data)}

    peer_avg_pe = sum(peer_pes) / len(peer_pes)
    company_pe = metrics.get("pe_ratio", 0)

    # Determine if undervalued/overvalued
    if company_pe < peer_avg_pe * 0.8:
        vs_peer = "undervalued"
    elif company_pe > peer_avg_pe * 1.2:
        vs_peer = "overvalued"
    else:
        vs_peer = "in_line"

    return {
        "vs_peer_avg": vs_peer,
        "peer_avg_pe": peer_avg_pe,
        "company_pe": company_pe,
        "peer_count": len(peer_data),
    }
