"""Public Kai operon exports without eager provider initialization.

The package keeps its historical import surface while loading each operon only
when that symbol is requested. Pure calculator consumers therefore do not pay
for network, storage, or model dependencies at import time.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

_EXPORT_MODULES = {
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

__all__ = list(_EXPORT_MODULES)


def __getattr__(name: str) -> Any:
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module_name}"), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))


if TYPE_CHECKING:
    from .analysis import analyze_fundamentals, analyze_sentiment, analyze_valuation
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
