"""Workflow and retention-reader boundaries for verify-current Production."""

from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path
import re
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy-production.yml"
SOURCE = Path(__file__).with_name("verify-current-production.py")
SPEC = importlib.util.spec_from_file_location("verify_current_production", SOURCE)
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)
maintenance = importlib.import_module("uat-retention-maintenance")


def _job_block(workflow: str, job_id: str) -> str:
    jobs = workflow.split("jobs:\n", 1)[1]
    match = re.search(
        rf"^  {re.escape(job_id)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
        jobs,
        flags=re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"workflow job missing: {job_id}")
    return match.group(0)


def _run(run_id: int, title: str) -> dict:
    return {
        "id": run_id,
        "run_attempt": 1,
        "display_title": title,
        "path": ".github/workflows/deploy-production.yml",
        "head_branch": "main",
        "status": "completed",
        "event": "workflow_dispatch",
        "repository": {"full_name": "hushh-labs/hushh-research"},
        "head_repository": {"full_name": "hushh-labs/hushh-research"},
    }


def _verification_jobs() -> dict:
    jobs = {
        "Validate Production dispatch mode": ("completed", "success"),
        "Verify current Production release": ("completed", "success"),
        "Deployment security": ("completed", "skipped"),
        "Deploy Production Scope": ("completed", "skipped"),
        "Stage qualified production Drive worker": ("completed", "skipped"),
        "Deploy Production Scope · Phone activation": ("completed", "skipped"),
        "Deploy Production Scope · Restoration activation": ("completed", "skipped"),
    }
    return {
        "total_count": len(jobs),
        "jobs": [
            {"name": name, "status": status, "conclusion": conclusion}
            for name, (status, conclusion) in jobs.items()
        ],
    }


class ProductionVerificationWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_verify_inputs_are_explicit_and_every_input_is_guarded(self):
        input_source = self.workflow.split("    inputs:\n", 1)[1].split("\npermissions:", 1)[0]
        declared = set(re.findall(r"^      ([a-z][a-z0-9_]*):$", input_source, re.MULTILINE))
        guarded = {"operation", "sha", *verify.VERIFY_DEFAULTS}
        self.assertEqual(declared, guarded)
        self.assertIn("default: deploy", input_source)
        self.assertIn('default: ""', input_source)
        validation = _job_block(self.workflow, "validate-dispatch")
        passed = set(re.findall(r"^          INPUT_([A-Z0-9_]+):", validation, re.MULTILINE))
        self.assertEqual(passed, {name.upper() for name in guarded})

    def test_verification_job_keeps_environment_gate_without_deployment_record(self):
        job = _job_block(self.workflow, "verify-current-production")
        self.assertIn("needs: validate-dispatch", job)
        self.assertIn("outputs.operation == 'verify_current'", job)
        self.assertRegex(job, r"environment:\n\s+name: production\n\s+deployment: false")
        self.assertRegex(job, r"permissions:\n\s+contents: read\n\s+id-token: write")
        for forbidden in (
            "upload-artifact", "tag-last-known-good", "gh release", "GITHUB_TOKEN",
            "GH_SECURITY_ALERTS_TOKEN", "gcloud run services update", "gcloud run revisions delete",
            "gcloud sql", "gcloud scheduler", "production_emergency.py",
        ):
            self.assertNotIn(forbidden, job)
        self.assertIn("ref: ${{ github.sha }}", job)
        self.assertIn("persist-credentials: false", job)
        self.assertRegex(job, r"id: backend-health\n\s+if: always\(\) && steps.before.outcome == 'success'")
        self.assertRegex(job, r"id: frontend-health\n\s+if: always\(\) && steps.before.outcome == 'success'")
        self.assertIn("https://api.hushh.ai /health 5 8 2 200", job)
        self.assertIn("https://one.hussh.ai / 3 8 2 200", job)
        self.assertNotIn("--location", job)

    def test_all_existing_security_and_mutating_jobs_are_deploy_only(self):
        for job_id in (
            "deployment-security", "deploy", "stage-drive-worker",
            "complete-phone-activation", "complete-restoration-activation",
        ):
            with self.subTest(job=job_id):
                block = _job_block(self.workflow, job_id)
                self.assertIn("needs.validate-dispatch.outputs.operation == 'deploy'", block)
                self.assertRegex(block, r"(?m)^    needs:.*validate-dispatch")
        self.assertIn("group: deploy-production", self.workflow)

    def test_retention_skips_only_a_proven_nonproducing_verifier_attempt(self):
        verification = _run(20, "VERIFY CURRENT PRODUCTION — read only")
        deploy = _run(10, "Deploy to Production")

        def lookup(_repo, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [verification, deploy]}
            self.assertEqual(endpoint, "runs/20/attempts/1/jobs?per_page=100")
            return _verification_jobs()

        with mock.patch.object(maintenance, "api", side_effect=lookup):
            self.assertEqual(
                maintenance.latest_deploy_observation("hushh-labs/hushh-research", "production"),
                10,
            )

    def test_retention_keeps_verification_titled_run_if_a_mutator_ran(self):
        verification = _run(20, "VERIFY CURRENT PRODUCTION — read only")
        deploy = _run(10, "Deploy to Production")
        jobs = _verification_jobs()
        target = next(row for row in jobs["jobs"] if row["name"] == "Deploy Production Scope")
        target["conclusion"] = "failure"

        def lookup(_repo, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [verification, deploy]}
            return jobs

        with mock.patch.object(maintenance, "api", side_effect=lookup):
            self.assertEqual(
                maintenance.latest_deploy_observation("hushh-labs/hushh-research", "production"),
                20,
            )

    def test_retention_fails_closed_on_incomplete_verifier_job_inventory(self):
        verification = _run(20, "VERIFY CURRENT PRODUCTION — read only")
        deploy = _run(10, "Deploy to Production")
        jobs = _verification_jobs()
        jobs["jobs"] = [row for row in jobs["jobs"] if row["name"] != "Deployment security"]
        jobs["total_count"] = len(jobs["jobs"])

        def lookup(_repo, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [verification, deploy]}
            return jobs

        with mock.patch.object(maintenance, "api", side_effect=lookup):
            with self.assertRaises(maintenance.retention.UnsafeState):
                maintenance.latest_deploy_observation("hushh-labs/hushh-research", "production")

    def test_retention_fails_closed_on_duplicate_job_name(self):
        verification = _run(20, "VERIFY CURRENT PRODUCTION — read only")
        deploy = _run(10, "Deploy to Production")
        jobs = _verification_jobs()
        jobs["jobs"].append(dict(jobs["jobs"][0]))
        jobs["total_count"] = len(jobs["jobs"])

        def lookup(_repo, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [verification, deploy]}
            return jobs

        with mock.patch.object(maintenance, "api", side_effect=lookup):
            with self.assertRaises(maintenance.retention.UnsafeState):
                maintenance.latest_deploy_observation("hushh-labs/hushh-research", "production")

    def test_retention_fails_closed_on_incomplete_page_count(self):
        verification = _run(20, "VERIFY CURRENT PRODUCTION — read only")
        deploy = _run(10, "Deploy to Production")
        jobs = _verification_jobs()
        jobs["total_count"] += 1

        def lookup(_repo, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [verification, deploy]}
            return jobs

        with mock.patch.object(maintenance, "api", side_effect=lookup):
            with self.assertRaises(maintenance.retention.UnsafeState):
                maintenance.latest_deploy_observation("hushh-labs/hushh-research", "production")

    def test_retention_fails_closed_on_unrecognized_job_name(self):
        verification = _run(20, "VERIFY CURRENT PRODUCTION — read only")
        deploy = _run(10, "Deploy to Production")
        jobs = _verification_jobs()
        jobs["jobs"].append({"name": "New unreviewed producer", "status": "completed", "conclusion": "skipped"})
        jobs["total_count"] += 1

        def lookup(_repo, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": [verification, deploy]}
            return jobs

        with mock.patch.object(maintenance, "api", side_effect=lookup):
            with self.assertRaises(maintenance.retention.UnsafeState):
                maintenance.latest_deploy_observation("hushh-labs/hushh-research", "production")


if __name__ == "__main__":
    unittest.main()
