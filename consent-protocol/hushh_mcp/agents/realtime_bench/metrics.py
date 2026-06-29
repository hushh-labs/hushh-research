"""Metric definitions and result models for the realtime-voice benchmark.

These are the dimensions used to decide whether ADK ``run_live`` should replace
the current hand-rolled Gemini Live path. All durations are in milliseconds.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RealtimeBenchMetrics:
    """Per-turn metrics captured while driving a realtime path."""

    # Time from session start request to the socket being ready to stream.
    connect_ms: Optional[float] = None
    # Time from the user finishing speaking to the first audio chunk back.
    first_audio_ms: Optional[float] = None
    # Total wall-clock for a full turn (user utterance -> reply complete).
    turn_ms: Optional[float] = None
    # Time for a barge-in (user interrupts) to take effect.
    barge_in_ms: Optional[float] = None
    # Time to recover after a transport drop (reconnect / resume).
    reconnect_ms: Optional[float] = None
    # Whether the turn completed without an error.
    ok: bool = True
    # Optional error class name when ok is False.
    error: Optional[str] = None


@dataclass
class RealtimeBenchResult:
    """Aggregated result for one path over one scenario run."""

    path_name: str
    scenario_name: str
    turns: int = 0
    errors: int = 0
    connect_ms: list[float] = field(default_factory=list)
    first_audio_ms: list[float] = field(default_factory=list)
    turn_ms: list[float] = field(default_factory=list)
    barge_in_ms: list[float] = field(default_factory=list)
    reconnect_ms: list[float] = field(default_factory=list)

    def record(self, metrics: RealtimeBenchMetrics) -> None:
        self.turns += 1
        if not metrics.ok:
            self.errors += 1
        if metrics.connect_ms is not None:
            self.connect_ms.append(metrics.connect_ms)
        if metrics.first_audio_ms is not None:
            self.first_audio_ms.append(metrics.first_audio_ms)
        if metrics.turn_ms is not None:
            self.turn_ms.append(metrics.turn_ms)
        if metrics.barge_in_ms is not None:
            self.barge_in_ms.append(metrics.barge_in_ms)
        if metrics.reconnect_ms is not None:
            self.reconnect_ms.append(metrics.reconnect_ms)

    @property
    def error_rate(self) -> float:
        return self.errors / self.turns if self.turns else 0.0

    def _agg(self, samples: list[float]) -> dict[str, Optional[float]]:
        if not samples:
            return {"p50": None, "p95": None, "mean": None}
        ordered = sorted(samples)
        return {
            "p50": statistics.median(ordered),
            "p95": ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))],
            "mean": statistics.fmean(ordered),
        }

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path_name,
            "scenario": self.scenario_name,
            "turns": self.turns,
            "errors": self.errors,
            "error_rate": round(self.error_rate, 4),
            "connect_ms": self._agg(self.connect_ms),
            "first_audio_ms": self._agg(self.first_audio_ms),
            "turn_ms": self._agg(self.turn_ms),
            "barge_in_ms": self._agg(self.barge_in_ms),
            "reconnect_ms": self._agg(self.reconnect_ms),
        }


def summarize_results(results: list[RealtimeBenchResult]) -> dict[str, object]:
    """Build a comparison summary and a (heuristic) recommendation.

    The recommendation only fires when there are at least two paths to compare
    and one path wins on the latency-sensitive metric (first_audio p95) without
    a worse error rate. It is advisory: the decision to adopt ADK stays with a
    human reviewing the full numbers.
    """
    by_path = [r.as_dict() for r in results]
    recommendation: dict[str, object] = {"decision": "insufficient_data"}

    # Aggregate per path across all scenarios so the comparison is path-vs-path,
    # not scenario-vs-scenario.
    merged: dict[str, RealtimeBenchResult] = {}
    for r in results:
        bucket = merged.get(r.path_name)
        if bucket is None:
            bucket = RealtimeBenchResult(path_name=r.path_name, scenario_name="*")
            merged[r.path_name] = bucket
        bucket.turns += r.turns
        bucket.errors += r.errors
        bucket.first_audio_ms.extend(r.first_audio_ms)
        bucket.turn_ms.extend(r.turn_ms)
        bucket.barge_in_ms.extend(r.barge_in_ms)
        bucket.reconnect_ms.extend(r.reconnect_ms)
        bucket.connect_ms.extend(r.connect_ms)

    if len(merged) >= 2:
        scored = []
        for r in merged.values():
            agg = r._agg(r.first_audio_ms)
            p95 = agg["p95"]
            if p95 is not None:
                scored.append((r.path_name, p95, r.error_rate))
        if len(scored) >= 2:
            scored.sort(key=lambda x: (x[1], x[2]))
            best, best_p95, best_err = scored[0]
            runner_up, ru_p95, ru_err = scored[1]
            # Require a meaningful (>=10%) first-audio improvement and no worse
            # error rate to recommend switching.
            improvement = (ru_p95 - best_p95) / ru_p95 if ru_p95 else 0.0
            if improvement >= 0.10 and best_err <= ru_err:
                recommendation = {
                    "decision": "prefer",
                    "winner": best,
                    "first_audio_p95_improvement": round(improvement, 4),
                    "loser": runner_up,
                }
            else:
                recommendation = {
                    "decision": "keep_current",
                    "reason": "no meaningful first-audio win or worse error rate",
                }

    return {"paths": by_path, "recommendation": recommendation}
