#!/usr/bin/env python3
"""A/B the consent family of the first-tool harness across two instructions.

Usage:
    GENAI_GOOGLE_CLOUD_PROJECT=<project> GOOGLE_GENAI_USE_VERTEXAI=true \\
      PYTHONPATH=. python scripts/eval_one_consent_tool_selection.py <instruction_a.txt> <instruction_b.txt>
    AB_MODEL=gemini-3.7-flash ... to run against another model pin.

This is a thin wrapper over scripts/eval_one_first_tool.py, which now owns
the roster, the case fixture (scripts/eval_cases/one_first_tool.v1.json,
family "consent" carries the original 13 questions verbatim), scoring, and
the report. Both instruction files run back to back against the consent
family and each writes its own report under artifacts/.

Why the consent family exists: the founder's own sentence, "can we request
finance information from Sharu Khan", was routed by the private agent's
previous instruction to `list_my_connections`, a dead end, because that
instruction never named `discover_person_information`. Only a live call
measures tool selection. Expect run-to-run variance even at temperature 0,
and expect 429s from Vertex on back-to-back runs (the harness retries them).

Measured 2026-09-13 with the previous script over the 13 questions, four runs
each on two models: previous instruction 47/52, revised 52/52. Those runs sent
every declaration without parameters (the old script forwarded a field ADK
leaves empty under postponed annotations), so re-measure through this wrapper
before quoting the figure again.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from scripts import eval_one_first_tool as harness  # noqa: E402

FAMILIES = ("consent",)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("instruction_a", help="Instruction text file for arm A (CURRENT).")
    parser.add_argument("instruction_b", help="Instruction text file for arm B (REVISED).")
    parser.add_argument(
        "--reps",
        type=int,
        default=harness.DEFAULT_REPS,
        help="Repetitions per case; a case counts only when every rep hits.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("AB_MODEL", "").strip() or harness.DEFAULT_MODEL,
        help="Model pin; AB_MODEL in the environment is honoured for the old contract.",
    )
    parser.add_argument("--thinking-level", choices=harness.THINKING_LEVELS, default=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    return harness.run_eval(
        families=list(FAMILIES),
        instruction_files=[args.instruction_a, args.instruction_b],
        model=args.model,
        reps=args.reps,
        thinking_level=args.thinking_level,
    )


if __name__ == "__main__":
    sys.exit(main())
