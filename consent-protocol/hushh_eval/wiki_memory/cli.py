"""CLI entrypoint for #9370 Phase 0 Personal Wiki Memory baseline evaluation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from hushh_eval.wiki_memory.baseline import evaluate_phase0_baseline


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the sanitized #9370 Phase 0 Personal Wiki Memory evaluation baseline."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional ignored local path for JSON report (never commit generated JSON).",
    )
    args = parser.parse_args(argv)
    report = evaluate_phase0_baseline()
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
