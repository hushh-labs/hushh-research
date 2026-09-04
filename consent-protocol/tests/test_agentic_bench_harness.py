"""Tests for the metadata-only synthetic One benchmark matrix."""

from __future__ import annotations

from hushh_mcp.agents.realtime_bench.agentic_harness import (
    SyntheticReadOnlyAgentBenchPath,
    default_agent_bench_matrix,
    run_agent_benchmark,
)


def test_matrix_covers_individual_same_and_cross_specialist_lanes() -> None:
    matrix = default_agent_bench_matrix()
    assert {case.chain for case in matrix} == {
        "individual",
        "same_specialist",
        "cross_specialist",
    }
    assert {case.surface for case in matrix} == {"chat", "live"}
    assert any(case.expected_outcome == "authority_required" for case in matrix)
    assert any(case.case_id == "nav_connections_authority" for case in matrix)
    assert all("prompt" not in case.__dict__ for case in matrix)


def test_synthetic_report_is_metadata_only_and_includes_p99() -> None:
    report = run_agent_benchmark(SyntheticReadOnlyAgentBenchPath(), runs=3)
    assert report["mode"] == "synthetic_read_only"
    assert report["safety"] == {
        "contains_prompts": False,
        "contains_user_ids": False,
        "contains_credentials": False,
        "contains_protected_payloads": False,
    }
    first = report["results"][0]
    assert first["latency_ms"]["first_meaningful"]["p99"] is not None
