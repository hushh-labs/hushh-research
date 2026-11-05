# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Verify PR scope and protected-source binding before shared UAT mutation."""

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import uat_exact_ci as subject
import uat_release_prerequisites as prerequisites
from uat_exact_ci_fixture import AttemptAPI, attempt_check, attempt_jobs, attempt_run


class ApprovedUatScopeTest(unittest.TestCase):
    def test_accumulated_pr_chain_checks_every_link_and_keeps_a_bound(self):
        for count in (11, 20):
            with self.subTest(count=count):
                base = "0" * 40
                prior, prior_tree = base, base
                prs, identities, terms = {}, {}, []
                for number in range(1, count + 1):
                    head, landed = f"{100 + number:040x}", f"{200 + number:040x}"
                    prs[number] = {"merged": True, "merge_commit_sha": landed,
                                   "head": {"sha": head}, "base": {"ref": "uat",
                                   "repo": {"full_name": subject.REPOSITORY}}}
                    identities.update({
                        ("rev-parse", f"{landed}^1"): prior,
                        ("merge-base", "--all", prior, head): prior,
                        ("rev-parse", f"{prior}^{{tree}}"): prior_tree,
                        ("rev-parse", f"{head}^{{tree}}"): head,
                        ("rev-parse", f"{landed}^{{tree}}"): head,
                    })
                    terms.append(f"{number}={head}")
                    prior, prior_tree = landed, head
                calls = []
                def read(path):
                    number = int(path.rsplit("/", 1)[1])
                    calls.append(number)
                    return prs[number]
                api = SimpleNamespace(read=read)
                approval = f"{base}:{base}:" + ",".join(terms)
                with patch.object(prerequisites, "git_identity", side_effect=lambda *args: identities[args]):
                    prerequisites.verify_approved_scope(api, landed, base, approval)
                    self.assertEqual(calls, list(range(1, count + 1)))
                    prs[count // 2]["head"]["sha"] = "f" * 40
                    with self.assertRaisesRegex(subject.Refused, "approved head"):
                        prerequisites.verify_approved_scope(api, landed, base, approval)
                if count == 20:
                    calls.clear()
                    with self.assertRaisesRegex(subject.Refused, "explicit candidate"):
                        prerequisites.verify_approved_scope(api, landed, base,
                                                           approval + ",21=" + "f" * 40)
                    self.assertEqual(calls, [])

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

    def test_isolated_branch_requires_its_own_protected_tip(self):
        candidate = "a" * 40
        paths = []
        def read(path):
            paths.append(path)
            return {"protected": path.endswith("/uat-isolated"), "commit": {"sha": candidate}}
        api = SimpleNamespace(read=read)
        subject.require_protected_tip(api, candidate, "uat-isolated")
        with self.assertRaises(subject.Refused):
            subject.require_protected_tip(api, candidate, "uat")
        with self.assertRaises(subject.Refused):
            subject.require_protected_tip(api, candidate, "dev")
        self.assertEqual(len(paths), 2)


class IsolatedQualificationTest(unittest.TestCase):
    def test_only_main_attempt_with_exact_app_tree_and_lane_checkouts_qualifies(self):
        app, base, authority, tree = (value * 40 for value in "abcd")
        run = attempt_run(authority)
        run.update(head_branch="main", display_title=f"Isolated UAT {app}")
        jobs = attempt_jobs(authority, base, "Exact UAT Candidate")
        prepared = {"name": "Prepare isolated UAT source", "conclusion": "success"}
        for job in jobs:
            job["steps"].insert(0, dict(prepared))
        exact = next(job for job in jobs if job["name"] == "Exact UAT Candidate")
        exact["steps"].append({"name": f"Verify isolated source ({app} {tree})", "conclusion": "success"})
        protocol = next(job for job in jobs if job["name"] == "Protocol (Python)")
        unrelated = {**run, "id": 456, "display_title": "main"}
        api = AttemptAPI(run, jobs, [run, unrelated], attempt_check(authority))
        with patch.object(subject, "application_tree", return_value=tree):
            args = (api, app, base, 123, 1)
            options = {"branch": "uat-isolated", "authority": authority}
            self.assertEqual(subject.verify_attempt(*args, **options)["run_id"], 123)
            protocol["steps"][0]["conclusion"] = "skipped"
            with self.assertRaisesRegex(subject.Refused, "did not prepare"):
                subject.verify_attempt(*args, **options)
            protocol["steps"][0].update(prepared)
            exact["steps"][-1]["name"] = f"Verify isolated source ({app} {base})"
            with self.assertRaisesRegex(subject.Refused, "exact isolated application tree"):
                subject.verify_attempt(*args, **options)
            exact["steps"][-1]["name"] = f"Verify isolated source ({app} {tree})"
            with self.assertRaises(subject.Refused):
                subject.verify_attempt(*args, branch="uat-isolated", authority=base)

    def test_rejects_isolated_release_recipe_drift(self):
        with patch.object(subject, "git", return_value=b"deploy/backend.cloudbuild.yaml"), patch.object(
            subject, "verify_invocation_authority"
        ) as invocations:
            with self.assertRaisesRegex(subject.Refused, "build or migration authority"):
                subject.verify_isolated_release_authority("a" * 40, "b" * 40)
            invocations.assert_not_called()

    def test_release_workflow_preserves_isolated_lane_bindings(self):
        import yaml

        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
        definition = yaml.safe_load(workflow.read_text())
        self.assertEqual(
            definition["run-name"],
            "${{ inputs.uat_candidate_sha && format('Isolated UAT {0}', inputs.uat_candidate_sha) || 'PR Validation' }}",
        )
        jobs = definition["jobs"]
        by_name = {job["name"]: job for job in jobs.values() if "name" in job}
        for name in subject.REQUIRED_JOBS - subject.AGGREGATE_JOBS:
            steps = by_name[name]["steps"]
            prepared = next(i for i, step in enumerate(steps) if step.get("name") == "Prepare isolated UAT source")
            self.assertEqual(prepared, 1, name)
            self.assertEqual(steps[0]["uses"], "actions/checkout@v6")
        self.assertIn("uat_candidate_sha", jobs["uat-exact-source"]["if"])
        self.assertIn("uat_candidate_sha", jobs["pr-base-policy"]["if"])


if __name__ == "__main__":
    unittest.main()
