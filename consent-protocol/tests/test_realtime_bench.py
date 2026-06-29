"""Tests for the realtime-voice benchmark harness (Phase 4 evidence gate).

These validate the harness mechanics and the comparison/recommendation logic
deterministically, using the in-memory paths (no network / API keys).
"""

from __future__ import annotations

from hushh_mcp.agents.realtime_bench.harness import (
    InMemoryRealtimePath,
    default_scenarios,
    run_scenario,
)
from hushh_mcp.agents.realtime_bench.metrics import (
    RealtimeBenchMetrics,
    RealtimeBenchResult,
    summarize_results,
)


def test_run_scenario_records_turns_and_connect():
    path = InMemoryRealtimePath("p", base_first_audio_ms=400.0, base_turn_ms=1500.0)
    scenario = default_scenarios()[0]  # short_qa, 2 turns
    result = run_scenario(path, scenario)
    assert result.turns == 2
    assert result.errors == 0
    # Connect cost attached once on the first turn.
    assert result.connect_ms == [20.0]
    assert result.first_audio_ms == [400.0, 400.0]


def test_error_rate_and_aggregation():
    result = RealtimeBenchResult(path_name="p", scenario_name="s")
    result.record(RealtimeBenchMetrics(first_audio_ms=100.0, turn_ms=500.0, ok=True))
    result.record(RealtimeBenchMetrics(ok=False, error="TransportError"))
    assert result.turns == 2
    assert result.errors == 1
    assert result.error_rate == 0.5
    agg = result._agg(result.first_audio_ms)
    assert agg["p50"] == 100.0


def test_summary_prefers_faster_path():
    current = run_scenario(
        InMemoryRealtimePath("current", base_first_audio_ms=420.0, base_turn_ms=1600.0),
        default_scenarios()[0],
    )
    adk = run_scenario(
        InMemoryRealtimePath("adk", base_first_audio_ms=360.0, base_turn_ms=1500.0),
        default_scenarios()[0],
    )
    summary = summarize_results([current, adk])
    rec = summary["recommendation"]
    assert rec["decision"] == "prefer"
    assert rec["winner"] == "adk"


def test_summary_keeps_current_when_win_is_marginal():
    current = run_scenario(
        InMemoryRealtimePath("current", base_first_audio_ms=400.0, base_turn_ms=1500.0),
        default_scenarios()[0],
    )
    adk = run_scenario(
        InMemoryRealtimePath("adk", base_first_audio_ms=395.0, base_turn_ms=1490.0),
        default_scenarios()[0],
    )
    summary = summarize_results([current, adk])
    assert summary["recommendation"]["decision"] == "keep_current"


def test_summary_insufficient_data_with_single_path():
    only = run_scenario(
        InMemoryRealtimePath("only", base_first_audio_ms=400.0, base_turn_ms=1500.0),
        default_scenarios()[0],
    )
    summary = summarize_results([only])
    assert summary["recommendation"]["decision"] == "insufficient_data"
