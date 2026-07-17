# hushh_mcp/operons/kai/__init__.py

"""
Kai Operons

Consent-first, composable business logic for investment analysis.
Each operon is a single-purpose function with explicit TrustLink requirements.

Operons are the building blocks of Agent Kai's analysis pipeline.
"""

import importlib
from typing import Any

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

# Lazily resolved on first access (PEP 562) rather than imported eagerly here.
# Every real caller in this codebase already imports from the specific
# submodule directly (e.g. `from hushh_mcp.operons.kai.analysis import
# analyze_fundamentals`), never from this package root -- so eager imports
# here were pure dead weight for them, while forcing anything that merely
# imports a SIBLING submodule (e.g. `hushh_mcp.operons.kai.calculators`,
# which is pure math with no consent/vault dependency at all) to first
# execute .analysis/.brokerage/.llm/.storage, cascading into the full
# consent/vault stack and its APP_SIGNING_KEY requirement. Confirmed live:
# this broke the standalone-packaged local_analysis_engine, which has no
# .env and needs none of that.
_LAZY_SUBMODULE_BY_NAME = {
    "analyze_fundamentals": "analysis",
    "analyze_sentiment": "analysis",
    "analyze_valuation": "analysis",
    "analyze_stock_with_gemini": "llm",
    "build_brokerage_holdings_context": "brokerage",
    "summarize_brokerage_activity": "brokerage",
    "build_brokerage_freshness_context": "brokerage",
    "prepare_order_intent": "brokerage",
    "calculate_financial_ratios": "calculators",
    "calculate_sentiment_score": "calculators",
    "calculate_valuation_metrics": "calculators",
    "store_decision_card": "storage",
    "retrieve_decision_card": "storage",
    "retrieve_decision_history": "storage",
}


def __getattr__(name: str) -> Any:
    submodule_name = _LAZY_SUBMODULE_BY_NAME.get(name)
    if submodule_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    submodule = importlib.import_module(f".{submodule_name}", __name__)
    return getattr(submodule, name)
