#!/usr/bin/env python3
"""Fail closed when direct-UAT evidence changes or belongs to another source."""

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import uat_exact_ci as subject






def _attempt_run(candidate):
    run = {
        "id": 123,
        "head_sha": candidate,
        "head_branch": "uat",
        "event": "workflow_dispatch",
        "run_attempt": 1,
        "workflow_id": 9,
        "path": ".github/workflows/ci.yml",
        "repository": {"id": 7, "full_name": subject.REPOSITORY},
        "head_repository": {"id": 7, "full_name": subject.REPOSITORY},
        "status": "completed",
        "conclusion": "success",
        "run_started_at": "2026-10-28T00:00:00Z",
        "updated_at": "2026-10-28T00:00:30Z",
        "check_suite_id": 77,
    }
    return run

def _attempt_jobs(candidate, base, exact_name=None):
    exact_name = exact_name or f"Exact UAT Candidate ({base})"
    jobs = [
        {
            "name": name,
            "run_id": 123,
            "head_sha": candidate,
            "status": "completed",
            "conclusion": "success",
            "steps": [],
        }
        for name in sorted(
            subject.REQUIRED_JOBS | {exact_name}
        )
    ]
    for job in jobs:
        name = job["name"]
        step = (
            "Verify the exact UAT checkout"
            if name in {"Exact UAT Candidate", f"Exact UAT Candidate ({base})"}
            else "Run targeted web contract checks"
            if name.startswith("Web Targeted Contracts (")
            else "Run serial database contracts"
            if name.startswith("Protocol Database (")
            else "Resolve change-aware verification plan"
            if name == "Integration"
            else None
        )
        if step:
            job["steps"] = [{"name": step, "conclusion": "success"}]
        if name == "Branch Validation Gate":
            job["check_run_url"] = (
                f"https://api.github.com/repos/{subject.REPOSITORY}/check-runs/10"
            )
    return jobs

class ExactUatCiTest(unittest.TestCase):
    def test_reviewed_product_tests_and_dependencies_do_not_change_execution_authority(self):
        main = {"scripts": {"test": "vitest"}, "dependencies": {"a": "1"}}
        candidate = {**main, "dependencies": {"a": "2"}}
        def observed(*args):
            if args[-1].endswith("pyproject.toml"):
                return b"[tool.pytest.ini_options]\naddopts = '-q'\n"
            return json.dumps(candidate if args[-1].startswith("candidate:") else main).encode()
        with patch.object(subject, "git", side_effect=observed):
            subject.verify_invocation_authority("candidate", "main")
            candidate["scripts"] = {"test": "true"}
            with self.assertRaises(subject.Refused):
                subject.verify_invocation_authority("candidate", "main")

    def test_remote_tip_is_refreshed_but_historical_authority_does_not_use_current_tip(self):
        candidate, base, authority = "a" * 40, "b" * 40, "c" * 40
        calls = []
        def observed(*args):
            calls.append(args)
            if args == ("rev-parse", "origin/uat"):
                return ("d" * 40).encode()
            if args[:1] == ("ls-tree",):
                return b"trusted pipeline entries"
            if args[:1] == ("rev-parse",):
                return ("e" * 40).encode()
            return b""
        with patch.object(subject, "git", side_effect=observed), patch.object(subject, "verify_invocation_authority"):
            with self.assertRaisesRegex(subject.Refused, "tip changed"):
                subject.verify_git_authority(candidate, base, authority)
            self.assertEqual(calls[0], ("fetch", "--no-tags", "origin", "main", "uat"))
            calls.clear()
            self.assertEqual(subject.verify_git_authority(candidate, base, authority, current=False), "e" * 40)
            self.assertNotIn(("rev-parse", "origin/uat"), calls)
            self.assertFalse(any(call[0] == "fetch" for call in calls))

    def test_changed_release_recipe_or_migration_controller_is_not_reviewed_main_authority(
        self,
    ):
        candidate, base, authority = "a" * 40, "b" * 40, "c" * 40
        changed_paths = (
            "deploy/backend.cloudbuild.yaml",
            "consent-protocol/db/migrate.py",
            "consent-protocol/db/migration_authority.py",
            "consent-protocol/db/dev_migration_manifest.py",
            "consent-protocol/hushh_mcp/services/hushh_tech_uat_database_attestation.py",
        )
        for changed_path in changed_paths:
            with self.subTest(path=changed_path):
                calls = []

                def observed(*args):
                    calls.append(args)
                    if args[:1] == ("ls-tree",):
                        covers_path = any(
                            changed_path == path
                            or changed_path.startswith(path.rstrip("/") + "/")
                            for path in args[5:]
                        )
                        entries = [b"100644 blob stable\t.github/workflows/ci.yml\n"]
                        if covers_path:
                            blob = "1" * 40 if args[3] == authority else "2" * 40
                            entries.append(
                                f"100644 blob {blob}\t{changed_path}\n".encode()
                            )
                        return b"".join(entries)
                    if args[:1] == ("rev-parse",):
                        return ("e" * 40).encode()
                    return b""

                with (
                    patch.object(subject, "git", side_effect=observed),
                    patch.object(subject, "verify_invocation_authority"),
                    self.assertRaisesRegex(
                        subject.Refused, "authority differs from reviewed Main"
                    ),
                ):
                    subject.verify_git_authority(
                        candidate, base, authority, current=False
                    )

                tree_reads = [call for call in calls if call[0] == "ls-tree"]
                self.assertEqual(len(tree_reads), 2)
                for call in tree_reads:
                    covered = any(
                        changed_path == path
                        or changed_path.startswith(path.rstrip("/") + "/")
                        for path in call[5:]
                    )
                    self.assertTrue(
                        covered, f"{changed_path} is not in the authority tree"
                    )

    def test_protected_tip_and_serving_revision_cannot_change_after_approval(self):
        candidate, base = "a" * 40, "b" * 40
        api = SimpleNamespace(read=lambda _: {"protected": True, "commit": {"sha": candidate}})
        subject.require_protected_tip(api, candidate)
        for observed in ({"protected": False, "commit": {"sha": candidate}},
                         {"protected": True, "commit": {"sha": base}}):
            with self.assertRaises(subject.Refused):
                subject.require_protected_tip(SimpleNamespace(read=lambda _: observed), candidate)
        args = SimpleNamespace(environment="uat", scope="backend", sha=candidate, base_sha=base,
            backend_base_sha=base, frontend_base_sha="", authority_sha="c" * 40,
            ci_run_id=42, ci_attempt=1, predecessor=None)
        serving = {"backend": {"sha": base, "revision": "consent-protocol-old"}}
        with tempfile.TemporaryDirectory() as directory, patch.object(subject, "live_serving_bases", return_value=serving), \
             patch.object(subject, "verify_git_authority", return_value="d" * 40), \
             patch.object(subject, "verify_predecessor"):
            record = subject.issue_predecessor(args)
            args.predecessor = Path(directory) / "prior.json"
            args.predecessor.write_text(json.dumps(record))
            serving["backend"]["revision"] = "consent-protocol-replaced"
            with self.assertRaisesRegex(subject.Refused, "changed before mutation"):
                subject.issue_predecessor(args)

    def test_selected_services_must_match_the_ci_serving_base(self):
        base, other = "a" * 40, "b" * 40
        self.assertEqual(
            subject.verify_serving_bases(base, "all", base, base),
            {"backend": base, "frontend": base},
        )
        self.assertEqual(
            subject.verify_serving_bases(base, "frontend", other, base),
            {"frontend": base},
        )
        for backend, frontend in ((base, other), ("", base), (base, "")):
            with (
                self.subTest(backend=backend, frontend=frontend),
                self.assertRaises(subject.Refused),
            ):
                subject.verify_serving_bases(base, "all", backend, frontend)



class _AttemptAPI:
    def __init__(self, run, jobs, runs, check):
        self.run, self.jobs, self.runs, self.check = run, jobs, runs, check

    def read(self, path):
        if path == f"repos/{subject.REPOSITORY}":
            return {"id": 7, "full_name": subject.REPOSITORY}
        if path.endswith("/actions/workflows/ci.yml"):
            return {"id": 9, "path": ".github/workflows/ci.yml"}
        if path.endswith("/check-runs/10"):
            return self.check
        if "/attempts/1/jobs?" in path:
            return {"jobs": self.jobs, "total_count": len(self.jobs)}
        if "/workflows/ci.yml/runs?" in path:
            return {"workflow_runs": self.runs, "total_count": len(self.runs)}
        for item in self.runs:
            if path.endswith(f"/runs/{item['id']}") or f"/runs/{item['id']}/attempts/" in path:
                return item
        return self.run


class ExactUatAttemptTest(unittest.TestCase):
    def test_exact_attempt_requires_complete_current_run_and_canonical_gates(self):
        candidate, base = "a" * 40, "b" * 40
        run = _attempt_run(candidate)
        jobs = _attempt_jobs(candidate, base)
        exact = next(
            job
            for job in jobs
            if job["name"] in {"Exact UAT Candidate", f"Exact UAT Candidate ({base})"}
        )
        database = next(job for job in jobs if job["name"] == "Protocol Database (1/2)")
        runs = [run]
        check = {
            "name": "Branch Validation Gate",
            "head_sha": candidate,
            "status": "completed",
            "conclusion": "success",
            "app": {"id": 15368, "slug": "github-actions"},
            "check_suite": {"id": 77},
        }

        api = _AttemptAPI(run, jobs, runs, check)
        self.assertEqual(
            subject.verify_attempt(api, candidate, base, 123, 1)["run_attempt"], 1
        )
        exact["conclusion"] = "cancelled"
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        exact["conclusion"] = "success"
        database["head_sha"] = "c" * 40
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        database["head_sha"] = candidate
        database["conclusion"] = "skipped"
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        database["conclusion"] = "success"
        for bad_check in (
            {"id": 15368, "slug": "not-actions"},
            {"id": 1, "slug": "github-actions"},
        ):
            check["app"] = bad_check
            with self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)
        check["app"] = {"id": 15368, "slug": "github-actions"}
        check["check_suite"] = {"id": 78}
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        check["check_suite"] = {"id": 77}
        run["run_attempt"] = 2
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        run["run_attempt"] = 1
        runs.append(
            {
                **run,
                "id": 124,
                "conclusion": "failure",
                "run_started_at": "2026-10-28T00:01:00Z",
                "updated_at": "2026-10-28T00:01:10Z",
            }
        )
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        runs.pop()
        # A later rerun of an older run has a smaller run ID, but is still
        # the most recent attempt and must invalidate the old green result.
        runs.append(
            {
                **run,
                "id": 122,
                "run_attempt": 2,
                "conclusion": "failure",
                "run_started_at": "2026-10-28T00:02:00Z",
                "updated_at": "2026-10-28T00:02:10Z",
            }
        )
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        runs.pop()

    def test_static_name_and_historical_alias_are_exact_and_unique(self):
        candidate, base = "a" * 40, "b" * 40
        run = _attempt_run(candidate)
        runs = [run]
        check = {
            "name": "Branch Validation Gate",
            "head_sha": candidate,
            "status": "completed",
            "conclusion": "success",
            "app": {"id": 15368, "slug": "github-actions"},
            "check_suite": {"id": 77},
        }
        for exact_name in ("Exact UAT Candidate", f"Exact UAT Candidate ({base})"):
            jobs = _attempt_jobs(candidate, base, exact_name=exact_name)
            api = _AttemptAPI(run, jobs, runs, check)
            self.assertEqual(
                subject.verify_attempt(api, candidate, base, 123, 1)["run_attempt"],
                1,
            )

        jobs = _attempt_jobs(candidate, base, exact_name="Exact UAT Candidate")
        historical = next(
            job
            for job in _attempt_jobs(candidate, base)
            if job["name"] == f"Exact UAT Candidate ({base})"
        )
        jobs.append(historical)
        api = _AttemptAPI(run, jobs, runs, check)
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)


class ExactUatPartitionTest(unittest.TestCase):
    def test_full_targeted_coverage_preserves_partition(self):
        from web_ci_lane_fixture import ROOT, _run
        TARGETED = ROOT / "scripts/ci/web-targeted-check.sh"
        env = {"WEB_TARGETED_ALL_PACKS": "1", "WEB_TARGETED_FULL_SUITE_OWNED": "1",
               "WEB_TARGETED_CHANGED_FILES": "no/matching/path"}
        observed = {}
        for part, shard in (("all", ""), ("node", ""), *(('browser', f'{i}/4') for i in range(1, 5))):
            code, calls, output = _run(TARGETED, {**env, "WEB_TARGETED_PART": part,
                                                   "PLAYWRIGHT_SHARD": shard}, stub_diagrams=True)
            assert code == 0, output[-2000:]
            observed[(part, shard)] = calls
        all_calls, node = observed[("all", "")], observed[("node", "")]
        first = observed[("browser", "1/4")]
        assert node and first and sorted(node + first) == sorted(all_calls)
        assert not set(node) & set(first)
        for index in (2, 3, 4):
            other = observed[("browser", f"{index}/4")]
            assert sorted(other) == sorted(call for call in first if call not in {
                "scripts/verify-doc-diagrams.cjs", "scripts/render-doc-mermaid.mjs"})
        assert "scripts/observability/verify-android-scope.mjs" in node
        assert "scripts/testing/analytics-smoke-failure.test.mjs" in node
        code, calls, _ = _run(TARGETED, {"WEB_TARGETED_ALL_PACKS": "unexpected"})
        assert code == 2 and not calls


if __name__ == "__main__":
    unittest.main()
