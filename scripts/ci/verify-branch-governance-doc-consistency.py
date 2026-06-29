#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Keep merge-to-main SOP prose consistent with the enforced PR-base-policy gate.

The *behavior* of how code reaches `main` is enforced by
`scripts/ci/verify-pr-base-policy.py` (governed maintainers may PR directly into
`main` by actor identity; everyone else rides `integration/pr-train`). That gate
has its own `--self-test`, so the behavior cannot silently drift.

What CAN drift is the human-facing SOP prose. Historically the docs taught the
opposite of the gate ("main receives only integration/pr-train promotion PRs",
"Start all maintainer/developer branches from integration/pr-train"), which sent
maintainer milestones down the train and into the cherry-pick-onto-divergent-main
dependency trap.

This guard fails closed when:
  1. a canonical SOP doc is MISSING a required phrase that states the
     two-lane-by-author rule, or
  2. any SOP doc CONTAINS a deprecated phrase that contradicts the gate.

It is deterministic (pure substring checks over tracked files), carries a
`--self-test`, and runs in the required `Governance` gate via
`scripts/ci/repo-governance-check.sh`. Mirror image of
`verify-pr-governance-sections.py`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Canonical SOP docs that describe how code reaches `main`. Each must teach the
# two-lane-by-author rule and must not contradict the enforced gate.
BRANCH_GOVERNANCE_DOC = REPO_ROOT / "docs/reference/operations/branch-governance.md"
PR_GOVERNANCE_SKILL = REPO_ROOT / ".codex/skills/pr-governance-review/SKILL.md"
REPO_OPS_SKILL = REPO_ROOT / ".codex/skills/repo-operations/SKILL.md"
REPO_OPS_BRANCH_RUNTIME = (
    REPO_ROOT / ".codex/skills/repo-operations/references/branch-runtime-ops.md"
)

# Phrase families: each doc must contain AT LEAST ONE phrase from each tuple.
# Tuples (not single strings) so wording can evolve without churn, as long as the
# concept survives. Lowercased before matching.
REQUIRED_CONCEPTS: dict[Path, list[tuple[str, ...]]] = {
    BRANCH_GOVERNANCE_DOC: [
        ("verify-pr-base-policy.py",),
        ("actor identity",),
        ("directly into `main`", "direct-to-main", "directly into main"),
        ("branch from `origin/main`", "branched from main", "branch from origin/main"),
        ("integration/pr-train",),
    ],
    PR_GOVERNANCE_SKILL: [
        ("decided by author", "lane is decided by author"),
        ("directly into `main`", "direct-to-main", "directly into main"),
        ("actor identity",),
    ],
    REPO_OPS_SKILL: [
        ("decided by author", "lane is decided by author"),
        ("directly into `main`", "direct-to-main", "directly into main"),
        ("actor identity",),
    ],
    REPO_OPS_BRANCH_RUNTIME: [
        ("decided by author",),
        ("directly into `main`", "direct-to-main", "directly into main"),
        ("origin/main",),
    ],
}

# Deprecated phrases that contradict the enforced gate. If ANY canonical SOP doc
# contains one of these (lowercased substring), the guard fails — this is what
# catches a regression back to the train-only model.
FORBIDDEN_PHRASES: list[str] = [
    "start all maintainer/developer branches from the current `integration/pr-train`",
    "start all maintainer/developer branches from integration/pr-train",
    "`main` receives only `integration/pr-train` promotion",
    "main receives only integration/pr-train promotion",
    "main receives only `integration/pr-train` promotion",
    "direct prs into `main` are blocked",
    "direct topic-branch prs into `main` are blocked",
]

CANONICAL_DOCS = list(REQUIRED_CONCEPTS.keys())


def _check_text(path: Path, text: str) -> list[str]:
    errors: list[str] = []
    lowered = text.lower()
    for concept in REQUIRED_CONCEPTS.get(path, []):
        if not any(phrase.lower() in lowered for phrase in concept):
            shown = " | ".join(concept)
            errors.append(
                f"{path.relative_to(REPO_ROOT)}: missing required merge-to-main "
                f"concept (one of: {shown})"
            )
    for forbidden in FORBIDDEN_PHRASES:
        if forbidden.lower() in lowered:
            errors.append(
                f"{path.relative_to(REPO_ROOT)}: contains DEPRECATED phrase that "
                f"contradicts the enforced PR-base-policy gate: {forbidden!r}"
            )
    return errors


def evaluate() -> list[str]:
    errors: list[str] = []
    for path in CANONICAL_DOCS:
        if not path.exists():
            errors.append(f"missing canonical SOP doc: {path.relative_to(REPO_ROOT)}")
            continue
        errors.extend(_check_text(path, path.read_text(encoding="utf-8")))
    return errors


def self_test() -> int:
    failures: list[str] = []

    # A doc that teaches the canonical rule and avoids forbidden phrases passes.
    good = (
        "Lane is decided by AUTHOR. Governed maintainers open a PR directly into "
        "`main` from a branch from `origin/main`; the `PR Base Policy` gate "
        "(verify-pr-base-policy.py) authorizes by actor identity. Non-maintainers "
        "ride integration/pr-train."
    )
    if _check_text(BRANCH_GOVERNANCE_DOC, good):
        failures.append("self-test: canonical-good text unexpectedly flagged")

    # A doc carrying a forbidden phrase must fail.
    bad_forbidden = good + "\n`main` receives only `integration/pr-train` promotion PRs."
    if not _check_text(BRANCH_GOVERNANCE_DOC, bad_forbidden):
        failures.append("self-test: forbidden phrase not caught")

    # A doc missing a required concept must fail.
    bad_missing = "Everything goes through the train. No further detail."
    if not _check_text(PR_GOVERNANCE_SKILL, bad_missing):
        failures.append("self-test: missing required concept not caught")

    if failures:
        for f in failures:
            print(f"ERROR: {f}", file=sys.stderr)
        return 1
    print("OK: branch-governance doc-consistency self-test passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify merge-to-main SOP prose matches the enforced PR-base-policy gate."
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    errors = evaluate()
    if errors:
        print("ERROR: branch-governance SOP prose is inconsistent with the enforced gate.")
        print("The enforced rule (scripts/ci/verify-pr-base-policy.py): governed")
        print("maintainers PR directly into `main` by actor identity; everyone else")
        print("rides integration/pr-train. Fix the prose to match:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("OK: branch-governance SOP prose is consistent across all canonical docs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
