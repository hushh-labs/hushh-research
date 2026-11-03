#!/usr/bin/env python3
"""Fail closed when direct-UAT evidence changes or belongs to another source."""

import json
import os
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import promotion_approval as promotion
import uat_exact_ci as subject
import uat_release_prerequisites as prerequisites
from uat_exact_ci_fixture import (
    AttemptAPI as _AttemptAPI,
    attempt_jobs as _attempt_jobs,
    attempt_check as _attempt_check,
    attempt_run as _attempt_run,
)






class ApprovedUatScopeTest(unittest.TestCase):
    def test_landed_tree_must_be_the_reviewed_pr_delta_and_live_bases_must_match(self):
        base, head, landed, extra = (letter * 40 for letter in "abcd")
        pr = {"merged": True, "merge_commit_sha": landed, "head": {"sha": head},
              "base": {"ref": "uat", "repo": {"full_name": subject.REPOSITORY}}}
        api = SimpleNamespace(read=lambda path: pr)
        approval = f"{base}:{base}:42={head}"
        serving = {"backend": {"sha": base}, "frontend": {"sha": base}}
        identities = {
            ("rev-parse", f"{landed}^1"): base,
            ("merge-base", "--all", base, head): base,
            ("rev-parse", f"{base}^{{tree}}"): base,
            ("rev-parse", f"{head}^{{tree}}"): head,
            ("rev-parse", f"{landed}^{{tree}}"): head,
        }
        with patch.object(prerequisites, "git_identity", side_effect=lambda *args: identities[args]):
            prerequisites.verify_approved_scope(api, landed, base, approval,
                                                read_live=lambda scope: serving)
            with self.assertRaisesRegex(subject.Refused, "explicit candidate"):
                prerequisites.verify_approved_scope(api, landed, base, "")
            with self.assertRaisesRegex(subject.Refused, "approved head"):
                prerequisites.verify_approved_scope(api, landed, base, f"{base}:{base}:42={extra}")
            serving["frontend"]["sha"] = extra
            with self.assertRaisesRegex(subject.Refused, "serving revisions changed"):
                prerequisites.verify_approved_scope(api, landed, base, approval,
                                                    read_live=lambda scope: serving)
            identities["rev-parse", f"{landed}^{{tree}}"] = extra
            with self.assertRaisesRegex(subject.Refused, "outside the approved PR"):
                prerequisites.verify_approved_scope(api, landed, base, approval)


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



class ApplicationSourceAdmissionTest(unittest.TestCase):
    def test_new_uat_selection_requires_protected_uat_membership(self):
        application = "a" * 40

        def protected_uat_member(*args):
            if args == ("merge-base", application, "origin/uat"):
                return application
            raise AssertionError("UAT selection must use protected UAT history")

        self.assertEqual(
            promotion.uat_source(application, resolve=protected_uat_member),
            ("uat", "CI Status Gate,Queue Validation,Branch Validation Gate"),
        )

    def test_main_alias_passes_only_when_the_sha_is_also_in_uat(self):
        application = "b" * 40

        def shared_main_uat_member(*args):
            if args in {
                ("merge-base", application, "origin/main"),
                ("merge-base", application, "origin/uat"),
            }:
                return application
            raise AssertionError("Selection must bind to protected UAT membership")

        self.assertEqual(
            promotion.uat_source(application, resolve=shared_main_uat_member)[0],
            "uat",
        )

    def test_main_only_or_arbitrary_sha_is_not_a_new_uat_source(self):
        application = "c" * 40

        def main_only(*args):
            if args == ("merge-base", application, "origin/main"):
                return application
            if args == ("merge-base", application, "origin/uat"):
                return "0" * 40
            raise AssertionError("Main membership cannot authorize a UAT dispatch")

        with self.assertRaisesRegex(ValueError, "not in protected UAT history"):
            promotion.uat_source(application, resolve=main_only)

    def test_dev_normal_dispatch_checks_dev_membership_and_preserves_pod_source(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/deploy-dev.yml").read_text()
        normal_gate = workflow.split(
            "- name: Validate deployment SHA in protected Dev history", 1
        )[1].split("\n      - name:", 1)[0]
        pod_gate_section = workflow.split(
            "- name: Verify exact pod source CI and ref", 1
        )[1]
        pod_gate = pod_gate_section.split("\n      - name:", 1)[0]

        self.assertIn("REQUIRED_BRANCH: dev", normal_gate)
        self.assertNotIn("steps.resolve-sha.outputs.ref", normal_gate)
        self.assertIn("REQUIRED_BRANCH: ${{ inputs.ref }}", pod_gate)
        self.assertIn("Application lookup ref", workflow)
        self.assertIn(
            "run-name: Dev · ${{ inputs.target || 'shared-dev' }} · app ${{ inputs.sha || 'protected Dev tip' }} · ref ${{ inputs.ref || 'dev' }}",
            workflow,
        )
        self.assertIn("Source authority: protected \\`dev\\` history", workflow)

    def test_dev_membership_accepts_a_main_alias_only_for_a_dev_member_sha(self):
        root = Path(__file__).resolve().parents[2]
        helper = root / "scripts/ci/require-deploy-sha-on-main.sh"
        application = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            fake_bin = Path(directory)
            fake_git = fake_bin / "git"
            fake_git.write_text(
                "#!/bin/sh\n"
                'case "$1" in\n'
                "  fetch|cat-file) exit 0 ;;\n"
                '  merge-base) exit "${DEV_MEMBERSHIP_EXIT:-0}" ;;\n'
                "esac\n"
                "exit 0\n"
            )
            fake_git.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
                "REQUIRED_BRANCH": "dev",
                "REQUIRE_CI_SUCCESS": "0",
            }
            member = subprocess.run(
                ["bash", str(helper), application],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(member.returncode, 0, member.stderr)
            environment["DEV_MEMBERSHIP_EXIT"] = "1"
            outside = subprocess.run(
                ["bash", str(helper), "b" * 40],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(outside.returncode, 0)

    def test_explicit_uat_sha_is_checked_before_selection_completes(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/deploy-uat.yml").read_text()
        selection = workflow.split('      - name: Resolve deployment SHA', 1)[1]
        selection = selection.split('echo "sha=$REQUESTED_SHA"', 1)[0]

        checkout = workflow.split("- name: Checkout code", 1)[1].split(
            "\n      - name:", 1
        )[0]
        self.assertIn("fetch-depth: 0", checkout)
        self.assertIn("promotion_approval.py uat", selection)
        self.assertIn(
            "run-name: UAT · app ${{ inputs.sha || 'unselected' }}",
            workflow,
        )
        self.assertIn('--application-sha "$REQUESTED_SHA"', selection)
        self.assertIn(
            "Source authority: \\`${{ steps.application-authority.outputs.branch }}\\`",
            workflow,
        )


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
        check = _attempt_check(candidate)

        api = _AttemptAPI(run, jobs, runs, check)
        self.assertEqual(
            subject.verify_attempt(api, candidate, base, 123, 1)["run_attempt"], 1
        )
        self._assert_clock_anomaly_requires_single_run(api, candidate, base, run, runs)
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, "d" * 40, 123, 1)
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
        self._assert_inventory_attempt_advancement_refuses(api, candidate, base, run, runs)
        self._assert_later_failed_runs_refuse(api, candidate, base, run, runs)

    def _assert_inventory_attempt_advancement_refuses(self, api, candidate, base, run, runs):
        runs[:] = [{**run, "run_attempt": 2}]
        read = api.read

        def stale_run_endpoint(path):
            if path.endswith("/actions/runs/123"):
                return dict(run)
            return read(path)

        with patch.object(api, "read", side_effect=stale_run_endpoint):
            for current in (True, False):
                with self.assertRaises(subject.Refused):
                    subject.verify_attempt(api, candidate, base, 123, 1, current=current)
        runs[:] = [run]

    def _assert_clock_anomaly_requires_single_run(self, api, candidate, base, run, runs):
        started, updated = run["run_started_at"], run["updated_at"]
        run.update(run_started_at="2026-11-01T09:36:17Z", updated_at="2026-11-01T09:10:39Z")
        self.assertEqual(subject.verify_attempt(api, candidate, base, 123, 1)["run_attempt"], 1)
        read = api.read

        def incomplete_inventory(path):
            result = read(path)
            if "/workflows/ci.yml/runs?" in path:
                return {**result, "total_count": 2}
            return result

        with patch.object(api, "read", side_effect=incomplete_inventory):
            with self.assertRaisesRegex(subject.Refused, "run inventory is incomplete"):
                subject.verify_attempt(api, candidate, base, 123, 1)
        for inventory in ([], [{**run, "id": 124}]):
            runs[:] = inventory
            with self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)
        runs[:] = [run]
        runs.append({**run, "id": 122, "run_started_at": started, "updated_at": updated})
        with self.assertRaisesRegex(subject.Refused, "CI chronology is invalid"):
            subject.verify_attempt(api, candidate, base, 123, 1)
        runs.pop()
        run.update(run_started_at=started, updated_at=updated)

    def _assert_later_failed_runs_refuse(self, api, candidate, base, run, runs):
        for status, conclusion in (("completed", "failure"), ("queued", None)):
            runs.append(
                {
                    **run,
                    "id": 124,
                    "status": status,
                    "conclusion": conclusion,
                    "run_started_at": "2026-10-28T00:01:00Z",
                    "updated_at": "2026-10-28T00:01:10Z",
                }
            )
            with self.subTest(status=status), self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)
            runs.pop()
        # A rerun with a smaller ID is still the most recent attempt.
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

    def test_historical_predecessor_keeps_pinned_integrity_without_electing_other_runs(self):
        candidate, base, tree = "a" * 40, "b" * 40, "e" * 40
        run = _attempt_run(candidate)
        runs = [run]
        api = _AttemptAPI(run, _attempt_jobs(candidate, base), runs, _attempt_check(candidate))
        prior = {"sha": candidate, "base_sha": base, "authority_sha": "c" * 40,
                 "tree": tree, "run_id": 123, "run_attempt": 1}
        with patch.object(subject, "GitHub", return_value=api), \
             patch.object(subject, "verify_git_authority", return_value=tree):
            for status in ("queued", "failure", "success"):
                runs[:] = [run, {**run, "id": 124, "status": "queued" if status == "queued" else "completed",
                                 "conclusion": None if status == "queued" else status,
                                 "run_started_at": "2026-10-28T00:01:00Z", "updated_at": "2026-10-28T00:01:10Z"}]
                subject.verify_predecessor(prior, current=False)
                with self.assertRaises(subject.Refused):
                    subject.verify_attempt(api, candidate, base, 123, 1)
            runs[:] = [{**run, "run_attempt": 2}]
            with self.assertRaises(subject.Refused):
                subject.verify_predecessor(prior, current=False)
            runs.clear()
            with self.assertRaises(subject.Refused):
                subject.verify_predecessor(prior, current=False)
            runs[:] = [run]
            run["conclusion"] = "failure"
            with self.assertRaises(subject.Refused):
                subject.verify_predecessor(prior, current=False)

    def test_static_name_requires_ordered_base_binding_and_dynamic_alias_is_compatible(self):
        candidate, base = "a" * 40, "b" * 40
        run = _attempt_run(candidate)
        runs = [run]
        check = _attempt_check(candidate)
        for exact_name in ("Exact UAT Candidate", f"Exact UAT Candidate ({base})"):
            jobs = _attempt_jobs(candidate, base, exact_name=exact_name)
            api = _AttemptAPI(run, jobs, runs, check)
            for current in (True, False):
                self.assertEqual(
                    subject.verify_attempt(api, candidate, base, 123, 1, current=current)[
                        "run_attempt"
                    ],
                    1,
                )

        unbound = _attempt_jobs(
            candidate, base, exact_name="Exact UAT Candidate", bind_static_base=False
        )
        api = _AttemptAPI(run, unbound, runs, check)
        for current in (True, False):
            with self.subTest(binding="missing", current=current), self.assertRaises(
                subject.Refused
            ):
                subject.verify_attempt(api, candidate, base, 123, 1, current=current)

        # Retained pre-policy receipts keep their old immutable inventory;
        # that exception cannot authorize a new current qualification.
        legacy_job = next(job for job in unbound if job["name"] == "Exact UAT Candidate")
        self.assertIs(
            subject._exact_candidate_job([legacy_job], base, allow_legacy_static=True),
            legacy_job,
        )

        for mutation in ("wrong_base", "duplicate", "late", "failed"):
            jobs = _attempt_jobs(candidate, base, exact_name="Exact UAT Candidate")
            exact = next(job for job in jobs if job["name"] == "Exact UAT Candidate")
            bound = next(
                step
                for step in exact["steps"]
                if step["name"] == f"Verify exact serving base ({base})"
            )
            if mutation == "wrong_base":
                bound["name"] = f"Verify exact serving base ({'d' * 40})"
            elif mutation == "duplicate":
                exact["steps"].append(dict(bound))
            elif mutation == "late":
                exact["steps"].remove(bound)
                exact["steps"].append(bound)
            else:
                bound["conclusion"] = "failure"
            api = _AttemptAPI(run, jobs, runs, check)
            with self.subTest(binding=mutation), self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)

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
