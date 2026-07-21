"""Run the safe synthetic One benchmark matrix.

Writes nothing unless ``--output`` points at an explicitly chosen ignored path.
Real model, vault, or integration rehearsal is intentionally not available from
this command; it requires an authorized UAT adapter.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from hushh_mcp.agents.realtime_bench.agentic_harness import (
    SyntheticReadOnlyAgentBenchPath,
    run_agent_benchmark,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only synthetic One benchmark")
    parser.add_argument("--runs", type=int, default=30, help="Runs per matrix case")
    parser.add_argument("--output", type=Path, help="Optional explicit report path")
    args = parser.parse_args()
    report = run_agent_benchmark(SyntheticReadOnlyAgentBenchPath(), runs=args.runs)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
