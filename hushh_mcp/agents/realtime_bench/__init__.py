"""Realtime-voice benchmark harness.

Phase 4 of the agent-intelligence consolidation: an evidence gate that compares
the current hand-rolled Gemini Live path against an ADK ``run_live`` path before
we adopt ADK for realtime. ADK is the preferred core, but adoption here is
decided by measured metrics, not by assumption.

The harness defines the comparison metrics, a result model, and a runner that
drives a realtime "path" through a scripted set of turns while recording timing
and reliability metrics. Paths are pluggable so the same scenarios run against
either backend; a deterministic in-memory path is provided so the harness is
runnable in CI without network or API keys.
"""

from hushh_mcp.agents.realtime_bench.harness import (
    RealtimeBenchScenario,
    RealtimeBenchTurn,
    RealtimePath,
    run_scenario,
)
from hushh_mcp.agents.realtime_bench.metrics import (
    RealtimeBenchMetrics,
    RealtimeBenchResult,
    summarize_results,
)

__all__ = [
    "RealtimeBenchMetrics",
    "RealtimeBenchResult",
    "summarize_results",
    "RealtimeBenchScenario",
    "RealtimeBenchTurn",
    "RealtimePath",
    "run_scenario",
]
