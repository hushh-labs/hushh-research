#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]


def _git_branch() -> str:
    result = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return (result.stdout or "").strip() or "detached-head"


def _run(
    command: list[str],
    *,
    stream_output: bool,
) -> dict[str, Any]:
    if stream_output:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            text=True,
            check=False,
        )
        return {
            "command": command,
            "returncode": result.returncode,
            "ok": result.returncode == 0,
            "stdout_tail": "",
            "stderr_tail": "",
        }

    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "command": command,
        "returncode": result.returncode,
        "ok": result.returncode == 0,
        "stdout_tail": result.stdout[-4000:],
        "stderr_tail": result.stderr[-4000:],
    }


def _render_text(payload: dict[str, Any]) -> str:
    lines = [
        f"Workflow: {payload['workflow_id']}",
        f"Status: {payload['status']}",
        f"Branch: {payload['branch']}",
        f"Mirrors GitHub: {', '.join(payload['mirrors_workflows'])}",
        f"Include advisory: {payload['include_advisory']}",
        "Commands:",
    ]
    for command in payload["commands"]:
        lines.append(f"- {command}")
    if payload.get("next_actions"):
        lines.append("Next actions:")
        for item in payload["next_actions"]:
            lines.append(f"- {item}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the local CI surface that mirrors the GitHub PR gate before opening or updating a pull request."
    )
    parser.add_argument("--include-advisory", action="store_true", help="Include the advisory CI lane after the blocking gate.")
    parser.add_argument("--report-path", help="Optional path for a machine-readable report.")
    parser.add_argument("--json", action="store_true", help="Emit JSON output.")
    parser.add_argument("--text", action="store_true", help="Emit text output (default).")
    args = parser.parse_args()

    json_mode = bool(args.json)
    ci_command = ["./bin/hushh", "ci"]
    if args.include_advisory:
        ci_command.append("--include-advisory")

    if not json_mode:
        print("Running the local PR mirror before opening or updating a pull request.")
        print(f"Command: {' '.join(ci_command)}")

    result = _run(ci_command, stream_output=not json_mode)
    payload: OrderedDict[str, Any] = OrderedDict(
        workflow_id="pre-pr-readiness",
        status="passing" if result["ok"] else "failing",
        branch=_git_branch(),
        mirrors_workflows=["PR Validation", "CI Status Gate"],
        include_advisory=args.include_advisory,
        commands=[" ".join(ci_command)],
        reports=OrderedDict(),
        command_result=OrderedDict(
            returncode=result["returncode"],
            stdout_tail=result["stdout_tail"],
            stderr_tail=result["stderr_tail"],
        ),
        next_actions=[
            "Open or update the pull request once the local mirror is green."
            if result["ok"]
            else "Fix the failing local check before opening or updating the pull request.",
            "Use ./bin/hushh codex ci-status --watch after the PR opens so GitHub reaches a terminal state.",
        ],
    )

    if args.report_path:
        report_path = Path(args.report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        payload["reports"]["report_path"] = str(report_path)

    if json_mode:
        print(json.dumps(payload, indent=2))
    else:
        print(_render_text(payload))

    return int(result["returncode"])


if __name__ == "__main__":
    raise SystemExit(main())
