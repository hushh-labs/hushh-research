"""CLI entrypoint for #9370 Phase 0 Personal Wiki Memory baseline evaluation."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from hushh_eval.wiki_memory.baseline import evaluate_phase0_baseline
from hushh_eval.wiki_memory.conformance import (
    evaluate_external_ai_archive_import,
    evaluate_four_placement_conformance,
    evaluate_live_agent_turn_e2e,
    evaluate_live_wiki_pipeline,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the sanitized #9370 Personal Wiki Memory evaluation harness."
    )
    parser.add_argument(
        "--suite",
        choices=("phase0", "all"),
        default="phase0",
        help="Run the Phase 0 baseline only (default) or the full end-to-end harness ('all').",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional ignored local path for JSON report (never commit generated JSON).",
    )
    args = parser.parse_args(argv)
    if args.suite == "all":
        report = asyncio.run(_run_all_suites())
    else:
        report = evaluate_phase0_baseline()
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


async def _run_all_suites() -> dict[str, object]:
    return {
        "phase0_baseline": evaluate_phase0_baseline(),
        "four_placement_conformance": await evaluate_four_placement_conformance(),
        "live_pipeline_comparison": await evaluate_live_wiki_pipeline(),
        "live_agent_turn_e2e": await evaluate_live_agent_turn_e2e(),
        "external_ai_archive_import": await evaluate_external_ai_archive_import(),
    }


if __name__ == "__main__":
    raise SystemExit(main())
