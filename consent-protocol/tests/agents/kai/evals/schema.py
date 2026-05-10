# tests/agents/kai/evals/schema.py
"""
Canonical shapes for scenarios, agent outputs, and eval reports.

These are the contract between the YAML scenario files, the runner,
and the metrics module. Tests assert that real runs match these shapes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional


Recommendation = Literal["BUY", "HOLD", "SELL", "STRONG_BUY", "STRONG_SELL"]
Category = Literal["bull", "bear", "ambiguous", "edge"]


@dataclass(frozen=True)
class Scenario:
    """A single golden scenario."""

    id: str
    category: Category
    ticker: str
    description: str
    sec_data: dict[str, Any]
    market_data: dict[str, Any]
    sentiment_data: list[dict[str, Any]]
    user_context: dict[str, Any]
    expected_recommendation: Recommendation
    expected_confidence_band: tuple[float, float]  # inclusive lower/upper
    notes: str = ""

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Scenario":
        band = raw.get("expected_confidence_band", [0.0, 1.0])
        return cls(
            id=str(raw["id"]),
            category=raw["category"],
            ticker=str(raw["ticker"]).upper(),
            description=str(raw.get("description", "")),
            sec_data=dict(raw.get("sec_data") or {}),
            market_data=dict(raw.get("market_data") or {}),
            sentiment_data=list(raw.get("sentiment_data") or []),
            user_context=dict(raw.get("user_context") or {}),
            expected_recommendation=raw["expected_recommendation"],
            expected_confidence_band=(float(band[0]), float(band[1])),
            notes=str(raw.get("notes", "")),
        )


@dataclass(frozen=True)
class AgentOutput:
    """Output captured from one specialist agent."""

    agent: Literal["fundamental", "sentiment", "valuation", "renaissance"]
    score: Optional[float] = None  # -1.0 .. 1.0 normalized
    classification: Optional[str] = None  # e.g. "Bullish" / "Bearish" / "Neutral"
    reasoning: str = ""
    citations: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DebateOutput:
    """Captured output of a single eval run."""

    scenario_id: str
    provider: str
    model: str
    fundamental: AgentOutput
    sentiment: AgentOutput
    valuation: AgentOutput
    renaissance: Optional[AgentOutput]
    recommendation: Recommendation
    confidence: float  # 0.0 .. 1.0
    rationale: str
    latency_ms_per_agent: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class MetricResult:
    """Result of one metric for one scenario or aggregate."""

    name: str
    value: float
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EvalReport:
    """Aggregate report for an eval run."""

    provider: str
    model: str
    n_scenarios: int
    metrics: list[MetricResult]
    per_scenario: dict[str, list[MetricResult]] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "n_scenarios": self.n_scenarios,
            "metrics": [
                {"name": m.name, "value": m.value, "detail": m.detail} for m in self.metrics
            ],
            "per_scenario": {
                sid: [{"name": m.name, "value": m.value, "detail": m.detail} for m in ms]
                for sid, ms in self.per_scenario.items()
            },
        }
