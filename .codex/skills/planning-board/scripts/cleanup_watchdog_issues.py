#!/usr/bin/env python3
"""Close + de-board the junk issues the Board Sync watchdog auto-created.

Root cause: initiate_local_plans_if_needed() turned every local commit/merge
mentioning consent/ucp/ap2/campaign into a GitHub issue on each run, bloating
the board with commit-message-shaped tasks ("Merge pull request ...",
"fix(consent): ..."). It ran repeatedly, creating duplicates (86 issues, 58 on
2026-06-21 alone). The function is now disabled (HUSSH_BOARD_AUTOCREATE gate).

SAFE FILTER: only act on issues whose BODY begins with the watchdog's exact
signature -- zero false positives. We do NOT title-guess.

Action per matched issue:
  1. remove from project board #73 (if present)
  2. close the issue with a comment explaining the cleanup

Usage:
  python3 cleanup_watchdog_issues.py --dry-run
  python3 cleanup_watchdog_issues.py
"""
from __future__ import annotations

import json
import subprocess
import sys

OWNER = "hushh-labs"
REPO = "hushh-labs/hushh-research"
PROJECT_NUMBER = 73
SIGNATURE = "Automatically initiated by Board Sync watchdog"


def gh(args: list[str], timeout: int = 60) -> str:
    p = subprocess.run(["gh", *args], text=True, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return p.stdout


def find_watchdog_issues() -> list[dict]:
    """All open issues authored by the operator whose body has the signature."""
    raw = gh(["issue", "list", "--repo", REPO, "--author", "kushaltrivedi5",
              "--state", "open", "--limit", "400",
              "--json", "number,title,body"])
    out = []
    for i in json.loads(raw):
        if (i.get("body") or "").strip().startswith(SIGNATURE):
            out.append(i)
    return out


def board_item_ids() -> dict[int, str]:
    """Map issue number -> project item id for items on board #73."""
    import board_ops
    items = board_ops.fetch_items_graphql()
    m = {}
    for it in items:
        c = it.get("content") or {}
        if c.get("number") and c.get("type") == "Issue":
            m[c["number"]] = it["id"]
    return m


def main() -> int:
    dry = "--dry-run" in sys.argv
    issues = find_watchdog_issues()
    print(f"Found {len(issues)} open watchdog-created junk issues.")
    if not issues:
        return 0
    board = {} if dry else board_item_ids()

    deboarded = closed = 0
    for i in issues:
        num = i["number"]
        title = (i["title"] or "")[:55]
        if dry:
            print(f"[dry] would close #{num}  {title}")
            continue
        # 1. remove from board
        item_id = board.get(num)
        if item_id:
            try:
                gh(["project", "item-delete", str(PROJECT_NUMBER), "--owner", OWNER, "--id", item_id])
                deboarded += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  ! deboard #{num} failed: {exc}", file=sys.stderr)
        # 2. close the issue
        try:
            gh(["issue", "close", str(num), "--repo", REPO,
                "--comment", "Closing: auto-created by the Board Sync watchdog from a "
                "local commit/merge (not a real task). The watchdog auto-issue creator "
                "has been disabled to stop board bloat."])
            closed += 1
            print(f"\u2713 closed #{num}  {title}")
        except Exception as exc:  # noqa: BLE001
            print(f"  ! close #{num} failed: {exc}", file=sys.stderr)

    print(f"\n# {'DRY-RUN' if dry else 'APPLIED'}: {len(issues)} watchdog issues "
          f"{'would be closed' if dry else f'-> {closed} closed, {deboarded} removed from board'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
