"""CLI entry point for the realtime-voice benchmark.

By default this runs the deterministic in-memory paths so it is safe in CI and
local dev without API keys. The numbers it prints with the defaults are
illustrative profiles, not real measurements; wire real network-backed paths
(current vs ADK) to produce the evidence that decides ADK adoption.

Usage:
    python -m hushh_mcp.agents.realtime_bench.run_bench
    python -m hushh_mcp.agents.realtime_bench.run_bench --json
"""

from __future__ import annotations

import argparse
import json

from hushh_mcp.agents.realtime_bench.harness import (
    InMemoryRealtimePath,
    default_scenarios,
    run_scenario,
)
from hushh_mcp.agents.realtime_bench.metrics import summarize_results


def _build_default_paths() -> list[InMemoryRealtimePath]:
    # Two illustrative profiles standing in for the real backends. Replace with
    # network-backed paths for a real comparison run.
    return [
        InMemoryRealtimePath("current_gemini_live", base_first_audio_ms=420.0, base_turn_ms=1600.0),
        InMemoryRealtimePath("adk_run_live", base_first_audio_ms=360.0, base_turn_ms=1500.0),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Realtime voice benchmark")
    parser.add_argument("--json", action="store_true", help="Emit JSON only")
    args = parser.parse_args()

    paths = _build_default_paths()
    scenarios = default_scenarios()

    results = []
    for path in paths:
        for scenario in scenarios:
            results.append(run_scenario(path, scenario))

    summary = summarize_results(results)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for path_result in summary["paths"]:
            print(
                f"{path_result['path']:>20} | {path_result['scenario']:<12} "
                f"first_audio_p95={path_result['first_audio_ms']['p95']} "
                f"turn_p95={path_result['turn_ms']['p95']} "
                f"err={path_result['error_rate']}"
            )
        print()
        print("recommendation:", json.dumps(summary["recommendation"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
