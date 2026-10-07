#!/usr/bin/env python3
"""Measure the canonical One Voice workload without a provider call.

Fixed screen, owner and clock inputs isolate authored payload growth from
calendar changes. This is not a ceiling for every live owner/session context;
production continues to use its actual clock.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "consent-protocol"))

from hushh_mcp.one_voice.instruction import build_instruction  # noqa: E402
from hushh_mcp.one_voice.tools import registry  # noqa: E402
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS  # noqa: E402

BUDGET_PATH = (
    REPO_ROOT
    / "consent-protocol"
    / "contracts"
    / "one_voice_performance_budget.v1.json"
)
BENCHMARK_NOW = datetime(2026, 10, 5, 14, 6, 55, tzinfo=timezone.utc)


def measure() -> dict[str, int]:
    declarations = registry.declarations()
    instruction = build_instruction(
        tool_declarations=declarations,
        screen_ids=list(OPENABLE_SCREENS),
        screen_id="one_home",
        display_name=None,
        now=BENCHMARK_NOW,
    )
    schema = json.dumps(declarations, ensure_ascii=False, separators=(",", ":"))
    return {
        "instruction_chars": len(instruction),
        "instruction_utf8_bytes": len(instruction.encode("utf-8")),
        "tool_count": len(declarations),
        "tool_schema_json_bytes": len(schema.encode("utf-8")),
        "tool_description_chars": sum(
            len(str(item.get("description") or "")) for item in declarations
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="fail if an approved cap is exceeded"
    )
    args = parser.parse_args()
    values = measure()
    print(json.dumps(values, sort_keys=True))
    if not args.check:
        return 0
    caps = json.loads(BUDGET_PATH.read_text(encoding="utf-8"))
    exceeded = [
        f"{name}: {values[name]} > {limit}"
        for name, limit in caps.items()
        if name in values and (not isinstance(limit, int) or values[name] > limit)
    ]
    if exceeded:
        print(
            "One Voice performance budget exceeded: " + "; ".join(exceeded),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
