#!/usr/bin/env python3
"""Verify that routed workflows expose the reads, checks, and delegation they promise."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
CASES = REPO_ROOT / ".codex/evals/workflow-contracts.json"
ROUTER = REPO_ROOT / ".codex/skills/repo-context/scripts/repo_scan.py"


def route(workflow: str) -> dict:
    result = subprocess.run([sys.executable, str(ROUTER), "route-task", workflow, "--json"], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return json.loads(result.stdout)["data"]


def main() -> int:
    failures = []
    for case in json.loads(CASES.read_text(encoding="utf-8"))["scenarios"]:
        payload = route(case["workflow"])
        for read in case["required_reads"]:
            if read not in payload["exact_docs_to_open"]:
                failures.append(f"{case['id']}: missing required read {read}")
        for command in case["required_commands"]:
            if command not in payload["exact_commands_to_run"]:
                failures.append(f"{case['id']}: missing required command {command}")
        if case["must_delegate"] and not payload["delegation_policy"]["should_delegate"]:
            failures.append(f"{case['id']}: expected read-only evidence delegation")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"Workflow contract evals passed ({len(json.loads(CASES.read_text(encoding='utf-8'))['scenarios'])} scenarios).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
