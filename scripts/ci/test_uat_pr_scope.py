# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Verify PR scope and protected-source binding before shared UAT mutation."""

from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import uat_exact_ci as subject
import uat_release_prerequisites as prerequisites
from uat_exact_ci_fixture import AttemptAPI, attempt_check, attempt_jobs, attempt_run


class ApprovedUatScopeTest(unittest.TestCase):
    def test_ci_ready_inspection_still_requires_explicit_scope_approval(self):
        report = prerequisites.render({"ready": True, "candidate_sha": "a" * 40,
            "base_sha": "b" * 40, "authority_sha": "c" * 40,
            "ci_run_id": 123, "ci_run_attempt": 2})
        self.assertIn("approved_scope=BACKEND:FRONTEND:PR=HEAD", report)
        self.assertIn("CI success does not select or approve this delta", report)
        self.assertIn("Inspection grants no deployment authority", report)

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
            with patch.object(subject, "git", return_value=b""), self.assertRaisesRegex(
                subject.Refused, "outside the approved PR"
            ):
                prerequisites.verify_approved_scope(api, landed, base, approval)

    def test_combined_scope_binds_the_clean_merge_to_the_queue_check_at_landing(self):
        with tempfile.TemporaryDirectory() as root:
            def git(*args):
                return subprocess.check_output(["git", "-C", root, *args], stderr=subprocess.DEVNULL)

            def revision():
                return git("rev-parse", "HEAD").decode().strip()

            def add(name):
                (Path(root) / name).write_text(name)
                git("add", name)
                git("commit", "-qm", name)
                return revision()

            git("init", "-q")
            git("config", "user.name", "Scope Fixture")
            git("config", "user.email", "scope@example.invalid")
            common = add("baseline")
            head = add("reviewed-change")
            git("checkout", "--detach", common)
            prior = add("previously-approved-change")
            git("merge", "--no-ff", "-m", "Combined result", head)
            landed = revision()
            repo = subject.REPOSITORY
            root_path = f"repos/{repo}"
            actions = f"{root_path}/actions"
            path = ".github/workflows/queue-validation.yml"
            workflow = f"{actions}/workflows/queue-validation.yml"
            identity = {"full_name": repo}
            merged_at = "2026-11-05T13:18:46Z"
            pr = {"merged": True, "merge_commit_sha": landed, "merged_at": merged_at,
                  "head": {"sha": head}, "base": {"ref": "uat", "repo": identity}}
            run = {"id": 123, "run_attempt": 1, "workflow_id": 456, "path": path,
                   "event": "merge_group", "head_sha": landed, "status": "completed",
                   "head_branch": f"gh-readonly-queue/uat/pr-42-{prior}", "conclusion": "success",
                   "repository": identity, "head_repository": identity, "check_suite_id": 789}
            gate = {"name": "CI Status Gate", "run_id": 123, "run_attempt": 1,
                    "head_sha": landed, "status": "completed", "conclusion": "success",
                    "completed_at": "2026-11-05T13:18:35Z",
                    "steps": [{"name": "Recheck membership, review and validation attempts",
                               "conclusion": "success"}],
                    "check_run_url": f"https://api.github.com/{root_path}/check-runs/321"}
            check = {"name": "CI Status Gate", "head_sha": landed, "status": "completed",
                     "conclusion": "success", "check_suite": {"id": 789},
                     "app": {"id": 15368, "slug": "github-actions"}}
            latest = dict(run)
            responses = {
                f"{root_path}/pulls/42": pr,
                workflow: {"path": path, "id": 456},
                f"{workflow}/runs?event=merge_group&head_sha={landed}&per_page=100":
                    {"workflow_runs": [run], "total_count": 1},
                f"{actions}/runs/123/attempts/1/jobs?per_page=100": {"jobs": [gate], "total_count": 1},
                f"{root_path}/check-runs/321": check,
                f"{actions}/runs/123": latest,
            }
            api = SimpleNamespace(read=responses.__getitem__)
            approval = f"{prior}:{prior}:42={head}"
            with patch.object(subject, "git", side_effect=git):
                prerequisites.verify_approved_scope(api, landed, prior, approval)
                for row, key, value, error in (
                    (run, "head_branch", "gh-readonly-queue/dev/pr-42", "approved parents"),
                    (gate, "completed_at", "2026-11-05T13:19:00Z", "did not verify"),
                    (check, "check_suite", {"id": 999}, "does not match"),
                    (latest, "run_attempt", 2, "changed during scope"),
                ):
                    with self.subTest(key=key), patch.dict(row, {key: value}):
                        with self.assertRaisesRegex(subject.Refused, error):
                            prerequisites.verify_approved_scope(api, landed, prior, approval)
                queue_runs = f"{workflow}/runs?event=merge_group&head_sha={landed}&per_page=100"
                with patch.dict(responses, {queue_runs: {"workflow_runs": [], "total_count": 0}}), patch.object(
                    prerequisites, "latest_attempt", return_value={"id": 456, "run_attempt": 2}
                ) as latest_release, patch.object(subject, "verify_attempt") as verify_release:
                    prerequisites.verify_approved_scope(api, landed, prior, approval)
                    latest_release.assert_called_once_with(api, landed, "uat")
                    verify_release.assert_called_once_with(api, landed, prior, 456, 2, branch="uat")
                    verify_release.side_effect = subject.Refused("Wrong qualification base")
                    with self.assertRaisesRegex(subject.Refused, "Wrong qualification base"):
                        prerequisites.verify_approved_scope(api, landed, prior, approval)
                    latest_release.return_value = {}
                    with self.assertRaisesRegex(subject.Refused, "requires exact release qualification"):
                        prerequisites.verify_approved_scope(api, landed, prior, approval)
                add("unreviewed-change")
                tree = git("rev-parse", "HEAD^{tree}").decode().strip()
                changed = git("commit-tree", tree, "-p", prior, "-p", head, "-m", "Changed merge")
                pr["merge_commit_sha"] = changed.decode().strip()
                with self.assertRaisesRegex(subject.Refused, "outside the approved PR"):
                    prerequisites.verify_approved_scope(api, pr["merge_commit_sha"], prior, approval)

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
