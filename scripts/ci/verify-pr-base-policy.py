#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Fail closed on PR target branches that bypass the PR train."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _load_policy(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _event_pr_refs(event_path: str | None) -> tuple[str, str]:
    if not event_path:
        return "", ""
    event_file = Path(event_path)
    if not event_file.exists():
        return "", ""
    payload = json.loads(event_file.read_text(encoding="utf-8"))
    pull_request = payload.get("pull_request") or {}
    base = pull_request.get("base") or {}
    head = pull_request.get("head") or {}
    return str(base.get("ref") or ""), str(head.get("ref") or "")


def _event_pr_actor(event_path: str | None) -> str:
    """Resolve the PR author login from the event payload.

    Prefer the PR author over GITHUB_ACTOR, which can be a re-runner rather than
    the person who opened the PR.
    """
    if not event_path:
        return ""
    event_file = Path(event_path)
    if not event_file.exists():
        return ""
    payload = json.loads(event_file.read_text(encoding="utf-8"))
    pull_request = payload.get("pull_request") or {}
    user = pull_request.get("user") or {}
    return str(user.get("login") or "")


def _governed_maintainers(policy: dict[str, Any]) -> set[str]:
    """Maintainers empowered to merge directly into main.

    Anyone who can already bypass main review/merge-queue governance is, by
    definition, trusted to open a direct PR into main. We union both bypass
    lists so a maintainer added to either is covered.
    """
    main_policy = policy.get("main") or {}
    review_bypass = main_policy.get("review_bypass_users") or []
    queue_bypass = main_policy.get("merge_queue_bypass_users") or []
    return {str(login) for login in (*review_bypass, *queue_bypass) if login}


def evaluate(
    policy: dict[str, Any],
    *,
    base_ref: str,
    head_ref: str,
    actor: str = "",
) -> tuple[bool, str]:
    branch_flow = policy.get("branch_flow") or {}
    main_branch = str(branch_flow.get("promotion_branch") or "main")
    train_branch = str(branch_flow.get("train_branch") or "integration/pr-train")
    allowed_main_heads = set(branch_flow.get("main_allowed_head_branches") or [train_branch])

    if not base_ref:
        return False, "PR base ref is missing; cannot enforce branch target policy."
    if base_ref == main_branch and head_ref not in allowed_main_heads:
        # Governed maintainers may merge directly into main from any branch. The
        # CI Status Gate, merge queue, and Main Post-Merge Smoke Gate still
        # apply, so this only removes the train-branch detour, not the safety
        # gates. Non-maintainers must still target the train branch.
        maintainers = _governed_maintainers(policy)
        if actor and actor in maintainers:
            return (
                True,
                f"PR base policy passed: governed maintainer '{actor}' may merge "
                f"head={head_ref or '<unknown>'} directly into {main_branch}.",
            )
        allowed = ", ".join(sorted(allowed_main_heads))
        return (
            False,
            f"Direct PRs into {main_branch} are blocked for non-maintainers. "
            f"Target {train_branch}, or promote {allowed} into {main_branch}.",
        )
    return True, f"PR base policy passed for head={head_ref or '<unknown>'} base={base_ref}."


def self_test(policy: dict[str, Any]) -> int:
    branch_flow = policy.get("branch_flow") or {}
    main_branch = str(branch_flow.get("promotion_branch") or "main")
    train_branch = str(branch_flow.get("train_branch") or "integration/pr-train")
    maintainers = sorted(_governed_maintainers(policy))
    a_maintainer = maintainers[0] if maintainers else "maintainer"
    # (base_ref, head_ref, actor, expected)
    cases = [
        (main_branch, train_branch, "", True),
        (main_branch, "feature/example", "", False),
        (main_branch, "feature/example", "not-a-maintainer", False),
        (main_branch, "feature/example", a_maintainer, True),
        (train_branch, "feature/example", "", True),
        ("feature/stack-base", "feature/follow-up", "", True),
    ]
    failures: list[str] = []
    for base_ref, head_ref, actor, expected in cases:
        ok, message = evaluate(policy, base_ref=base_ref, head_ref=head_ref, actor=actor)
        print(message)
        if ok != expected:
            failures.append(
                f"expected {expected} for head={head_ref} base={base_ref} actor={actor!r}, got {ok}"
            )
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify PR target branch policy.")
    parser.add_argument("--base-ref", default="")
    parser.add_argument("--head-ref", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--policy-file", default=str(_repo_root() / "config/ci-governance.json"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    policy = _load_policy(Path(args.policy_file))
    if args.self_test:
        return self_test(policy)

    base_ref = args.base_ref
    head_ref = args.head_ref
    if not base_ref:
        base_ref, head_ref = _event_pr_refs(os.environ.get("GITHUB_EVENT_PATH"))

    actor = args.actor or os.environ.get("GITHUB_ACTOR", "")
    if not actor:
        actor = _event_pr_actor(os.environ.get("GITHUB_EVENT_PATH"))

    ok, message = evaluate(policy, base_ref=base_ref, head_ref=head_ref, actor=actor)
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
