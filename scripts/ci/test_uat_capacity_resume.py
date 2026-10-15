#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Security-boundary tests for exact-target, one-shot UAT capacity recovery."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "uat_capacity_resume_tested", ROOT / "scripts/ci/uat-capacity-resume.py"
)
assert spec is not None and spec.loader is not None
resume = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = resume
spec.loader.exec_module(resume)

TARGET = "a" * 40
NEWER = "b" * 40
DISPATCH = "c" * 40
SCOPE = "backend"


def workflow_run(run_id: int = 123, *, attempt: int = 1, sha: str = DISPATCH) -> dict:
    return {
        "id": run_id,
        "path": resume.DEPLOY_WORKFLOW,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "head_sha": sha,
        "repository": {"full_name": resume.REPOSITORY},
        "head_repository": {"full_name": resume.REPOSITORY},
        "actor": {"login": "ankitkumarsingh1702"},
        "run_attempt": attempt,
        "created_at": "2026-10-15T01:00:00Z",
        "status": "completed",
        "conclusion": "failure",
    }


def receipt(kind: str, *, run_id: int = 123, selected_sha: str = TARGET) -> dict:
    value = {
        "version": 1,
        "kind": kind,
        "repository": resume.REPOSITORY,
        "workflow": resume.DEPLOY_WORKFLOW,
        "run_id": run_id,
        "run_attempt": 1,
        "actor": "ankitkumarsingh1702",
        "dispatch_sha": DISPATCH,
        "request_sha": TARGET,
        "selected_sha": selected_sha,
        "requested_scope": SCOPE,
    }
    if kind == "deferred":
        value.update(
            resolved_scope=SCOPE,
            outcome="DEFERRED_CAPACITY",
            budget_kind="projected_worst_case_not_live_sessions",
            projected_connections=804,
            admission_limit=800,
            observed_sql_sessions=None,
            next_eligible_drain_time=None,
        )
    return value


def job(name: str, conclusion: str, steps: list[tuple[str, str]]) -> dict:
    return {
        "id": 456,
        "name": name,
        "status": "completed",
        "conclusion": conclusion,
        "run_attempt": 1,
        "steps": [{"name": label, "conclusion": outcome} for label, outcome in steps],
    }


class ReceiptTests(unittest.TestCase):
    def test_receipt_binds_selected_target_not_workflow_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            event = Path(temporary) / "event.json"
            output = Path(temporary) / "receipt.json"
            event.write_text(json.dumps({"inputs": {"sha": TARGET, "scope": SCOPE}}))
            variables = {
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_REPOSITORY": resume.REPOSITORY,
                "GITHUB_WORKFLOW_REF": f"{resume.REPOSITORY}/{resume.DEPLOY_WORKFLOW}@refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF_NAME": "main",
                "GITHUB_RUN_ID": "123",
                "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_ACTOR": "ankitkumarsingh1702",
                "GITHUB_SHA": DISPATCH,
            }
            with patch.dict(os.environ, variables):
                resume.write_receipt(
                    "deferred", TARGET, SCOPE, output,
                    resolved_scope=SCOPE,
                    projected_connections=804,
                    admission_limit=800,
                    next_eligible_drain_time="2026-10-15T02:00:00Z",
                )
                saved = json.loads(output.read_text())
                self.assertEqual(saved["selected_sha"], TARGET)
                self.assertEqual(saved["dispatch_sha"], DISPATCH)
                self.assertEqual(saved["outcome"], "DEFERRED_CAPACITY")
                self.assertEqual(saved["budget_kind"], "projected_worst_case_not_live_sessions")
                self.assertEqual(saved["projected_connections"], 804)
                self.assertEqual(saved["admission_limit"], 800)
                self.assertIsNone(saved["observed_sql_sessions"])
                self.assertEqual(saved["next_eligible_drain_time"], "2026-10-15T02:00:00Z")
                with self.assertRaisesRegex(resume.UnsafeResume, "explicit request"):
                    resume.write_receipt("target", NEWER, SCOPE, output)

    def test_mismatched_or_missing_receipts_cannot_authorize_retry(self) -> None:
        run = workflow_run()
        with patch.object(resume, "read_receipt", side_effect=[receipt("target"), receipt("deferred", selected_sha=NEWER)]):
            with self.assertRaisesRegex(resume.UnsafeResume, "explicit request"):
                resume.matching_receipts(run)
        with patch.object(resume, "read_receipt", side_effect=[receipt("target"), None]):
            self.assertIsNone(resume.matching_receipts(run))


class AuthorityTests(unittest.TestCase):
    def test_only_wait_capacity_failure_with_skipped_deploy_is_eligible(self) -> None:
        run = workflow_run()
        selected = job("Select UAT target", "success", [("Save selected UAT target", "success")])
        waiting = job(
            "Wait for UAT capacity outside the mutation lock", "failure",
            [("Wait for scope-aware UAT capacity", "failure"),
             ("Save exact capacity deferral evidence", "success")],
        )
        deploy = job("Deploy UAT Scope", "skipped", [])
        jobs = {item["name"]: item for item in (selected, waiting, deploy)}
        with patch.object(resume, "jobs_for", return_value=jobs), patch.object(
            resume, "matching_receipts", return_value=(receipt("target"), receipt("deferred"))
        ):
            self.assertEqual(resume.verify_deferred_failure(run)["selected_sha"], TARGET)
            waiting["steps"].append({"name": "Authenticate for read-only UAT capacity inventory", "conclusion": "failure"})
            with self.assertRaisesRegex(resume.UnsafeResume, "another failure"):
                resume.verify_deferred_failure(run)
            waiting["steps"].pop()
            deploy["conclusion"] = "failure"
            with self.assertRaisesRegex(resume.UnsafeResume, "solely in the capacity wait"):
                resume.verify_deferred_failure(run)

    def test_second_attempt_cannot_be_auto_resumed_again(self) -> None:
        run = workflow_run(attempt=2)
        with self.assertRaisesRegex(resume.UnsafeResume, "first-attempt"):
            resume.verify_deferred_failure(run)

    def test_newer_selected_target_blocks_older_retry_even_when_workflow_head_is_same(self) -> None:
        original = workflow_run()
        newer = workflow_run(124, sha=DISPATCH)
        newer["created_at"] = "2026-10-15T01:01:00Z"
        with patch.object(resume, "recent_runs", side_effect=[[original, newer], []]), patch.object(
            resume, "receipt_for", return_value=receipt("target", run_id=124, selected_sha=NEWER)
        ), patch.object(resume, "ancestor", return_value=True) as ancestry:
            with self.assertRaisesRegex(resume.UnsafeResume, "selected target supersedes"):
                resume.no_superseding_run(original, TARGET)
            ancestry.assert_called_once_with(TARGET, NEWER)

    def test_newer_run_without_selected_target_fails_closed(self) -> None:
        original = workflow_run()
        newer = workflow_run(124)
        newer["created_at"] = "2026-10-15T01:01:00Z"
        with patch.object(resume, "recent_runs", side_effect=[[original, newer], []]), patch.object(
            resume, "receipt_for", return_value=None
        ):
            with self.assertRaisesRegex(resume.UnsafeResume, "target is unknown"):
                resume.no_superseding_run(original, TARGET)

    def test_rerun_guard_rejects_a_changed_target_before_cloud_auth(self) -> None:
        run = workflow_run(attempt=2)
        with patch.object(resume, "run_identity", return_value={
            "run_id": 123, "run_attempt": 2,
            "actor": "ankitkumarsingh1702", "dispatch_sha": DISPATCH,
        }), patch.object(resume, "api", return_value=run), patch.object(
            resume, "matching_receipts", return_value=(receipt("target"), receipt("deferred"))
        ):
            with self.assertRaisesRegex(resume.UnsafeResume, "changed the original target"):
                resume.verify_original_on_rerun(NEWER, SCOPE, False)

    def test_controller_never_posts_when_capacity_remains_blocked(self) -> None:
        original = workflow_run()
        with patch.object(resume, "verify_maintenance", return_value=True), patch.object(
            resume, "recent_runs", return_value=[original]
        ), patch.object(resume, "artifact", return_value={"id": 8}), patch.object(
            resume, "verify_deferred_failure", return_value=receipt("deferred")
        ), patch.object(resume, "no_superseding_run"), patch.object(
            resume, "check_live_capacity", side_effect=resume.CapacityUnavailable("still blocked")
        ), patch.object(resume, "command") as post:
            self.assertIn("still over", resume.resume_after_maintenance(77, apply=True))
            post.assert_not_called()

    def test_controller_posts_only_wait_job_after_revalidation(self) -> None:
        original = workflow_run()
        waiting = job("Wait for UAT capacity outside the mutation lock", "failure", [])
        with patch.object(resume, "verify_maintenance", return_value=True), patch.object(
            resume, "recent_runs", return_value=[original]
        ), patch.object(resume, "artifact", return_value={"id": 8}), patch.object(
            resume, "verify_deferred_failure", return_value=receipt("deferred")
        ) as verified, patch.object(resume, "no_superseding_run"), patch.object(
            resume, "check_live_capacity"
        ), patch.object(resume, "api", return_value=original), patch.object(
            resume, "jobs_for", return_value={waiting["name"]: waiting}
        ), patch.object(resume, "command") as post:
            result = resume.resume_after_maintenance(77, apply=True)
            self.assertIn("RESUMED", result)
            self.assertEqual(verified.call_count, 2)
            post.assert_called_once_with(
                "gh", "api", "-X", "POST",
                f"repos/{resume.REPOSITORY}/actions/jobs/{waiting['id']}/rerun",
            )


class WorkflowTests(unittest.TestCase):
    def test_actions_write_is_confined_to_flagged_resume_job(self) -> None:
        source = (ROOT / ".github/workflows/resume-uat-capacity.yml").read_text()
        inspect, retry = source.split("  resume:\n", 1)
        self.assertNotIn("actions: write", inspect)
        self.assertIn("actions: write", retry)
        self.assertIn("vars.UAT_CAPACITY_AUTO_RESUME_ENABLED == 'true'", retry)
        self.assertIn("--apply", retry)
        self.assertNotIn("gcloud run revisions delete", source)


if __name__ == "__main__":
    unittest.main()
