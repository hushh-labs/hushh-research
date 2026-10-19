#!/usr/bin/env python3
"""Remove PullRequest items from the Hushh Engineering Core board (#73).

PRs are implementation artifacts, not board items. The board tracks ISSUES;
a PR's work is represented by the issue it closes. PR items (especially
promotion/merge/PR-train/governance PRs) only bloat the board and make every
merge look like a separate task.

This ONLY removes the item from the project board — it does NOT close, delete,
or touch the PR on GitHub. Reversible (re-add via the UI if ever needed).

Usage:
  python3 remove_pr_items.py --dry-run
  python3 remove_pr_items.py
"""
from __future__ import annotations

import json
import subprocess
import sys

OWNER = "hushh-labs"
PROJECT_NUMBER = 73


def gh(args: list[str]) -> str:
    p = subprocess.run(["gh", *args], text=True, capture_output=True, timeout=90)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return p.stdout


def main() -> int:
    dry = "--dry-run" in sys.argv
    import board_ops
    items = board_ops.fetch_items_graphql()

    prs = [it for it in items if (it.get("content") or {}).get("type") == "PullRequest"]
    removed = 0
    for it in prs:
        c = it.get("content") or {}
        num = c.get("number")
        title = (c.get("title") or "")[:55]
        if dry:
            print(f"[dry] would remove PR #{num}  {title}")
            continue
        try:
            gh(["project", "item-delete", str(PROJECT_NUMBER), "--owner", OWNER, "--id", it["id"]])
            removed += 1
            print(f"✓ removed PR #{num}  {title}")
        except Exception as exc:  # noqa: BLE001
            print(f"✗ failed PR #{num}: {exc}", file=sys.stderr)

    print(f"\n# {'DRY-RUN' if dry else 'APPLIED'}: {len(prs)} PR items "
          f"{'would be removed' if dry else f'-> {removed} removed'} "
          f"(PRs themselves untouched on GitHub).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
