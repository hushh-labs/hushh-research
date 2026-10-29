#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Read back the live GitHub policy protecting exact Dev/UAT attempt receipts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from attempt_tag_ruleset import RulesetError, _summaries, desired_payload, validation_errors

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = ROOT / "config" / "ci-governance.json"
REPO = "hushh-labs/hushh-research"


def verify(policy: dict[str, Any], *, read) -> list[str]:
    expected = desired_payload(policy)
    try:
        rows = _summaries(read(f"repos/{REPO}/rulesets?per_page=100"))
    except RulesetError as exc:
        return [str(exc)]
    matches = [row for row in rows if row.get("name") == expected["name"]]
    if len(matches) != 1:
        return [f"expected exactly one {expected['name']!r} ruleset, found {len(matches)}"]
    ruleset_id = matches[0].get("id")
    if not ruleset_id:
        return ["attempt receipt tag ruleset has no ID"]
    detail = read(f"repos/{REPO}/rulesets/{ruleset_id}")
    if not isinstance(detail, dict):
        return ["GitHub returned a malformed attempt receipt tag ruleset"]
    if detail.get("id") != ruleset_id or detail.get("name") != expected["name"]:
        return ["attempt receipt tag ruleset identity changed during verification"]
    return validation_errors(detail, expected)


def _gh_read(endpoint: str) -> Any:
    if "/rulesets?" in endpoint:
        command = ["gh", "api", "--paginate", "--slurp", endpoint]
    else:
        command = ["gh", "api", endpoint]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def self_test() -> int:
    policy = {"attempt_receipt_tag_ruleset": {
        "name": "receipt refs",
        "patterns": [
            "refs/tags/deployed/dev-attempt/*",
            "refs/tags/deployed/uat-attempt/*",
        ],
    }}
    desired = desired_payload(policy)
    live = {**desired, "id": 91}
    cases = [("exact active policy passes", live, False)]
    for change in (
        {"enforcement": "disabled"},
        {"target": "branch"},
        {"bypass_actors": [{"actor_type": "RepositoryRole", "actor_id": 5}]},
        {"rules": [{"type": "deletion"}]},
        {"rules": [{"type": "creation"}, {"type": "deletion"}, {"type": "update"}]},
        {"conditions": {"ref_name": {"include": ["refs/tags/*"], "exclude": []}}},
    ):
        invalid = {**live, **change}
        cases.append((f"rejects {next(iter(change))} drift", invalid, True))
    failures = 0
    for label, candidate, should_fail in cases:
        errors = validation_errors(candidate, desired)
        ok = bool(errors) == should_fail
        print(f"{'ok' if ok else 'FAIL'} {label}")
        failures += not ok

    def inventory(rows):
        return lambda endpoint: rows if endpoint.endswith("?per_page=100") else live

    if verify(policy, read=inventory([live])):
        print("FAIL verifier accepts exact ruleset")
        failures += 1
    if not verify(policy, read=inventory([])):
        print("FAIL verifier rejects missing ruleset")
        failures += 1
    if failures:
        return 1
    print("attempt receipt tag ruleset checks passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--policy-file", type=Path, default=POLICY_PATH)
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    try:
        policy = json.loads(args.policy_file.read_text(encoding="utf-8"))
        errors = verify(policy, read=_gh_read)
    except (OSError, json.JSONDecodeError, subprocess.CalledProcessError, RulesetError) as exc:
        print(f"ERROR: could not verify attempt receipt tag ruleset: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("ERROR: attempt receipt tag ruleset does not protect durable release evidence:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("OK: attempt receipt tag ruleset is active, exact, and has no bypass actors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
