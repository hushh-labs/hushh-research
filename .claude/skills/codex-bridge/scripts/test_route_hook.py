#!/usr/bin/env python3
"""Regression test for route.py --hook mode (UserPromptSubmit contract).

Run:
    python3 .claude/skills/codex-bridge/scripts/test_route_hook.py

The hook contract:
  - Never block the turn: exit code must be 0 on every path, including malformed stdin.
  - Silent on weak matches: empty stdout for chitchat, short prompts, missing fields.
  - Wrapped briefing on strong matches: exact name or free-text score above gate.
  - Q&A rules header prepended when the prompt has a QA_MARKERS hit.
  - Env kill-switch: CODEX_BRIDGE_DISABLE=1 forces silence.

Exits non-zero if any assertion fails so CI can depend on it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "route.py"


def run_hook(payload: str, env: dict | None = None) -> tuple[str, int]:
    proc = subprocess.run(
        ["python3", str(SCRIPT), "--hook"],
        input=payload,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        timeout=20,
    )
    return proc.stdout, proc.returncode


def payload(prompt: str) -> str:
    return json.dumps({
        "session_id": "test",
        "cwd": str(Path.cwd()),
        "hook_event_name": "UserPromptSubmit",
        "prompt": prompt,
    })


FAILED: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  pass  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


def main() -> int:
    print("=== codex-bridge route.py --hook regression ===")

    out, code = run_hook("")
    check("empty stdin is silent and exit 0", out.strip() == "" and code == 0, f"code={code} out={out!r}")

    out, code = run_hook("not json at all")
    check("malformed stdin is silent and exit 0", out.strip() == "" and code == 0, f"code={code} out={out!r}")

    out, code = run_hook(json.dumps(["a", "b"]))
    check("non-dict json stdin is silent", out.strip() == "" and code == 0)

    out, code = run_hook(json.dumps({"session_id": "x"}))
    check("missing prompt field is silent", out.strip() == "" and code == 0)

    out, code = run_hook(payload("hi"))
    check("prompt shorter than floor is silent", out.strip() == "" and code == 0)

    out, code = run_hook(payload("hey how are you doing today friend"))
    check("chitchat is silent", out.strip() == "" and code == 0, f"leaked={out[:160]!r}")

    out, code = run_hook(payload("repo-operations"))
    check(
        "exact skill name emits wrapped briefing",
        code == 0
        and "Auto-routed by codex-bridge" in out
        and "skill `repo-operations`" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("ci-watch-and-heal"))
    check(
        "exact workflow name emits wrapped briefing",
        code == 0
        and "Auto-routed by codex-bridge" in out
        and "workflow `ci-watch-and-heal`" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("repo-operations guidance for branch protection and merge queue state"))
    check(
        "strong free-text match emits wrapped briefing",
        code == 0 and "Auto-routed by codex-bridge" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("how does repo-operations manage branch protection and merge queue settings?"))
    check(
        "Q&A marker plus strong match prepends reply-rules header",
        code == 0
        and "Response format (codex Q&A rules)" in out
        and "Auto-routed by codex-bridge" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(
        payload("how does repo-operations manage branch protection and merge queue settings?"),
        env={"CODEX_BRIDGE_DISABLE": "1"},
    )
    check(
        "CODEX_BRIDGE_DISABLE=1 forces silence even on strong match",
        out.strip() == "" and code == 0,
        f"code={code} out={out[:120]!r}",
    )

    if FAILED:
        print(f"\n{len(FAILED)} check(s) failed: {FAILED}")
        return 1
    print("\nall checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
