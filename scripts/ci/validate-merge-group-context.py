#!/usr/bin/env python3
"""Validate the exact queue commit and comparison base before selecting CI lanes."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
ALLOWED_BASE_REFS = {
    "refs/heads/main": "main",
    "refs/heads/integration/pr-train": "integration/pr-train",
}


def resolve(base_sha: str, head_sha: str, checkout_sha: str, base_ref: str) -> tuple[str, str, str]:
    if not all(SHA_RE.fullmatch(value) for value in (base_sha, head_sha, checkout_sha)):
        raise ValueError("merge group base, head and checkout must be full commit SHAs")
    if head_sha != checkout_sha:
        raise ValueError("checked-out SHA differs from merge-group head SHA")
    actual_head = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD^{commit}"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if actual_head != head_sha:
        raise ValueError("actual checked-out HEAD differs from merge-group head SHA")
    base_branch = ALLOWED_BASE_REFS.get(base_ref)
    if not base_branch:
        raise ValueError(f"unsupported merge-group base ref: {base_ref!r}")
    for sha in (base_sha, head_sha):
        subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], check=True)
    if subprocess.run(["git", "merge-base", "--is-ancestor", base_sha, head_sha]).returncode:
        raise ValueError("merge-group base is not an ancestor of its head")
    return base_sha, head_sha, base_branch


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--checkout-sha", required=True)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--github-output", required=True, type=Path)
    args = parser.parse_args()
    try:
        base_sha, head_sha, base_branch = resolve(
            args.base_sha, args.head_sha, args.checkout_sha, args.base_ref
        )
    except (ValueError, subprocess.CalledProcessError) as exc:
        parser.error(str(exc))
    with args.github_output.open("a", encoding="utf-8") as output:
        output.write(f"base_sha={base_sha}\nhead_sha={head_sha}\nbase_ref={base_branch}\n")
    print(f"Merge-group CI range: {base_sha}..{head_sha} on {base_branch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
