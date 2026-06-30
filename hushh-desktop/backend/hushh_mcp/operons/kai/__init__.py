# hushh_mcp/operons/kai/__init__.py

"""
Kai Operons

Consent-first, composable business logic for investment analysis.
Each operon is a single-purpose function with explicit TrustLink requirements.

Operons are the building blocks of Agent Kai's analysis pipeline.
"""

from .analysis import (
    analyze_fundamentals,
    analyze_sentiment,
    analyze_valuation,
)
from .brokerage import (
    build_brokerage_freshness_context,
    build_brokerage_holdings_context,
    prepare_order_intent,
    summarize_brokerage_activity,
)
from .calculators import (
    calculate_financial_ratios,
    calculate_sentiment_score,
    calculate_valuation_metrics,
)
from .llm import analyze_stock_with_gemini
from .storage import (
    retrieve_decision_card,
    retrieve_decision_history,
    store_decision_card,
)

__all__ = [
    # Analysis operons
    "analyze_fundamentals",
    "analyze_sentiment",
    "analyze_valuation",
    "analyze_stock_with_gemini",
    # Brokerage operons
    "build_brokerage_holdings_context",
    "summarize_brokerage_activity",
    "build_brokerage_freshness_context",
    "prepare_order_intent",
    # Calculator operons
    "calculate_financial_ratios",
    "calculate_sentiment_score",
    "calculate_valuation_metrics",
    # Storage operons
    "store_decision_card",
    "retrieve_decision_card",
    "retrieve_decision_history",
]
