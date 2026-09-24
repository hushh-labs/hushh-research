#!/usr/bin/env python3
"""Guard secret-scan ranges against dropping pre-merge feature commits."""
from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
RANGE_OWNERS = (
    ROOT / "scripts/ci/secret-scan.sh",
    ROOT / ".github/workflows/ci.yml",
    ROOT / ".github/workflows/queue-validation.yml",
)


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=repo, text=True, stderr=subprocess.DEVNULL
    ).strip()


def commit_file(repo: Path, name: str, content: str, message: str) -> str:
    (repo / name).write_text(content, encoding="utf-8")
    git(repo, "add", name)
    git(repo, "commit", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def verify_ranges_exclude_ancestry_path() -> None:
    for path in RANGE_OWNERS:
        if "--ancestry-path" in path.read_text(encoding="utf-8"):
            raise AssertionError(f"{path.relative_to(ROOT)} filters merged feature commits")


def verify_merged_feature_commits_stay_in_range() -> None:
    with tempfile.TemporaryDirectory(prefix="secret-scan-range-") as temp:
        repo = Path(temp)
        git(repo, "init", "-q", "-b", "main")
        git(repo, "config", "user.name", "Secret Scan Test")
        git(repo, "config", "user.email", "secret-scan-test@example.invalid")
        git(repo, "config", "commit.gpgsign", "false")
        commit_file(repo, "base.txt", "base", "base")
        base = git(repo, "rev-parse", "HEAD")

        git(repo, "switch", "-q", "-c", "feature")
        feature_one = commit_file(repo, "feature-one.txt", "one", "feature one")
        feature_two = commit_file(repo, "feature-two.txt", "two", "feature two")

        git(repo, "switch", "-q", "main")
        main_only = commit_file(repo, "main-only.txt", "main", "main advances")
        git(repo, "switch", "-q", "feature")
        git(repo, "merge", "--no-edit", "main")
        head = git(repo, "rev-parse", "HEAD")

        # A plain base..head range includes both feature commits; ancestry-path
        # silently excludes them after the feature merges the newer base branch.
        included = set(git(repo, "rev-list", f"{main_only}..{head}").splitlines())
        if not {feature_one, feature_two}.issubset(included):
            raise AssertionError("plain base..head range dropped feature commits")

        ancestor_only = set(
            git(repo, "rev-list", "--ancestry-path", f"{main_only}..{head}").splitlines()
        )
        if feature_one in ancestor_only or feature_two in ancestor_only:
            raise AssertionError("synthetic graph no longer demonstrates the range bug")
        if git(repo, "merge-base", base, head) != base:
            raise AssertionError("synthetic graph has an unexpected merge base")


def main() -> None:
    verify_ranges_exclude_ancestry_path()
    verify_merged_feature_commits_stay_in_range()
    print("Secret scan range regression passed (merged feature commits remain included).")


if __name__ == "__main__":
    main()
