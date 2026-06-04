#!/usr/bin/env python3
"""Audit open PR ancestry health against the current base branch.

This is intentionally separate from the main review checklist so operators can
freeze a PR train and classify branch hygiene before spending review time on a
contaminated diff.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any


DEFAULT_REPO = "hushh-labs/hushh-research"


@dataclass(frozen=True)
class Thresholds:
    max_ahead: int
    max_behind: int
    max_changed_files: int
    allow_codex: bool
    allow_claude: bool


def _run_gh_api(path: str) -> Any:
    output = subprocess.check_output(["gh", "api", path], text=True)
    return json.loads(output)


def _pulls(repo: str, *, limit: int) -> list[dict[str, Any]]:
    pulls: list[dict[str, Any]] = []
    page = 1
    per_page = min(100, max(1, limit))
    while len(pulls) < limit:
        batch = _run_gh_api(f"repos/{repo}/pulls?state=open&per_page={per_page}&page={page}")
        if not batch:
            break
        pulls.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return pulls[:limit]


def _pull(repo: str, number: int) -> dict[str, Any]:
    return _run_gh_api(f"repos/{repo}/pulls/{number}")


def _compare(repo: str, base: str, owner: str, ref: str) -> dict[str, Any]:
    spec = f"{base}...{owner}:{ref}"
    encoded = urllib.parse.quote(spec, safe=":")
    return _run_gh_api(f"repos/{repo}/compare/{encoded}")


def _classify(row: dict[str, Any], thresholds: Thresholds, *, repo_owner: str) -> tuple[str, list[str]]:
    reasons: list[str] = []
    status = row.get("status")
    ahead = int(row.get("ahead") or 0)
    behind = int(row.get("behind") or 0)
    changed_files = int(row.get("changed_files") or 0)
    codex_files = int(row.get("codex_files") or 0)
    claude_files = int(row.get("claude_files") or 0)

    if row.get("base") != "main":
        return "stacked_or_non_main", ["base is not main"]

    if status != "ahead":
        reasons.append(f"compare status is {status}")
    if ahead > thresholds.max_ahead:
        reasons.append(f"ahead commits {ahead} > {thresholds.max_ahead}")
    if behind > thresholds.max_behind:
        reasons.append(f"behind commits {behind} > {thresholds.max_behind}")
    if changed_files >= thresholds.max_changed_files:
        reasons.append(f"changed files hit {changed_files} cap/threshold")
    if claude_files and not thresholds.allow_claude:
        reasons.append(f".claude files present: {claude_files}")
    if codex_files and not thresholds.allow_codex:
        reasons.append(f".codex files present: {codex_files}")

    if not reasons:
        return "clean_for_review", []

    if row.get("head_owner") == repo_owner:
        return "rebase_or_recreate_required", reasons
    return "contributor_recreate_required", reasons


def audit(
    repo: str,
    *,
    limit: int,
    thresholds: Thresholds,
    base_ref: str | None = None,
    pr_numbers: list[int] | None = None,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    repo_owner = repo.split("/", 1)[0]
    pulls = [_pull(repo, number) for number in pr_numbers] if pr_numbers else _pulls(repo, limit=limit)
    for pr in pulls:
        head_repo = pr.get("head", {}).get("repo") or {}
        head_owner = (head_repo.get("owner") or pr.get("head", {}).get("user") or {}).get("login")
        head_ref = pr.get("head", {}).get("ref")
        pr_base = pr.get("base", {}).get("ref")
        compare_base = base_ref or pr_base
        row = {
            "number": pr.get("number"),
            "url": pr.get("html_url"),
            "title": pr.get("title"),
            "head_owner": head_owner,
            "head_ref": head_ref,
            "base": pr_base,
            "compare_base": compare_base,
            "head_sha": (pr.get("head", {}).get("sha") or "")[:10],
            "draft": bool(pr.get("draft")),
            "created_at": pr.get("created_at"),
            "updated_at": pr.get("updated_at"),
        }
        try:
            compare = _compare(repo, str(compare_base), str(head_owner), str(head_ref))
            files = [item.get("filename", "") for item in compare.get("files", [])]
            row.update(
                status=compare.get("status"),
                ahead=compare.get("ahead_by"),
                behind=compare.get("behind_by"),
                merge_base=((compare.get("merge_base_commit") or {}).get("sha") or "")[:10],
                changed_files=len(files),
                codex_files=sum(1 for path in files if path.startswith(".codex/")),
                claude_files=sum(1 for path in files if path.startswith(".claude/")),
            )
            bucket, reasons = _classify(row, thresholds, repo_owner=repo_owner)
            row["bucket"] = bucket
            row["reasons"] = reasons
            rows.append(row)
        except subprocess.CalledProcessError as exc:
            row["bucket"] = "compare_error"
            row["error"] = exc.output.strip()[:500]
            errors.append(row)
            rows.append(row)

    buckets = Counter(row["bucket"] for row in rows)
    merge_bases = Counter(row.get("merge_base") for row in rows if row.get("merge_base"))
    by_owner: dict[str, Counter[str]] = defaultdict(Counter)
    for row in rows:
        by_owner[str(row.get("head_owner"))][str(row.get("bucket"))] += 1

    return {
        "repo": repo,
        "limit": limit,
        "base_ref": base_ref,
        "pr_numbers": pr_numbers or [],
        "thresholds": thresholds.__dict__,
        "counts": dict(buckets),
        "merge_bases": dict(merge_bases.most_common(10)),
        "by_owner": {owner: dict(counter) for owner, counter in sorted(by_owner.items())},
        "errors": errors,
        "prs": rows,
    }


def _print_text(result: dict[str, Any]) -> None:
    print(f"Repo: {result['repo']}")
    print(f"PRs scanned: {len(result['prs'])}")
    print("Buckets:")
    for bucket, count in sorted(result["counts"].items()):
        print(f"- {bucket}: {count}")
    print("Top merge bases:")
    for merge_base, count in result["merge_bases"].items():
        print(f"- {merge_base}: {count}")
    print("Blocked/recreate candidates:")
    for row in result["prs"]:
        if row["bucket"] in {"rebase_or_recreate_required", "contributor_recreate_required"}:
            reason = "; ".join(row.get("reasons") or [])
            print(
                f"- #{row['number']} {row['url']} "
                f"{row['bucket']} ahead={row.get('ahead')} behind={row.get('behind')} "
                f"files={row.get('changed_files')} codex={row.get('codex_files')} "
                f"claude={row.get('claude_files')} reason={reason}"
            )
    print("Clean candidates:")
    for row in result["prs"]:
        if row["bucket"] == "clean_for_review":
            print(f"- #{row['number']} {row['url']} ahead={row.get('ahead')} files={row.get('changed_files')}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit PR branch ancestry health.")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument(
        "--base-ref",
        help=(
            "Override the PR base ref used for GitHub compare. Use this for "
            "preview-branch impact audits before changing main."
        ),
    )
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument(
        "--pr",
        action="append",
        type=int,
        default=[],
        help="Audit a specific PR number. Can be repeated; when set, --limit is ignored.",
    )
    parser.add_argument("--max-ahead", type=int, default=50)
    parser.add_argument("--max-behind", type=int, default=10)
    parser.add_argument("--max-changed-files", type=int, default=300)
    parser.add_argument("--allow-codex", action="store_true")
    parser.add_argument("--allow-claude", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    thresholds = Thresholds(
        max_ahead=args.max_ahead,
        max_behind=args.max_behind,
        max_changed_files=args.max_changed_files,
        allow_codex=args.allow_codex,
        allow_claude=args.allow_claude,
    )
    result = audit(
        args.repo,
        limit=args.limit,
        thresholds=thresholds,
        base_ref=args.base_ref,
        pr_numbers=args.pr,
    )
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        _print_text(result)

    unsafe = result["counts"].get("rebase_or_recreate_required", 0)
    unsafe += result["counts"].get("contributor_recreate_required", 0)
    unsafe += result["counts"].get("compare_error", 0)
    return 2 if unsafe else 0


if __name__ == "__main__":
    sys.exit(main())
