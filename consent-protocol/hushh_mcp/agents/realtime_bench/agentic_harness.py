"""Read-only, metadata-only benchmark harness for One surfaces.

The harness intentionally has no HTTP client, user fixture, prompt field, or
mutation adapter. It gives CI and local development a deterministic benchmark
matrix, while a separately-authorized UAT adapter can later implement the same
``AgentBenchPath`` protocol against real managed Vertex and connector state.
"""

from __future__ import annotations

import hashlib
import statistics
from dataclasses import dataclass
from typing import Literal, Protocol

BenchSurface = Literal["chat", "live"]
BenchChain = Literal["individual", "same_specialist", "cross_specialist"]


@dataclass(frozen=True)
class AgentBenchCase:
    """A scenario identifier and invariants; never contains user input."""

    case_id: str
    lane: str
    surface: BenchSurface
    chain: BenchChain
    required_events: tuple[str, ...]
    expected_outcome: str


@dataclass(frozen=True)
class AgentBenchSample:
    case_id: str
    lane: str
    surface: BenchSurface
    chain: BenchChain
    outcome: str
    event_count: int
    request_open_ms: float | None = None
    first_meaningful_ms: float | None = None
    first_audio_ms: float | None = None
    confirmation_ms: float | None = None
    settlement_ms: float | None = None
    completed_ms: float | None = None
    error_class: str | None = None
    provenance_count: int = 0
    cache_state: Literal["cold", "warm", "deferred", "none"] = "none"


class AgentBenchPath(Protocol):
    """Adapter seam for a synthetic or separately-authorized real rehearsal."""

    name: str

    def run(self, case: AgentBenchCase, *, iteration: int) -> AgentBenchSample:
        """Return metadata-only timings for exactly one scenario invocation."""


def default_agent_bench_matrix() -> tuple[AgentBenchCase, ...]:
    """Coverage matrix for individual and settled-chain agent behavior."""
    return (
        AgentBenchCase(
            "one_chat_grounded",
            "one",
            "chat",
            "individual",
            ("sse_open", "first_token", "grounded_result"),
            "grounded_answer",
        ),
        AgentBenchCase(
            "one_chat_unavailable",
            "one",
            "chat",
            "individual",
            ("sse_open", "availability"),
            "typed_recovery",
        ),
        AgentBenchCase(
            "one_live_interrupt_reconnect",
            "one",
            "live",
            "individual",
            ("live_setup", "first_audio", "interrupt", "reconnect"),
            "recovered",
        ),
        AgentBenchCase(
            "location_setup_required",
            "location",
            "chat",
            "individual",
            ("availability",),
            "setup_required",
        ),
        AgentBenchCase(
            "location_permission_settlement",
            "location",
            "live",
            "same_specialist",
            ("directive", "confirmation", "settlement"),
            "settled",
        ),
        AgentBenchCase(
            "nav_consent_review",
            "nav",
            "chat",
            "individual",
            ("availability", "specialist_start", "specialist_complete"),
            "bounded_consent_review",
        ),
        AgentBenchCase(
            "nav_connections_authority",
            "nav_connections",
            "chat",
            "same_specialist",
            ("specialist_start", "availability", "clarification"),
            "authority_required",
        ),
        AgentBenchCase(
            "nav_scope_recovery",
            "nav",
            "chat",
            "same_specialist",
            ("availability", "clarification"),
            "scope_required",
        ),
        AgentBenchCase(
            "finance_ria_investor",
            "finance",
            "chat",
            "same_specialist",
            ("specialist_start", "grounded_result", "specialist_complete"),
            "bounded_projection",
        ),
        AgentBenchCase(
            "kyc_redraft_review",
            "kyc",
            "chat",
            "same_specialist",
            ("directive", "confirmation", "settlement"),
            "settled",
        ),
        AgentBenchCase(
            "pkm_durable_review",
            "pkm",
            "chat",
            "same_specialist",
            ("pkm_preflight", "confirmation"),
            "confirm_first",
        ),
        AgentBenchCase(
            "pkm_ephemeral_noop",
            "pkm",
            "chat",
            "same_specialist",
            ("pkm_preflight",),
            "do_not_save",
        ),
        AgentBenchCase(
            "one_finance_route_chain",
            "one_finance",
            "chat",
            "cross_specialist",
            ("specialist_start", "directive", "confirmation", "route_context", "settlement"),
            "settled",
        ),
        AgentBenchCase(
            "connector_exact_authority",
            "connected_systems",
            "live",
            "cross_specialist",
            ("availability",),
            "authority_required",
        ),
    )


class SyntheticReadOnlyAgentBenchPath:
    """Deterministic CI path; values are fixture timings, never product evidence."""

    name = "synthetic_read_only"

    def run(self, case: AgentBenchCase, *, iteration: int) -> AgentBenchSample:
        digest = hashlib.sha256(f"{case.case_id}:{iteration}".encode()).digest()
        jitter = digest[0] % 21
        live = case.surface == "live"
        first_meaningful = float(180 + jitter + (55 if case.chain != "individual" else 0))
        first_audio = (
            float(220 + jitter + (60 if case.chain != "individual" else 0)) if live else None
        )
        confirmation = (
            float(90 + (digest[1] % 15)) if "confirmation" in case.required_events else None
        )
        settlement = float(160 + (digest[2] % 25)) if "settlement" in case.required_events else None
        completed = first_meaningful + (settlement or 120.0) + (80.0 if live else 0.0)
        return AgentBenchSample(
            case_id=case.case_id,
            lane=case.lane,
            surface=case.surface,
            chain=case.chain,
            outcome=case.expected_outcome,
            event_count=len(case.required_events),
            request_open_ms=float(30 + digest[3] % 9),
            first_meaningful_ms=first_meaningful,
            first_audio_ms=first_audio,
            confirmation_ms=confirmation,
            settlement_ms=settlement,
            completed_ms=completed,
            provenance_count=1 if "grounded_result" in case.required_events else 0,
            cache_state="warm" if "pkm" in case.lane or "finance" in case.lane else "none",
        )


def _percentiles(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"p50": None, "p95": None, "p99": None}
    ordered = sorted(values)

    def percentile(value: float) -> float:
        return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * value))]

    return {
        "p50": statistics.median(ordered),
        "p95": percentile(0.95),
        "p99": percentile(0.99),
    }


def summarize_agent_bench(samples: list[AgentBenchSample]) -> dict[str, object]:
    """Aggregate without retaining prompt, identity, authority, or payload data."""
    by_case: dict[str, list[AgentBenchSample]] = {}
    for sample in samples:
        by_case.setdefault(sample.case_id, []).append(sample)

    results: list[dict[str, object]] = []
    for case_id, case_samples in sorted(by_case.items()):
        exemplar = case_samples[0]
        results.append(
            {
                "case_id": case_id,
                "lane": exemplar.lane,
                "surface": exemplar.surface,
                "chain": exemplar.chain,
                "runs": len(case_samples),
                "outcomes": sorted({sample.outcome for sample in case_samples}),
                "event_count": max(sample.event_count for sample in case_samples),
                "latency_ms": {
                    "request_open": _percentiles(
                        [
                            sample.request_open_ms
                            for sample in case_samples
                            if sample.request_open_ms is not None
                        ]
                    ),
                    "first_meaningful": _percentiles(
                        [
                            sample.first_meaningful_ms
                            for sample in case_samples
                            if sample.first_meaningful_ms is not None
                        ]
                    ),
                    "first_audio": _percentiles(
                        [
                            sample.first_audio_ms
                            for sample in case_samples
                            if sample.first_audio_ms is not None
                        ]
                    ),
                    "confirmation": _percentiles(
                        [
                            sample.confirmation_ms
                            for sample in case_samples
                            if sample.confirmation_ms is not None
                        ]
                    ),
                    "settlement": _percentiles(
                        [
                            sample.settlement_ms
                            for sample in case_samples
                            if sample.settlement_ms is not None
                        ]
                    ),
                    "completed": _percentiles(
                        [
                            sample.completed_ms
                            for sample in case_samples
                            if sample.completed_ms is not None
                        ]
                    ),
                },
                "provenance_count": max(sample.provenance_count for sample in case_samples),
                "cache_states": sorted({sample.cache_state for sample in case_samples}),
                "error_classes": sorted(
                    {sample.error_class for sample in case_samples if sample.error_class}
                ),
            }
        )
    return {
        "schema_version": "agent_benchmark.v1",
        "mode": "synthetic_read_only",
        "results": results,
        "safety": {
            "contains_prompts": False,
            "contains_user_ids": False,
            "contains_credentials": False,
            "contains_protected_payloads": False,
        },
    }


def run_agent_benchmark(
    path: AgentBenchPath,
    *,
    cases: tuple[AgentBenchCase, ...] | None = None,
    runs: int = 30,
) -> dict[str, object]:
    if runs < 1:
        raise ValueError("runs must be at least one")
    samples = [
        path.run(case, iteration=iteration)
        for case in (cases or default_agent_bench_matrix())
        for iteration in range(runs)
    ]
    report = summarize_agent_bench(samples)
    report["path"] = path.name
    report["runs_per_case"] = runs
    return report
