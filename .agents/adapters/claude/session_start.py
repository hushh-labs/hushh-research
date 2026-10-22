#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Deliver the canonical repository entrypoint through Claude's SessionStart hook."""
from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import sys

SOURCE_ROOT = Path(__file__).resolve().parents[3]
load_operating_contract = runpy.run_path(
    str(SOURCE_ROOT / "scripts/ops/audit_agents_md_alignment.py")
)["load_operating_contract"]


def startup_context(root: Path) -> dict:
    root = root.resolve()
    load_operating_contract(root)
    entrypoint = (root / "AGENTS.md").read_text(encoding="utf-8")
    source = root / ".agents/instructions.md"
    context = f"{entrypoint}\nRead the complete canonical operating contract at {source} before acting.\n"
    if len(context) > 9_000:
        raise ValueError("Repository entrypoint exceeds the startup context budget")
    return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}


def main() -> int:
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR", str(SOURCE_ROOT)))
    try:
        output = startup_context(root)
    except (OSError, ValueError):
        print("Canonical agent instructions could not be loaded; inspect AGENTS.md before acting.", file=sys.stderr)
        return 1
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
