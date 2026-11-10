#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from copy import deepcopy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import production_recovery_ci as recovery


class RecoveryQualificationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cwd = os.getcwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, self.cwd)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture Author")
        self.git("config", "user.email", "fixture@example.test")
        self.base = self.commit("before")
        self.source = self.commit("recovery application")
        self.tree = self.git("rev-parse", "HEAD^{tree}")
        self.authority = self.commit("current Main tooling")
        self.git("update-ref", "refs/remotes/origin/main", self.authority)
        pin = patch.object(recovery, "ACTIVE_ANCHOR_PRIMARY_SOURCE", self.source)
        pin.start()
        self.addCleanup(pin.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], text=True).strip()

    def commit(self, value):
        Path("application").write_text(value)
        self.git("add", "application")
        self.git("commit", "-qm", value)
        return self.git("rev-parse", "HEAD")

    def context(self, **overrides):
        return patch.dict(
            os.environ,
            {
                "GITHUB_REPOSITORY": recovery.REPOSITORY,
                "GITHUB_WORKFLOW_REF": f"{recovery.REPOSITORY}/.github/workflows/{recovery.WORKFLOW}@refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_SHA": self.authority,
                "GITHUB_RUN_ATTEMPT": "1",
                **overrides,
            },
        )

    def test_tests_get_the_clean_recovery_application(self):
        with self.context():
            self.assertEqual(recovery.prepare(self.source), (self.base, self.tree))
            self.assertEqual(self.git("rev-parse", "HEAD"), self.authority)
            recovery.prepare(self.source, self.base, self.tree)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.source)
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}"), self.tree)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(Path("application").read_text(), "recovery application")

    def test_refuses_the_tooling_sha_wrong_tree_or_missing_comparison(self):
        for values in (
            (self.authority, self.base, self.tree),
            (self.source, self.base, "f" * 40),
            (self.source, "", ""),
        ):
            with (
                self.subTest(values=values),
                self.context(),
                self.assertRaises(recovery.Refused),
            ):
                recovery.prepare(*values)
            self.assertEqual(self.git("rev-parse", "HEAD"), self.authority)

    def test_refuses_branch_dispatch_partial_rerun_and_dirty_tree(self):
        for context in (
            {"GITHUB_REF": "refs/heads/feature"},
            {"GITHUB_RUN_ATTEMPT": "2"},
        ):
            with (
                self.subTest(context=context),
                self.context(**context),
                self.assertRaises(recovery.Refused),
            ):
                recovery.prepare(self.source)
        Path("application").write_text("dirty")
        with self.context(), self.assertRaises(recovery.Refused):
            recovery.prepare(self.source, self.base, self.tree)

    def runs(self):
        run = {
            "id": 42,
            "head_sha": self.authority,
            "head_branch": "main",
            "path": f".github/workflows/{recovery.WORKFLOW}",
            "event": "workflow_dispatch",
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
            "workflow_id": 11,
            "check_suite_id": 12,
            "repository": {"full_name": recovery.REPOSITORY},
            "head_repository": {"full_name": recovery.REPOSITORY},
        }
        job = {
            "name": recovery.GATE,
            "head_sha": self.authority,
            "run_id": 42,
            "status": "completed",
            "conclusion": "success",
            "steps": [
                {
                    "name": f"Verify recovery application ({self.source} {self.tree} {self.base})",
                    "conclusion": "success",
                }
            ],
        }
        fresh = {
            **run,
            "referenced_workflows": [
                {
                    "path": f"{recovery.REPOSITORY}/.github/workflows/{workflow}@{self.authority}",
                    "sha": self.authority,
                    "ref": "refs/heads/main",
                }
                for workflow in ("ci.yml", "deployment-security.yml")
            ],
        }
        return run, job, fresh

    def qualify(self, run, job, fresh):
        class Actions:
            def read(_, path):
                if path.startswith("workflows/"):
                    return {"workflow_runs": [deepcopy(run)]}
                if path == "runs/42/attempts/1/jobs?per_page=100":
                    return {"total_count": 1, "jobs": [deepcopy(job)]}
                if path == "runs/42":
                    return deepcopy(fresh)
                raise AssertionError(path)

        return recovery.qualification(Actions(), self.source)

    def test_current_main_run_attests_the_distinct_application(self):
        proof = self.qualify(*self.runs())
        self.assertEqual(proof["sha"], self.source)
        self.assertEqual(proof["source_tree"], self.tree)
        self.assertEqual(proof["authority_sha"], self.authority)
        self.assertEqual(proof["checks"][0]["run_attempt"], 1)
        self.assertEqual(len(proof["authority_reads"]), 3)

    def test_wrong_source_wrong_workflow_and_stale_green_refuse(self):
        for change in (
            "wrong-tree",
            "wrong-tooling",
            "failed-latest",
            "rerun",
            "stale",
        ):
            with self.subTest(change=change), self.assertRaises(recovery.Refused):
                run, job, fresh = self.runs()
                if change == "wrong-tree":
                    job["steps"][0]["name"] = job["steps"][0]["name"].replace(
                        self.tree, "f" * 40
                    )
                elif change == "wrong-tooling":
                    fresh["referenced_workflows"][0]["sha"] = self.source
                elif change == "failed-latest":
                    run["conclusion"] = "failure"
                elif change == "rerun":
                    run["run_attempt"] = 2
                else:
                    fresh["run_attempt"] = 2
                self.qualify(run, job, fresh)


if __name__ == "__main__":
    unittest.main()
