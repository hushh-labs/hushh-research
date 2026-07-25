"""Macro Agent Insight Schemas."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass
class MacroInsight:
    """Structured insight from the Macro Agent."""

    summary: str
    interest_rate_impact: str
    inflation_impact: str
    sector_trend: str
    macro_bull_case: str
    macro_bear_case: str
    confidence: float
    recommendation: str  # buy, hold, reduce
    sources: List[str] = field(default_factory=list)
    vix_value: float | None = None
    tnx_value: float | None = None
    vix_source: str | None = None
    yield_source: str | None = None
    macro_metrics: Dict[str, Any] = field(default_factory=dict)
