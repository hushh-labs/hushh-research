#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Fail when a protected behaviour loses the tests that prove it.

`main` waives REVIEW for the bypass cohort but never waives VALIDATION, so a
test that runs in the pull-request lane is the only guard that applies equally
to everyone -- every bypass user, every ``--admin`` merge. Wiring the Connect
search pack into ``scripts/ci/web-targeted-check.sh`` does that.

This closes the one hole that leaves: a deleted test is a green test. Here we
assert the tests still EXIST -- named cases present, assertion count above a
floor -- so gutting a suite fails the PR instead of quietly passing it.

Read together: web-targeted-check.sh proves the behaviour still works, and this
proves the proof is still there.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "protected-behaviors.json"


def check_entry(behavior: dict, root: Path) -> list[str]:
    """Return a list of failure strings for one protected behaviour."""
    errors: list[str] = []
    name = behavior.get("name", "<unnamed>")

    for spec in behavior.get("tests", []):
        rel = spec["path"]
        path = root / rel

        if not path.is_file():
            errors.append(
                f"[{name}] {rel} is missing. It proves a behaviour that was "
                f"fixed in {behavior.get('fixed_by', '<unknown>')}; deleting it "
                f"makes the regression invisible. Restore it, or remove the "
                f"entry from config/protected-behaviors.json in a PR that says why."
            )
            continue

        source = path.read_text(encoding="utf-8")

        for title in spec.get("required_titles", []):
            if title not in source:
                errors.append(
                    f"[{name}] {rel} no longer contains the test "
                    f'"{title}". Renaming is fine -- update the required_titles '
                    f"entry in config/protected-behaviors.json in the same PR. "
                    f"Deleting is not."
                )

        pattern = spec.get("assertion_pattern")
        floor = int(spec.get("min_assertions", 0))
        if pattern and floor:
            found = len(re.findall(pattern, source, flags=re.MULTILINE))
            if found < floor:
                errors.append(
                    f"[{name}] {rel} has {found} assertions, below the floor of "
                    f"{floor}. A suite that loses assertions still passes, which "
                    f"is exactly how a locked behaviour gets quietly unlocked."
                )

    return errors


def self_test() -> int:
    """Prove the checker actually fails -- an unfalsifiable gate is decoration."""
    import tempfile

    cases: list[tuple[str, dict, bool]] = []

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "t").mkdir()
        good = "t/good.test.ts"
        (root / good).write_text(
            'it("keeps the thing", () => { expect(1).toBe(1); expect(2).toBe(2); });\n',
            encoding="utf-8",
        )

        base = {
            "name": "probe",
            "fixed_by": "deadbeef",
            "tests": [
                {
                    "path": good,
                    "assertion_pattern": r"expect\(",
                    "min_assertions": 2,
                    "required_titles": ["keeps the thing"],
                }
            ],
        }
        cases.append(("intact suite passes", base, False))

        missing = json.loads(json.dumps(base))
        missing["tests"][0]["path"] = "t/gone.test.ts"
        cases.append(("deleted file fails", missing, True))

        renamed = json.loads(json.dumps(base))
        renamed["tests"][0]["required_titles"] = ["a case that is not there"]
        cases.append(("removed test case fails", renamed, True))

        gutted = json.loads(json.dumps(base))
        gutted["tests"][0]["min_assertions"] = 5
        cases.append(("assertions below floor fails", gutted, True))

        failures = 0
        for label, behavior, expect_errors in cases:
            errors = check_entry(behavior, root)
            ok = bool(errors) == expect_errors
            print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
            if not ok:
                failures += 1

    if failures:
        print(f"self-test: {failures} case(s) behaved wrongly.")
        return 1
    print("self-test: all cases behaved as expected.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Verify this checker can actually fail, then exit.",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    if not POLICY_PATH.is_file():
        print(f"ERROR: {POLICY_PATH} is missing.", file=sys.stderr)
        return 1

    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    behaviors = policy.get("protected_behaviors", [])
    if not behaviors:
        print("ERROR: config/protected-behaviors.json declares no behaviours.", file=sys.stderr)
        return 1

    errors: list[str] = []
    for behavior in behaviors:
        errors.extend(check_entry(behavior, REPO_ROOT))

    if errors:
        print("ERROR: a protected behaviour lost the tests that prove it.\n", file=sys.stderr)
        for err in errors:
            print(f"  - {err}\n", file=sys.stderr)
        return 1

    checked = sum(len(b.get("tests", [])) for b in behaviors)
    print(
        f"Protected behaviour tests intact: {len(behaviors)} behaviour(s), "
        f"{checked} test file(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
