from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class EvalGateResult:
    gate_name: str
    passed: bool
    threshold: float
    actual: float
    note: str = ""


@dataclass
class EvalKPIBundle:
    accuracy_delta: float
    safety_regression: float
    latency_delta_ms: float
    finance_contamination_delta: float = 0.0


@dataclass
class EvalCase:
    case_id: str
    expected_decision: str
    observed_decision: str
    expected_confidence_min: float = 0.0
    observed_confidence: float = 0.0
    score: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvalRun:
    run_id: str
    surface: str
    status: str
    model_version: str
    prompt_set_version: str
    created_at: datetime
    kpis: EvalKPIBundle
    cases: list[EvalCase] = field(default_factory=list)
    gate_results: list[EvalGateResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PromotionDecision:
    run_id: str
    approved: bool
    approved_by: str
    reason: str
    created_at: datetime = field(default_factory=_utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RollbackRecord:
    from_version: str
    to_version: str
    reason: str
    triggered_by: str
    created_at: datetime = field(default_factory=_utc_now)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
