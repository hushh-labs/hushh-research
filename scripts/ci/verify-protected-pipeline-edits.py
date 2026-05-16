#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
import os
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
    "deploy/",
    "config/ci-governance.json",
]


def _load_policy() -> dict:
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
        with urllib.request.urlopen(request) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not payload:
            break
        files.extend(
            item["filename"].strip()
            for item in payload
            if isinstance(item, dict) and item.get("filename")
        )
        page += 1
    return files


def _files_from_event(args: argparse.Namespace) -> list[str]:
    if args.files:
        return _normalize_csv(args.files)
    event_name = args.event_name or os.environ.get("GITHUB_EVENT_NAME", "")
    if event_name not in {"pull_request", "pull_request_target"}:
        return []
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    if not event_path:
        return []
    payload = json.loads(Path(event_path).read_text(encoding="utf-8"))
    pull_request = payload.get("pull_request") or {}
    pr_number = args.pr_number or pull_request.get("number")
    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "").strip()
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    if not pr_number or not repo or not token:
        return []
    return _fetch_pr_files(repo=repo, pr_number=int(pr_number), token=token)


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
    args = parser.parse_args()

    policy = _load_policy()
    main_policy = policy["main"]
    allowed_users = sorted(
        set(
            main_policy.get("protected_pipeline_edit_users")
            or main_policy.get("review_bypass_users")
            or []
        )
    )
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

    protected_changes = sorted(
        path
        for path in changed_files
        if any(_matches(path, protected_path) for protected_path in protected_paths)
    )
    if not protected_changes:
        print("Protected pipeline edit guard: no protected pipeline surfaces changed.")
        return 0

    actor = (args.actor or os.environ.get("GITHUB_ACTOR", "")).strip()
    if actor in allowed_users:
        print(
            "Protected pipeline edit guard: allowed "
            f"(actor={actor}, files={protected_changes}, allowed_users={allowed_users})."
        )
        return 0

    print(
        "ERROR: protected pipeline surfaces changed by non-sanctioned actor "
        f"'{actor or '<unknown>'}'."
    )
    print(f"ERROR: protected files={protected_changes}")
    print(f"ERROR: allowed users={allowed_users}")
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as exc:
        print(f"ERROR: failed to resolve PR files from GitHub API: {exc}", file=sys.stderr)
        raise SystemExit(1)
