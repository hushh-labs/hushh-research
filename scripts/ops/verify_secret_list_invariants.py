#!/usr/bin/env python3
"""Detect a list-valued secret that has been wiped.

`gcloud secrets versions add` replaces the entire value. Editing a list without
reading it first deletes every other entry, silently, with no error and no
alert. On 2026-09-03 HUSHH_UAT_PHONE_TEST_NUMBERS went from 59 entries to 1
that way. Nobody noticed for five days, and when it surfaced it looked like
phone verification was broken rather than like configuration had been deleted.

Old versions are the only record that anything was lost, and nothing reads them.
This does.

For each secret declared in config/protected-lists.json it fails when:

  * the current value has fewer entries than `min_entries` -- a floor no
    legitimate edit crosses; or
  * more than `max_shrink` entries disappeared between the previous version and
    the current one -- removing a departed tester is normal, losing 58 is not.

It prints counts only, never values.

Exit 0 = healthy, 1 = a list was wiped or shrank suspiciously, 2 = could not check.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG = REPO_ROOT / "config" / "protected-lists.json"
SPLIT = re.compile(r"[,;\n]+")


def entries(raw: str) -> list[str]:
    out = []
    for part in SPLIT.split(raw):
        part = part.strip()
        if not part:
            continue
        digits = re.sub(r"[^0-9+@._a-zA-Z-]", "", part)
        if digits:
            out.append(digits)
    return out


def gcloud(args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(
        ["gcloud", *args], capture_output=True, text=True, check=False
    )
    return proc.returncode, proc.stdout


def versions(secret: str, project: str) -> list[str]:
    code, out = gcloud(
        ["secrets", "versions", "list", secret, f"--project={project}",
         "--filter=state:ENABLED", "--format=value(name)", "--limit=2"]
    )
    return out.split() if code == 0 else []


def read(secret: str, project: str, version: str) -> str | None:
    code, out = gcloud(
        ["secrets", "versions", "access", version,
         f"--secret={secret}", f"--project={project}"]
    )
    return out if code == 0 else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="only check secrets in this project")
    args = ap.parse_args()

    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    tracked = [
        s for s in config["secrets"]
        if not args.project or s["project"] == args.project
    ]
    if not tracked:
        print("No tracked secrets for that project.")
        return 0

    failures: list[str] = []
    unchecked: list[str] = []

    for spec in tracked:
        name, project = spec["name"], spec["project"]
        label = f"{project}/{name}"
        vs = versions(name, project)
        if not vs:
            unchecked.append(f"{label}: cannot list versions (missing, or no access)")
            continue

        current_raw = read(name, project, vs[0])
        if current_raw is None:
            unchecked.append(f"{label}: cannot read version {vs[0]}")
            continue
        current = entries(current_raw)

        line = f"  {label:46s} v{vs[0]:<4s} {len(current):4d} entries"
        if len(current) < spec["min_entries"]:
            failures.append(
                f"{label}: {len(current)} entries is below the floor of "
                f"{spec['min_entries']}. This list has been wiped. "
                f"Restore with: scripts/ops/secret_list_edit.py --secret {name} "
                f"--project {project} --restore-from <last good version> --apply"
            )
            line += "   *** BELOW FLOOR ***"

        if len(vs) > 1:
            prev_raw = read(name, project, vs[1])
            if prev_raw is not None:
                prev = entries(prev_raw)
                lost = [e for e in prev if e not in set(current)]
                line += f"   (prev v{vs[1]}: {len(prev)}, lost {len(lost)})"
                if len(lost) > spec["max_shrink"]:
                    failures.append(
                        f"{label}: {len(lost)} entries present in v{vs[1]} are gone from "
                        f"v{vs[0]} (limit {spec['max_shrink']}). A write replaced the list "
                        f"instead of adding to it. Restore with: "
                        f"scripts/ops/secret_list_edit.py --secret {name} "
                        f"--project {project} --restore-from {vs[1]} --apply"
                    )
                    line += "   *** ENTRIES LOST ***"
        print(line)

    if unchecked:
        print("\nCould not check:", file=sys.stderr)
        for item in unchecked:
            print(f"  - {item}", file=sys.stderr)

    if failures:
        print("\nA protected list-valued secret has lost entries:\n", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}\n", file=sys.stderr)
        return 1

    if unchecked and not failures:
        # Never report healthy for something that was not actually read.
        return 2

    print(f"\nAll {len(tracked)} tracked list secrets are intact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
