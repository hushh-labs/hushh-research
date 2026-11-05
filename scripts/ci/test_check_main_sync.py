#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Explicit local freshness diagnostics and push-hook compatibility.

PR branch-age rejection was replaced by advisory drift and combined-result
validation. Keep the opt-in bounded/block command contracts for operators;
queue authority is covered in test_queue_combined_result.py.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/git/check-main-sync.sh"
HOUR = 3600
FILES = ("app.txt", "other.txt", "notes.txt")


class Run(NamedTuple):
    code: int
    output: str
    summary: str



class Repo:
    """A bare `origin` and a working clone whose `main` is pushed to it."""

    def __init__(self, root: Path) -> None:
        home = root / "home"
        home.mkdir()
        # A hook's GIT_DIR or CI's real GITHUB_STEP_SUMMARY must not leak in,
        # and the developer's global git config (hooks, signing) must not apply.
        self.env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("GIT_", "GITHUB_", "MAIN_SYNC_"))
        }
        self.env.update(
            HOME=str(home),
            XDG_CONFIG_HOME=str(home),
            GIT_CONFIG_NOSYSTEM="1",
            GIT_AUTHOR_NAME="Freshness Test",
            GIT_AUTHOR_EMAIL="freshness-test@example.invalid",
            GIT_COMMITTER_NAME="Freshness Test",
            GIT_COMMITTER_EMAIL="freshness-test@example.invalid",
        )
        self.root = root
        self.work = root / "work"
        self.commits = 0
        origin = root / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", str(origin)], env=self.env, check=True)
        subprocess.run(["git", "init", "-q", str(self.work)], env=self.env, check=True)
        self.git("symbolic-ref", "HEAD", "refs/heads/main")
        self.git("config", "commit.gpgsign", "false")
        self.git("remote", "add", "origin", str(origin))

    def git(self, *args: str, **env: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.work,
            env={**self.env, **env},
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, files: tuple[str, ...], age_hours: float, author: str) -> str:
        self.commits += 1
        for name in files:
            (self.work / name).write_text(f"{name}: {author} commit {self.commits}\n", encoding="utf-8")
        self.git("add", "--all")
        stamp = f"@{int(time.time() - age_hours * HOUR)} +0000"
        self.git(
            "commit", "-q", "--no-verify", "-m", f"{author}: {' '.join(files)}",
            GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp,
        )
        return self.git("rev-parse", "HEAD")

    def behind_branch(
        self,
        *,
        branch_files: tuple[str, ...],
        main_before_tested: tuple[str, ...] = (),
        main_after_tested: tuple[str, ...],
        merge_base_age: float = 3,
    ) -> tuple[str, str]:
        """Return (feature head, tested base) for this history:

        main:    M --- [main_before_tested] = T --- [main_after_tested] = tip
        feature:  \\--- branch_files

        T is what GitHub's refs/pull/N/merge commit would have as first parent.
        """
        self.commit(FILES, merge_base_age, "main")
        merge_base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "-b", "feature")
        head = self.commit(branch_files, merge_base_age - 0.5, "feature")
        self.git("checkout", "-q", "main")
        tested = merge_base
        if main_before_tested:
            tested = self.commit(main_before_tested, 2, "main-before-tested")
        self.commit(main_after_tested, 1, "main-after-tested")
        self.git("push", "-q", "origin", "main")
        self.git("checkout", "-q", "feature")
        return head, tested

    def check(self, mode: str, **env: str) -> Run:
        summary = self.root / "summary.md"
        summary.write_text("", encoding="utf-8")
        result = subprocess.run(
            ["sh", str(SCRIPT)],
            cwd=self.work,
            env={
                **self.env,
                "MAIN_SYNC_REMOTE": "origin",
                "MAIN_SYNC_BRANCH": "main",
                "MAIN_SYNC_MODE": mode,
                "MAIN_SYNC_CURRENT_BRANCH": "feature",
                "GITHUB_ACTIONS": "true",
                "GITHUB_STEP_SUMMARY": str(summary),
                **env,
            },
            capture_output=True,
            text=True,
        )
        return Run(result.returncode, result.stdout + result.stderr, summary.read_text(encoding="utf-8"))


class BoundedBaseFreshnessTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="check-main-sync-")
        self.addCleanup(temp.cleanup)
        self.repo = Repo(Path(temp.name))

    def test_branch_containing_the_base_tip_passes(self) -> None:
        self.repo.commit(FILES, 3, "main")
        self.repo.commit(("app.txt",), 1, "main")
        self.repo.git("push", "-q", "origin", "main")
        self.repo.git("checkout", "-q", "-b", "feature")
        self.repo.commit(("app.txt",), 0.5, "feature")

        run = self.repo.check("bounded")

        self.assertEqual(run.code, 0, run.output)
        self.assertIn("- Fresh:", run.summary)

    def test_behind_without_overlap_passes_with_a_warning(self) -> None:
        # main keeps editing a file the branch never touches, on both sides of
        # the tested base; only the branch's own files can overlap.
        _, tested = self.repo.behind_branch(
            branch_files=("app.txt",), main_before_tested=("other.txt",), main_after_tested=("other.txt",)
        )

        run = self.repo.check("bounded", MAIN_SYNC_TESTED_BASE_SHA=tested)

        self.assertEqual(run.code, 0, run.output)
        self.assertIn("::warning title=Branch Freshness Advisory::", run.output)
        self.assertIn("by **2** commit(s)", run.summary)
        self.assertIn(f"Tested base: `{tested[:8]}` (the base the PR checks tested)", run.summary)
        self.assertIn("Merge-base age: 3h", run.summary)
        self.assertIn("no overlapping changes since the tested base", run.summary.lower())

    def test_main_changing_a_branch_file_after_the_tested_base_blocks(self) -> None:
        _, tested = self.repo.behind_branch(
            branch_files=("app.txt",), main_after_tested=("other.txt", "app.txt")
        )

        run = self.repo.check("bounded", MAIN_SYNC_TESTED_BASE_SHA=tested)

        self.assertEqual(run.code, 1, run.output)
        self.assertIn("::error title=Branch Freshness::", run.output)
        self.assertIn("- app.txt", run.output)
        self.assertNotIn("- other.txt", run.output)
        self.assertIn("- `app.txt`", run.summary)

    def test_push_hook_preserves_requested_freshness_without_weakening_main(self) -> None:
        _, tested = self.repo.behind_branch(
            branch_files=("app.txt",), main_after_tested=("app.txt",)
        )
        script = self.repo.work / "scripts/git/check-main-sync.sh"
        script.parent.mkdir(parents=True)
        script.write_text(
            '#!/bin/sh\nprintf "%s" "$MAIN_SYNC_MODE" > "$FRESHNESS_TEST_MODE_FILE"\n'
            'exec sh "$FRESHNESS_TEST_REAL_SCRIPT"\n', encoding="utf-8",
        )
        hook = ROOT / "consent-protocol/ops/monorepo/pre-push.sh"
        observed_mode = self.repo.root / "hook-mode"

        for branch, mode, expected, applied in (
            ("feature", None, 0, "warn"),
            ("feature", "bounded", 1, "bounded"),
            # The checker leaves main to its direct-push preflight, but the
            # hook must still force its existing mode rather than accept warn.
            ("main", "warn", 0, "block"),
        ):
            with self.subTest(branch=branch, mode=mode):
                if branch == "main":
                    self.repo.git("update-ref", "refs/heads/main", tested)
                    self.repo.git("checkout", "-q", "main")
                env = {
                    **self.repo.env, "MAIN_SYNC_TESTED_BASE_SHA": tested,
                    "MAIN_SYNC_BRANCH": "main",
                    "FRESHNESS_TEST_MODE_FILE": str(observed_mode),
                    "FRESHNESS_TEST_REAL_SCRIPT": str(SCRIPT),
                }
                if mode is not None:
                    env["MAIN_SYNC_MODE"] = mode
                result = subprocess.run(
                    ["sh", str(hook), "origin", "https://github.com/hushh-labs/hushh-research.git"],
                    cwd=self.repo.work, env=env, input="", capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assertEqual(observed_mode.read_text(encoding="utf-8"), applied)

    def test_merge_base_older_than_the_limit_blocks(self) -> None:
        self.repo.behind_branch(
            branch_files=("app.txt",), main_after_tested=("other.txt",), merge_base_age=30
        )

        run = self.repo.check("bounded")

        self.assertEqual(run.code, 1, run.output)
        self.assertIn("past the 24h limit", run.output)
        # The same branch passes once the limit admits its age, so the block
        # above came from the age bound alone.
        self.assertEqual(self.repo.check("bounded", MAIN_SYNC_MAX_AGE_HOURS="48").code, 0)

    def test_push_hook_uses_open_pr_destination_and_does_not_invent_main(self) -> None:
        self.repo.behind_branch(branch_files=("app.txt",), main_after_tested=("other.txt",))
        script = self.repo.work / "scripts/git/check-main-sync.sh"
        script.parent.mkdir(parents=True)
        script.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
        tools = self.repo.root / "bin"
        tools.mkdir()
        gh = tools / "gh"
        gh.write_text('#!/bin/sh\nprintf "%s" "${FRESHNESS_TEST_PR_BASE:-}"\n', encoding="utf-8")
        gh.chmod(0o755)
        hook = ROOT / "consent-protocol/ops/monorepo/pre-push.sh"

        for destination in ("dev", "uat", ""):
            with self.subTest(destination=destination):
                if destination:
                    self.repo.git("branch", "-f", destination, "HEAD")
                    self.repo.git("push", "-q", "origin", destination)
                result = subprocess.run(
                    ["sh", str(hook), "origin", "https://github.com/hushh-labs/hushh-research.git"],
                    cwd=self.repo.work,
                    env={**self.repo.env, "PATH": f"{tools}:{self.repo.env['PATH']}",
                         "FRESHNESS_TEST_PR_BASE": destination},
                    input="", capture_output=True, text=True,
                )
                output = result.stdout + result.stderr
                self.assertEqual(result.returncode, 0, output)
                self.assertNotIn("behind origin/main", output)
                if destination:
                    self.assertIn(f"contains latest origin/{destination}", output)
                else:
                    self.assertIn("PR destination unavailable", output)

        strict = subprocess.run(
            ["sh", str(hook), "origin", "https://github.com/hushh-labs/hushh-research.git"],
            cwd=self.repo.work,
            env={**self.repo.env, "PATH": f"{tools}:{self.repo.env['PATH']}",
                 "FRESHNESS_TEST_PR_BASE": "", "MAIN_SYNC_MODE": "bounded"},
            input="", capture_output=True, text=True,
        )
        self.assertEqual(strict.returncode, 1)
        self.assertIn("Cannot run the requested freshness diagnostic", strict.stderr)

    def test_main_renaming_a_branch_file_blocks(self) -> None:
        _, tested = self.repo.behind_branch(branch_files=("app.txt",), main_after_tested=("other.txt",))
        self.repo.git("checkout", "-q", "main")
        self.repo.git("mv", "app.txt", "moved.txt")
        self.repo.git("commit", "-q", "--no-verify", "-m", "main: rename app.txt")
        self.repo.git("push", "-q", "origin", "main")
        self.repo.git("checkout", "-q", "feature")

        # With rename detection the base's change reads as moved.txt alone.
        run = self.repo.check("bounded", MAIN_SYNC_TESTED_BASE_SHA=tested)

        self.assertEqual(run.code, 1, run.output)
        self.assertIn("- app.txt", run.output)

    def test_only_base_changes_after_the_tested_base_count(self) -> None:
        _, tested = self.repo.behind_branch(
            branch_files=("app.txt",),
            main_before_tested=("app.txt",),
            main_after_tested=("other.txt",),
        )
        # A commit main has not landed: diffing from it would hide app.txt.
        self.repo.git("checkout", "-q", "-b", "unlanded", "origin/main")
        unlanded = self.repo.commit(("notes.txt",), 0.5, "unlanded")
        self.repo.git("checkout", "-q", "feature")

        # main's app.txt change landed before the tested base, so the PR checks
        # already ran on it merged with the branch.
        run = self.repo.check("bounded", MAIN_SYNC_TESTED_BASE_SHA=tested)
        self.assertEqual(run.code, 0, run.output)

        # Without a tested base that is a commit on main, the merge-base stands
        # in and that same change counts against the branch.
        for tested_base in ("", "0" * 40, "not-a-sha", unlanded):
            with self.subTest(tested_base=tested_base):
                run = self.repo.check("bounded", MAIN_SYNC_TESTED_BASE_SHA=tested_base)
                self.assertEqual(run.code, 1, run.output)
                self.assertIn("- app.txt", run.output)

    def test_unreachable_base_blocks(self) -> None:
        self.repo.behind_branch(branch_files=("app.txt",), main_after_tested=("other.txt",))
        (self.repo.root / "origin.git").rename(self.repo.root / "gone.git")

        run = self.repo.check("bounded")

        self.assertEqual(run.code, 1, run.output)
        self.assertIn("Could not fetch origin/main", run.output)

    def test_block_mode_still_fails_any_lag(self) -> None:
        # Negative control on the history bounded mode passes above.
        _, tested = self.repo.behind_branch(
            branch_files=("app.txt",), main_before_tested=("other.txt",), main_after_tested=("other.txt",)
        )
        self.assertEqual(self.repo.check("bounded", MAIN_SYNC_TESTED_BASE_SHA=tested).code, 0)

        run = self.repo.check("block", MAIN_SYNC_TESTED_BASE_SHA=tested)

        self.assertEqual(run.code, 1, run.output)
        self.assertIn("[main-sync] BLOCKED", run.output)
        self.assertIn("is behind origin/main by 2 commit(s)", run.output)

    def test_prepared_branches_check_their_destination_not_main(self) -> None:
        self.repo.behind_branch(
            branch_files=("app.txt",), main_after_tested=("other.txt",)
        )
        for base in ("dev", "uat"):
            with self.subTest(base=base):
                # Candidate includes Main but lacks its actual destination's newer work.
                self.repo.git("checkout", "-q", "-B", "feature", "origin/main")
                self.repo.git("checkout", "-q", "-B", base)
                self.repo.commit(("notes.txt",), 0.25, base)
                self.repo.git("push", "-q", "origin", base)
                self.repo.git("checkout", "-q", "feature")
                self.assertEqual(self.repo.check("block").code, 0)
                stale = self.repo.check("block", MAIN_SYNC_BRANCH=base)
                self.assertEqual(stale.code, 1, stale.output)
                self.assertIn(f"origin/{base}", stale.output)
                self.repo.git("merge", "-q", "--ff-only", f"origin/{base}")
                fresh = self.repo.check("block", MAIN_SYNC_BRANCH=base)
                self.assertEqual(fresh.code, 0, fresh.output)

if __name__ == "__main__":
    unittest.main()
