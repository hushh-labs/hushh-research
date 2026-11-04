#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"
DEFAULT_PROTECTED_PATHS = [
    ".github/workflows/",
    ".github/actions/",
    "scripts/ci/",
    "hushh-webapp/scripts/testing/affected-tests.mjs",
    "hushh-webapp/scripts/testing/affected-tests.test.mjs",
    "hushh-webapp/scripts/testing/playwright-shard.cjs",
    "deploy/",
    "config/ci-governance.json",
]


def _load_policy() -> dict:
    if os.environ.get("GITHUB_EVENT_NAME") in {"pull_request", "pull_request_target"}:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        base = str(event["pull_request"]["base"]["sha"])
        if not re.fullmatch(r"[0-9a-f]{40}", base):
            raise PolicyError("Unproven protected-policy base")
        # A proposed policy change must not authorize itself.
        raw = subprocess.check_output(
            ["git", "show", f"{base}:config/ci-governance.json"], cwd=REPO_ROOT, text=True
        )
        return json.loads(raw)
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def _normalize_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _matches(path: str, protected_path: str) -> bool:
    if protected_path.endswith("/"):
        return path.startswith(protected_path)
    return path == protected_path


def _fetch_pr_files(repo: str, pr_number: int, token: str) -> list[str]:
    files: list[str] = []
    page = 1
    while True:
        url = (
            f"https://api.github.com/repos/{repo}/pulls/{pr_number}/files"
            f"?per_page=100&page={page}"
        )
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise GuardResolutionError("Changed-file response exceeded its bound")
            payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, list):
            raise GuardResolutionError("Malformed changed-file inventory")
        if not payload:
            break
        for item in payload:
            if not isinstance(item, dict):
                raise GuardResolutionError("Malformed changed-file inventory")
            files.extend(str(item[key]).strip() for key in ("filename", "previous_filename") if item.get(key))
        if page >= 30:
            raise GuardResolutionError("Changed-file inventory exceeded its bound")
        page += 1
    return files


class GuardResolutionError(RuntimeError):
    """Raised when a PR's changed-file list cannot be resolved.

    The guard must FAIL CLOSED on resolution failure: if we cannot determine
    which files a pull request touches, we cannot prove the change is safe, so
    we refuse rather than wave it through. Historically this path returned an
    empty list, which the caller treated as "nothing to enforce" and passed —
    a silent fail-open that disabled the guard entirely whenever GH_TOKEN was
    not wired into the job environment.
    """


def _files_from_event(args: argparse.Namespace) -> list[str]:
    if args.files:
        return _normalize_csv(args.files)
    event_name = args.event_name or os.environ.get("GITHUB_EVENT_NAME", "")
    if event_name not in {"pull_request", "pull_request_target"}:
        return []
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    if not event_path:
        raise GuardResolutionError(
            "GITHUB_EVENT_PATH is unset on a pull_request event; cannot resolve "
            "changed files to enforce protected-surface policy."
        )
    try:
        payload = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardResolutionError(
            f"Could not read GitHub event payload at '{event_path}': {exc}"
        ) from exc
    pull_request = payload.get("pull_request") or {}
    pr_number = args.pr_number or pull_request.get("number")
    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "").strip()
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    missing = [
        name
        for name, value in (
            ("pr_number", pr_number),
            ("repo", repo),
            ("GH_TOKEN/GITHUB_TOKEN", token),
        )
        if not value
    ]
    if missing:
        raise GuardResolutionError(
            "Cannot resolve PR changed files for protected-surface enforcement; "
            f"missing required input(s): {', '.join(missing)}. Wire GH_TOKEN into "
            "the governance job and ensure the repo/PR context is present."
        )
    assert pr_number is not None  # narrowed by the `missing` guard above
    return _fetch_pr_files(repo=str(repo), pr_number=int(pr_number), token=str(token))


class PolicyError(RuntimeError):
    """The policy cannot be read as a cohort. Never resolved by guessing a wider one."""


def resolve_allowed_users(main_policy: dict) -> list[str]:
    """Who may edit protected pipeline surfaces. Fails CLOSED, and loudly.

    This used to read ``protected_pipeline_edit_users or review_bypass_users or []``,
    and that fallback WIDENED. Measured 2026-09-04: the narrow key held 8 logins and
    ``review_bypass_users`` held 14, so DELETING the narrow key would have read in the
    diff as a narrowing while silently granting six more people the right to edit
    workflows, deploy config, and this policy itself -- the exact surfaces this guard
    exists to protect. A fail-safe that widens is not a fail-safe.

    An absent or empty key is therefore a configuration error that stops the run. That
    is the one outcome nobody can mistake for a grant: a missing cohort is answered by
    restating the cohort, never by inheriting somebody else's.
    """
    if "protected_pipeline_edit_users" not in main_policy:
        raise PolicyError(
            "config/ci-governance.json is missing main.protected_pipeline_edit_users. "
            "Refusing to fall back to a wider list; restore the key rather than letting "
            "its absence promote anyone."
        )
    raw = main_policy.get("protected_pipeline_edit_users") or []
    users = sorted({str(login).strip() for login in raw if str(login).strip()})
    if not users:
        raise PolicyError(
            "main.protected_pipeline_edit_users is empty. Refusing to widen to another "
            "list; state the cohort explicitly, even if that cohort is one person."
        )
    return users


def evaluate(
    *,
    changed_files: list[str],
    actor: str,
    allowed_users: list[str],
    protected_paths: list[str],
    owner_approvals: list[str] | None = None,
) -> tuple[int, str]:
    """Pure decision core for protected-surface enforcement.

    Returns (exit_code, message). 0 = allowed/not-applicable, 1 = blocked.
    Kept side-effect-free so it can be unit-tested via --self-test.
    """
    protected_changes = sorted(
        path
        for path in changed_files
        if any(_matches(path, protected_path) for protected_path in protected_paths)
    )
    if not protected_changes:
        return 0, "Protected pipeline edit guard: no protected pipeline surfaces changed."

    actor = actor.strip()
    approved_by = sorted(set(owner_approvals or []) & set(allowed_users))
    if actor in allowed_users or approved_by:
        return 0, (
            "Protected pipeline edit guard: allowed "
            f"(author={actor}, approved_by={approved_by}, files={protected_changes})."
        )

    return 1, (
        "ERROR: protected pipeline surfaces changed by non-sanctioned actor "
        f"'{actor or '<unknown>'}'.\n"
        f"ERROR: protected files={protected_changes}\n"
        f"ERROR: allowed users={allowed_users}"
    )


def owner_queue_approval(*, author: str, requester: str, review: str | None, main_policy: dict) -> list[str]:
    """An owner's explicit queue request approves their own captured PR head.

    The queue owner supplies authenticated membership and exact head evidence.
    This grants review authority only, never CI, queue or deployment bypass.
    """
    owners = set(resolve_allowed_users(main_policy))
    exceptions = set(main_policy.get("review_bypass_users", []))
    if not exceptions <= owners or main_policy.get("review_bypass_team_slug"):
        raise PolicyError("Owner approval must not inherit a broader review bypass")
    if review in {"APPROVED", "REVIEW_REQUIRED", None} and author == requester and requester in exceptions:
        return [requester]
    return []


def _latest_reviews(repo: str, number: int, token: str = "", *, read=None) -> dict[str, dict]:
    """Read bounded decisive review history; comments do not withdraw a review."""
    from github_security_authority import GitHub

    read_page = read if read is not None else GitHub(repo, token).read
    latest: dict[str, dict] = {}
    for page in range(1, 21):
        rows = read_page(f"repos/{repo}/pulls/{number}/reviews?per_page=100&page={page}")
        if not isinstance(rows, list) or len(rows) > 100:
            raise GuardResolutionError("Malformed protected-review inventory")
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("user"), dict):
                raise GuardResolutionError("Malformed protected review")
            login = row["user"].get("login")
            if (not isinstance(login, str) or not login or type(row.get("id")) is not int
                    or row["id"] <= 0 or row.get("state") not in
                    {"APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"}):
                raise GuardResolutionError("Unverified protected review")
            if row["state"] not in {"COMMENTED", "PENDING"}:
                if not isinstance(row.get("commit_id"), str) or not re.fullmatch(r"[a-f0-9]{40}", row["commit_id"]):
                    raise GuardResolutionError("Protected review has no verified commit")
                if row["id"] > latest.get(login, {}).get("id", 0):
                    latest[login] = row
        if len(rows) < 100:
            return latest
    raise GuardResolutionError("Protected-review inventory exceeded its bound")


def _owner_approvals(repo: str, number: int, head: str, allowed: list[str], token: str = "", *, read=None) -> list[str]:
    """Only a current-head, non-dismissed approval from a protected owner counts."""
    return sorted(login for login, row in _latest_reviews(repo, number, token, read=read).items()
                  if login in allowed and row.get("state") == "APPROVED" and row.get("commit_id") == head)


def require_uncontested_owner_approval(repo: str, number: int, head: str, *, read):
    for row in _latest_reviews(repo, number, read=read).values():
        if row.get("state") == "CHANGES_REQUESTED" or (
                row.get("state") == "DISMISSED" and row.get("commit_id") == head):
            raise PolicyError("Resolve the outstanding or withdrawn review before owner self-approval")


def _self_test() -> int:
    allowed = ["kushaltrivedi5", "ankitkumarsingh1702"]
    paths = list(DEFAULT_PROTECTED_PATHS)
    cases: list[tuple[str, list[str], str, int]] = [
        # name, changed_files, actor, expected_exit
        ("community edits governance config", ["config/ci-governance.json"], "random-contributor", 1),
        ("community edits a workflow", [".github/workflows/ci.yml"], "random-contributor", 1),
        ("maintainer edits governance config", ["config/ci-governance.json"], "kushaltrivedi5", 0),
        ("community edits only app code", ["hushh-webapp/app/page.tsx"], "random-contributor", 0),
        ("community edits scripts/ci", ["scripts/ci/orchestrate.sh"], "random-contributor", 1),
        ("community edits unit selector", ["hushh-webapp/scripts/testing/affected-tests.mjs"], "random-contributor", 1),
    ]
    # The cohort resolver: a missing or empty key must STOP the run, never inherit a
    # wider list. Pinned because the widening fallback read as a narrowing in a diff.
    wide = ["kushaltrivedi5", "someone-else", "a-third-person"]
    resolver_cases: list[tuple[str, dict, object]] = [
        ("cohort stated", {"protected_pipeline_edit_users": ["b", "a"], "review_bypass_users": wide}, ["a", "b"]),
        ("cohort missing", {"review_bypass_users": wide}, PolicyError),
        ("cohort empty", {"protected_pipeline_edit_users": [], "review_bypass_users": wide}, PolicyError),
        ("cohort blank entries", {"protected_pipeline_edit_users": ["  "], "review_bypass_users": wide}, PolicyError),
    ]
    for actor, approvals, expected in (
        ("RGlodAkshat", [], 1), ("contributor", ["msainani"], 1),
        ("contributor", ["ankitkumarsingh1702"], 0),
    ):
        code, _ = evaluate(changed_files=[".agents/instructions.md"], actor=actor,
                           allowed_users=allowed, protected_paths=[".agents/"],
                           owner_approvals=approvals)
        assert code == expected
    failures: list[str] = []
    for name, main_policy, expectation in resolver_cases:
        try:
            got: object = resolve_allowed_users(main_policy)
        except PolicyError:
            got = PolicyError
        ok = got is expectation if expectation is PolicyError else got == expectation
        print(f"[{'ok' if ok else 'FAIL'}] resolver: {name}: {got!r}")
        if not ok:
            failures.append(f"resolver {name}: got {got!r}, expected {expectation!r}")
    for name, files, actor, expected in cases:
        code, message = evaluate(
            changed_files=files, actor=actor, allowed_users=allowed, protected_paths=paths
        )
        status = "ok" if code == expected else "FAIL"
        print(f"[{status}] {name}: exit={code} (expected {expected})")
        if code != expected:
            failures.append(f"{name}: got {code}, expected {expected}")
    if failures:
        for failure in failures:
            print(f"ERROR: self-test case failed: {failure}", file=sys.stderr)
        return 1
    print("Protected pipeline edit guard self-test passed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail PR governance when non-maintainers edit protected CI/pipeline surfaces."
    )
    parser.add_argument("--event-name", help="Override GitHub event name.")
    parser.add_argument("--actor", help="Override GitHub actor.")
    parser.add_argument("--repo", help="Override GitHub repo owner/name.")
    parser.add_argument("--pr-number", type=int, help="Override pull request number.")
    parser.add_argument(
        "--files",
        help="Comma-separated changed files for local verification.",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run the built-in decision-core self-test and exit.",
    )
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    policy = _load_policy()
    main_policy = policy["main"]
    try:
        allowed_users = resolve_allowed_users(main_policy)
    except PolicyError as exc:
        print(f"ERROR: {exc}")
        return 1
    protected_paths = main_policy.get("protected_pipeline_paths") or DEFAULT_PROTECTED_PATHS
    event_name = args.event_name or os.environ.get("GITHUB_EVENT_NAME", "")

    if event_name not in {"pull_request", "pull_request_target"} and not args.files:
        print(
            f"Protected pipeline edit guard: skip for event '{event_name or 'local'}'; "
            "PR enforcement only."
        )
        return 0

    changed_files = _files_from_event(args)
    if not changed_files:
        print("Protected pipeline edit guard: no changed files resolved; nothing to enforce.")
        return 0

    actor = args.actor or os.environ.get("GITHUB_ACTOR", "")
    approvals: list[str] = []
    if event_name in {"pull_request", "pull_request_target"} and not args.files:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        pr = event["pull_request"]
        actor = str(pr["user"]["login"])
        if actor not in allowed_users and any(_matches(path, owned) for path in changed_files for owned in protected_paths):
            approvals = _owner_approvals(
                args.repo or os.environ["GITHUB_REPOSITORY"], args.pr_number or pr["number"],
                pr["head"]["sha"], allowed_users,
                os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", ""),
            )
    code, message = evaluate(
        changed_files=changed_files, actor=actor,
        allowed_users=allowed_users, protected_paths=protected_paths,
        owner_approvals=approvals,
    )
    print(message)
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GuardResolutionError as exc:
        # Fail CLOSED: an unresolvable PR file list must block, never wave through.
        print(f"ERROR: protected pipeline edit guard could not enforce policy: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.HTTPError as exc:
        print(f"ERROR: failed to resolve PR files from GitHub API: {exc}", file=sys.stderr)
        raise SystemExit(1)
