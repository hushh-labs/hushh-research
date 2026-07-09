#!/usr/bin/env python3
"""One-time + idempotent Hierarchy-field backfill/correction for the
Hushh Engineering Core board (project #73).

Root cause this fixes:
- The daily sync (board_sync_cycle.py) only ever sets Hierarchy for the
  OPERATOR's own (Kushal) items, and board_ops.ASSIGNEE_HIERARCHY_DEFAULTS only
  maps kushaltrivedi5. So every other contributor's items drift to a blank or
  WRONG Hierarchy value and the board looks "under no hierarchy".

What this does:
- For EVERY project item, derive the correct Hierarchy single-select value from
  the item's GitHub assignee using ASSIGNEE_TO_HIERARCHY, and set it when blank
  or wrong. Idempotent: items already correct are skipped.
- REPORT-ONLY for items whose assignee has no mapping (so we never guess).

Usage:
  python3 backfill_hierarchy.py --dry-run     # inspect, no writes
  python3 backfill_hierarchy.py               # apply
"""
from __future__ import annotations

import json
import subprocess
import sys

OWNER = "hushh-labs"
PROJECT_NUMBER = 73

# GitHub login -> Hierarchy single-select option name (must exist on the board).
# Board options: Akshat, Neelesh, Jhumma, Ankit, Kushal, Abdul, Darshan S
ASSIGNEE_TO_HIERARCHY = {
    "kushaltrivedi5": "Kushal",
    "RGlodAkshat": "Akshat",
    "DamriaNeelesh": "Neelesh",
    "ankitkumarsingh1702": "Ankit",
    "Jhumma-hushh": "Jhumma",
    "Akash-292": "Akash",
    "Mrnaveen00": "Naveen",
    "azfx": "Abdul",
    "Han9128": "Hannan",
    "rajayushkgp": "Ayush",
    "ankitmitra101": "Ankit Mitra",
}


def run(args: list[str]) -> str:
    p = subprocess.run(["gh", *args], text=True, capture_output=True, timeout=30)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return p.stdout


def get_field() -> tuple[str, str, dict[str, str]]:
    data = json.loads(run([
        "project", "field-list", str(PROJECT_NUMBER), "--owner", OWNER,
        "--format", "json", "-L", "50",
    ]))
    for f in data["fields"]:
        if f.get("name") == "Hierarchy":
            opts = {o["name"]: o["id"] for o in f.get("options", [])}
            return data.get("projectId") or _project_id(), f["id"], opts
    raise SystemExit("Hierarchy field not found on the board")


def _project_id() -> str:
    data = json.loads(run([
        "project", "view", str(PROJECT_NUMBER), "--owner", OWNER, "--format", "json",
    ]))
    return data["id"]


def list_items() -> list[dict]:
    import board_ops
    return board_ops.fetch_items_graphql()


def main() -> int:
    dry = "--dry-run" in sys.argv
    project_id, field_id, opts = get_field()
    items = list_items()

    fixed: list[str] = []
    skipped_ok = 0
    unmapped: list[str] = []

    for it in items:
        c = it.get("content") or {}
        num = c.get("number")
        repo = c.get("repository", "?")
        cur = it.get("hierarchy")  # None when unset
        assignees = it.get("assignees") or []

        target = None
        for a in assignees:
            if a in ASSIGNEE_TO_HIERARCHY:
                target = ASSIGNEE_TO_HIERARCHY[a]
                break

        if target is None:
            if cur is None:
                unmapped.append(f"{repo}#{num} assignees={assignees or '-'} (no mapping, left blank)")
            continue

        if cur == target:
            skipped_ok += 1
            continue

        label = f"{repo}#{num}: {cur or 'NONE'} -> {target}"
        if dry:
            fixed.append(f"[dry] {label}")
            continue
        run([
            "project", "item-edit",
            "--id", it["id"],
            "--project-id", project_id,
            "--field-id", field_id,
            "--single-select-option-id", opts[target],
        ])
        fixed.append(f"✓ {label}")

    print(f"# Hierarchy backfill ({'DRY-RUN' if dry else 'APPLIED'})")
    print(f"- items scanned: {len(items)}")
    print(f"- already correct: {skipped_ok}")
    print(f"- {'would fix' if dry else 'fixed'}: {len(fixed)}")
    for f in fixed:
        print(f"  {f}")
    if unmapped:
        print(f"- unmapped (reported only): {len(unmapped)}")
        for u in unmapped:
            print(f"  ⚠️ {u}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
