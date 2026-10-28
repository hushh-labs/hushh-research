#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Read-only GitHub release observation and notification regressions."""
import unittest
import importlib.util
import json
import os
import sys
import tempfile
import re
import shutil
import subprocess
from pathlib import Path
from copy import deepcopy
from datetime import UTC, datetime
from unittest.mock import patch
from test_release_cadence import REPOSITORY, NEW_POLICY, GOVERNANCE, FakeLedger, counted, run, core, github, monitor, testflight


class MonitorTest(unittest.TestCase):
    def test_disabled_cli_reports_certified_history_without_advancing_work(self):
        policy = {**NEW_POLICY, "enabled": False}
        ledger = FakeLedger(counted(10))
        checkpoint = {"ledger_sha": "f" * 40, "state_sha256": core.state_digest(ledger.state),
                      "checkpoint_at": "2026-10-22T09:14:34Z"}
        before = deepcopy(ledger.state)
        controller = run(100, core.CONTROLLER)
        spec = importlib.util.spec_from_file_location("cadence_cli", Path(__file__).with_name("release-cadence.py"))
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory, "event.json")
            event.write_text("{}")
            with patch.dict(os.environ, {"GITHUB_REPOSITORY": REPOSITORY, "GITHUB_RUN_ID": "100",
                                         "GITHUB_EVENT_PATH": str(event), "RUNNER_TEMP": directory}), \
                    patch.object(sys, "argv", ["release-cadence.py", "reconcile"]), \
                    patch.object(cli, "configuration", return_value=(policy, GOVERNANCE)), \
                    patch.object(github, "configuration", return_value=(policy, GOVERNANCE)), \
                    patch.object(github, "run_info", return_value=controller), \
                    patch.object(github, "Ledger", return_value=ledger), \
                    patch.object(ledger, "verify_checkpoint", return_value=checkpoint), \
                    patch.object(ledger, "save") as save, \
                    patch.object(cli, "reconcile") as reconcile, \
                    patch.object(github, "dispatch_pending") as dispatch:
                self.assertEqual(cli.main(), 0)
                snapshot = json.loads(Path(directory, "release-cadence-monitor.json").read_text())
                self.assertEqual(snapshot, {"mode": "disabled", "state": before, "checkpoint": checkpoint})
                save.assert_not_called()
                reconcile.assert_not_called()
                dispatch.assert_not_called()
                with patch.object(ledger, "verify_checkpoint", side_effect=core.UnsafeRelease("checkpoint mismatch")):
                    with self.assertRaisesRegex(core.UnsafeRelease, "checkpoint mismatch"):
                        cli.main()
        self.assertEqual(ledger.state, before)

    def test_skipped_publication_is_healthy_only_for_a_verified_disabled_snapshot(self):
        state = counted(2)
        snapshot = {"mode": "disabled", "state": state,
                    "checkpoint": {"state_sha256": core.state_digest(state), "checkpoint_at": "2026-10-22T09:14:34Z"}}
        policy = {**NEW_POLICY, "enabled": False, "monitor_issue_assignee": "maintainer"}
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory, "event.json")
            event.write_text("{}")
            path = Path(directory, "release-cadence-monitor.json")
            path.write_text(json.dumps(snapshot))
            env = {"GITHUB_REPOSITORY": REPOSITORY, "GITHUB_RUN_ID": "100", "GITHUB_REF_NAME": "main",
                   "GITHUB_EVENT_PATH": str(event), "RUNNER_TEMP": directory,
                   "ACCOUNTING_OUTCOME": "success", "CHECKPOINT_PRESENCE_OUTCOME": "success",
                   "CHECKPOINT_PRESENT": "false", "CHECKPOINT_OUTCOME": "skipped"}
            with patch.dict(os.environ, env), \
                    patch.object(monitor, "run_info", return_value=run(100, core.CONTROLLER)), \
                    patch.object(monitor, "configuration", return_value=(policy, GOVERNANCE)), \
                    patch.object(monitor, "find_issue", return_value=None), \
                    patch.object(monitor, "observations", return_value=({}, [])) as observations, \
                    patch.object(monitor, "publish") as publish:
                self.assertEqual(monitor.main(), 0)
                self.assertTrue(observations.call_args.args[4])
                publish.reset_mock()
                with patch.dict(os.environ, {"ACCOUNTING_OUTCOME": "failure"}):
                    with self.assertRaisesRegex(core.UnsafeRelease, "not verified"):
                        monitor.main()
                    self.assertFalse(observations.call_args.args[4])
                    publish.assert_called_once()
                with patch.dict(os.environ, {"CHECKPOINT_OUTCOME": "failure"}):
                    with self.assertRaisesRegex(core.UnsafeRelease, "not verified"):
                        monitor.main()
                    self.assertFalse(observations.call_args.args[4])
                path.write_text(json.dumps({**snapshot, "checkpoint": {**snapshot["checkpoint"], "state_sha256": "wrong"}}))
                with self.assertRaisesRegex(core.UnsafeRelease, "digest mismatch"):
                    monitor.main()
                path.write_text(json.dumps(state))
                publish.reset_mock()
                with patch.object(monitor, "configuration", return_value=({**policy, "enabled": True}, GOVERNANCE)), \
                        patch.object(monitor, "Ledger", side_effect=subprocess.TimeoutExpired("gh", 60)):
                    with self.assertRaisesRegex(core.UnsafeRelease, "not verified"):
                        monitor.main()
                    self.assertFalse(observations.call_args.args[4])
                    publish.assert_called_once()

    def test_enabled_checkpoint_health_distinguishes_quiet_and_published_runs(self):
        state = counted(2)
        policy = {**NEW_POLICY, "enabled": True}
        ledger = FakeLedger(deepcopy(state))
        env = {"ACCOUNTING_OUTCOME": "success", "CHECKPOINT_PRESENCE_OUTCOME": "success",
               "CHECKPOINT_PRESENT": "false", "CHECKPOINT_OUTCOME": "skipped"}
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {**env, "RUNNER_TEMP": directory}), \
                patch.object(monitor, "Ledger", return_value=ledger):
            self.assertTrue(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
            ledger.state["count"] += 1
            self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
            ledger.state = deepcopy(state)
            with patch.object(ledger, "verify_checkpoint", side_effect=core.UnsafeRelease("missing certificate")):
                self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
            with patch.object(ledger, "verify_checkpoint", side_effect=subprocess.TimeoutExpired("gh", 60)):
                self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
            with patch.dict(os.environ, {"CHECKPOINT_PRESENCE_OUTCOME": "failure"}):
                self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))

            checkpoint = Path(directory, "release-cadence-authority", "checkpoint.json")
            checkpoint.parent.mkdir()
            checkpoint.write_text(json.dumps({"ledger_sha": "f" * 40, "state_sha256": core.state_digest(state)}))
            with patch.dict(os.environ, {"CHECKPOINT_PRESENT": "true", "CHECKPOINT_OUTCOME": "success"}):
                self.assertTrue(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
                ledger.head = "e" * 40
                self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
                ledger.head = "f" * 40
                with patch.dict(os.environ, {"ACCOUNTING_OUTCOME": "failure"}):
                    self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
                checkpoint.write_text(json.dumps({"ledger_sha": "f" * 40, "state_sha256": "wrong"}))
                self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))
                checkpoint.unlink()
                self.assertFalse(monitor.checkpoint_healthy(REPOSITORY, policy, state, False))

    def test_workflow_uploads_existing_recovery_checkpoint_even_after_failure(self):
        workflow = (Path(__file__).parents[2] / ".github/workflows/release-cadence.yml").read_text()
        self.assertIn("if: always() && steps.checkpoint-presence.outcome == 'success' && "
                      "steps.checkpoint-presence.outputs.present == 'true'", workflow)
        self.assertIn("if-no-files-found: error", workflow)
        self.assertIn("CHECKPOINT_PRESENCE_OUTCOME: ${{ steps.checkpoint-presence.outcome }}", workflow)

    def test_disabled_and_resumed_notifications_preserve_release_journal(self):
        state = counted(10)
        previous = {"release_highwater": 10, "pending_releases": ["release:8:appstore"],
                    "seen": {"controller-health": "failure", "release:8:appstore": "201:1:failure"}}
        before = deepcopy(state)
        with patch.object(monitor, "runs", return_value=[]), \
                patch.object(monitor, "git", return_value="2026-10-22T09:14:34Z"), \
                patch.object(monitor, "run_info") as info:
            journal, notices = monitor.observations(REPOSITORY, state, {}, previous, True, enabled=False)
            self.assertTrue(any("disabled" in value for value in notices))
            self.assertFalse(any("publication failed" in value for value in notices))
            self.assertEqual(journal["pending_releases"], previous["pending_releases"])
            self.assertEqual(journal["seen"]["release:8:appstore"], "201:1:failure")
            journal["checkpoint_at"] = "2026-10-22T09:14:34Z"
            body = monitor.issue_body(state, journal, 100)
            self.assertIn("Last certified UAT count: 10", body)
            self.assertIn("2026-10-22T09:14:34Z", body)
            self.assertNotIn("count: unavailable", body)
            quiet, repeated = monitor.observations(REPOSITORY, state, {}, journal, True, enabled=False)
            self.assertEqual(repeated, [])
            _, failed = monitor.observations(REPOSITORY, None, {}, quiet, False, enabled=False)
            self.assertTrue(any("publication failed" in value for value in failed))
            resumed, notices = monitor.observations(REPOSITORY, state, {}, quiet, True)
            self.assertTrue(any("resumed" in value for value in notices))
            _, repeated = monitor.observations(REPOSITORY, state, {}, resumed, True)
            self.assertEqual(repeated, [])
            info.assert_not_called()
        self.assertEqual(state, before)

    def test_enabled_baseline_failure_replaces_stale_disabled_label(self):
        previous = {"automation_enabled": False, "checkpoint_at": "2026-10-22T09:14:34Z",
                    "seen": {"automation-status": "disabled"}}
        with patch.object(monitor, "runs", return_value=[]), \
                patch.object(monitor, "git", return_value="2026-10-24T03:12:52Z"):
            journal, notices = monitor.observations(REPOSITORY, None, {}, previous, False, enabled=True)
            journal["production_baseline_run_id"] = 40050081063
            body = monitor.issue_body(counted(10), journal, 100)
            self.assertIn("configured enabled; admission blocked", body)
            self.assertIn("Current verified UAT count: unavailable", body)
            self.assertIn("40050081063", body)
            self.assertNotIn("releases disabled", body)
            self.assertNotIn("count: 10", body)
            self.assertFalse(any("resumed" in notice for notice in notices))
            _, repeated = monitor.observations(REPOSITORY, None, {}, journal, False, enabled=True)
            self.assertEqual(repeated, [])
            disabled, _ = monitor.observations(REPOSITORY, None, {}, {}, False, enabled=False)
            self.assertIn("checkpoint unavailable", monitor.issue_body(None, disabled, 100))

    def test_failed_uat_is_reported_once_without_mutating_accounting(self):
        state = counted(2)
        before = deepcopy(state)
        failed = run(50)
        failed["conclusion"] = "failure"
        with patch.object(monitor, "runs", return_value=[failed]), patch.object(monitor, "git", return_value=failed["created_at"]):
            journal, notices = monitor.observations(REPOSITORY, state, {}, {}, True)
            self.assertEqual(len(notices), 1)
            self.assertIn("does not advance", notices[0])
            _, repeated = monitor.observations(REPOSITORY, state, {}, journal, True)
        self.assertEqual(repeated, [])
        self.assertEqual(state, before)

    def test_wrong_source_is_rejected_but_apple_deferral_is_not_publication(self):
        state = counted(8)
        request = state["requests"]["8"]
        child = {"state": "success", "run_id": 201}
        request["lanes"]["testflight"] = child
        observed = run(201, "ship-ios-testflight.yml", "github-actions[bot]")
        observed["display_title"] = core.marker("8", request, "testflight")
        with patch.object(github, "artifact_json", return_value={"source_sha": "b" * 40, "build_number": "1"}), \
                self.assertRaisesRegex(core.UnsafeRelease, "identity mismatch"):
            monitor.evidence(REPOSITORY, state, "8", "testflight", child, observed)
        child = {"state": "success", "run_id": 202}
        request["lanes"]["appstore"] = child
        observed["id"] = 202
        observed["path"] = ".github/workflows/release-ios-appstore.yml"
        observed["display_title"] = core.marker("8", request, "appstore")
        with patch.object(monitor, "artifact_json", return_value={"sha": request["sha"], "reason": "apple_review_pending"}):
            self.assertIn("no publication claimed", monitor.evidence(REPOSITORY, state, "8", "appstore", child, observed))

    def test_unverified_green_upload_stays_pending_and_reports_recovery_once(self):
        state = counted(4)
        request = state["requests"]["4"]
        child = request["lanes"]["testflight"]
        child.update(state="success", run_id=201)
        original = run(201, "ship-ios-testflight.yml", "github-actions[bot]")
        original["display_title"] = core.marker("4", request, "testflight")
        with patch.object(monitor, "runs", return_value=[]), patch.object(monitor, "run_info", return_value=original), \
                patch.object(monitor, "git", return_value=original["created_at"]), \
                patch.object(monitor, "evidence", side_effect=core.UnsafeRelease("distribution missing")):
            pending, notices = monitor.observations(REPOSITORY, state, {}, {}, True)
            self.assertTrue(any("Verification failed" in item for item in notices))
            self.assertIn("release:4:testflight", pending["pending_releases"])
            pending, repeated = monitor.observations(REPOSITORY, state, {}, pending, True)
            self.assertEqual(repeated, [])
        with patch.object(monitor, "runs", return_value=[]), patch.object(monitor, "run_info", return_value=original), \
                patch.object(monitor, "evidence", return_value="Recovered existing upload"):
            recovered, notices = monitor.observations(REPOSITORY, state, {}, pending, True)
            self.assertTrue(any("Recovered existing upload" in item for item in notices))
            self.assertNotIn("release:4:testflight", recovered["pending_releases"])
            _, repeated = monitor.observations(REPOSITORY, state, {}, recovered, True)
            self.assertEqual(repeated, [])

    def test_lost_comment_response_is_recovered_without_duplicate_or_ledger_write(self):
        state = counted(2)
        before = deepcopy(state)
        saved = {"number": 1, "body": monitor.issue_body(state, {
            "automation_enabled": False, "accounting_verified": True,
            "checkpoint_at": "2026-10-22T09:14:34Z"}, 100), "comments": 0}
        comments = []
        fail_once = [True]
        def transport(path, data=None, **kwargs):
            if path.endswith("/comments") and data is not None:
                comments.append({"body": data["body"], "user": {"login": "github-actions[bot]"}})
                saved["comments"] = len(comments)
                if fail_once.pop() if fail_once else False:
                    raise core.UnsafeRelease("lost comment response")
                return {}
            if "/comments?" in path:
                return comments
            if data is not None:
                saved.update(data)
                return deepcopy(saved)
            self.fail(path)
        with patch.object(monitor, "api", side_effect=transport):
            with self.assertRaisesRegex(core.UnsafeRelease, "lost comment"):
                monitor.publish(REPOSITORY, deepcopy(saved), state, {
                    "automation_enabled": True, "accounting_verified": False,
                    "seen": {"one": "done"}}, ["First notice"], 100, "maintainer")
            self.assertIn("pending_notice", monitor.read_journal(saved["body"]))
            self.assertIn("configured enabled; admission blocked", saved["body"])
            self.assertIn("count: unavailable", saved["body"])
            self.assertNotIn("count: 2", saved["body"])
            self.assertNotIn("releases disabled", saved["body"])
            monitor.publish(REPOSITORY, deepcopy(saved), state, {"seen": {"one": "done", "two": "done"}},
                            ["Second notice"], 101, "maintainer")
        self.assertEqual(len(comments), 2)
        self.assertIn("Second notice", comments[-1]["body"])
        self.assertNotIn("pending_notice", monitor.read_journal(saved["body"]))
        self.assertEqual(state, before)

    def test_old_settled_history_is_bounded_and_does_not_reread_expired_artifacts(self):
        state = counted(2000)
        for request in state["requests"].values():
            for child in request["lanes"].values():
                child.update(state="success", run_id=123)
        journal = {"release_highwater": 2000, "pending_releases": ["release:4:testflight"],
                   "seen": {f"uat:{number}": "success" for number in range(2000)}}
        state["requests"]["4"]["lanes"]["testflight"] = {"state": "pending"}
        with patch.object(monitor, "runs", return_value=[]), patch.object(monitor, "git", return_value="2026-10-22T01:00:00Z"), \
                patch.object(monitor, "run_info") as info, patch.object(monitor, "artifact_json") as artifact:
            updated, notices = monitor.observations(REPOSITORY, state, {}, journal, True)
        self.assertEqual(notices, [])
        self.assertLessEqual(len(updated["seen"]), 160)
        self.assertLess(len(monitor.issue_body(state, updated, 100)), 20000)
        info.assert_not_called()
        artifact.assert_not_called()

    def test_queue_warning_can_be_followed_by_observed_uat_progress(self):
        source = run(50)
        source.update(status="in_progress", conclusion=None, created_at="2020-01-01T01:00:00Z",
                      updated_at="2020-01-01T01:01:00Z")
        previous = {"release_intervals": {"20": {"id": 20, "created_at": "2020-01-01T00:59:00Z",
                                                   "completed_at": None}}}
        with patch.object(monitor, "runs", return_value=[source]), patch.object(monitor, "git", return_value=source["created_at"]), \
                patch.object(monitor, "api", return_value={"total_count": 0, "jobs": []}):
            warning, notices = monitor.observations(REPOSITORY, None, {}, previous, True)
        self.assertTrue(any("10 minutes" in value for value in notices))
        with patch.object(monitor, "runs", return_value=[source]), \
                patch.object(monitor, "api", return_value={"total_count": 1, "jobs": [{"runner_id": 1, "started_at": "2020-01-01T01:01:00Z"}]}):
            progressed, notices = monitor.observations(REPOSITORY, None, {}, warning, True)
            _, repeated = monitor.observations(REPOSITORY, None, {}, progressed, True)
        self.assertTrue(any("started while" in value for value in notices))
        self.assertEqual(repeated, [])

        # A rerun's inactive gap is not an active release overlap.
        state = counted(8)
        state["requests"]["8"]["lanes"] = {"deploy": {"state": "success", "run_id": 20, "run_attempt": 2}}
        release = run(20, "deploy-production.yml", "github-actions[bot]")
        release.update(run_attempt=2, created_at="2020-01-01T00:59:00Z",
                       run_started_at="2020-01-01T01:05:00Z", updated_at="2020-01-01T01:10:00Z")
        with patch.object(monitor, "runs", return_value=[source]), patch.object(monitor, "run_info", return_value=release), \
                patch.object(monitor, "verify_child"), patch.object(monitor, "evidence", return_value=""), \
                patch.object(monitor, "git", return_value=source["created_at"]), \
                patch.object(monitor, "api", return_value={"total_count": 1, "jobs": [{"runner_id": 1, "started_at": "2020-01-01T01:01:00Z"}]}):
            gap, notices = monitor.observations(REPOSITORY, state, {}, {}, True)
        self.assertEqual(gap["release_intervals"]["20"]["created_at"], release["run_started_at"])
        self.assertFalse(any("started while" in value for value in notices))
        release.pop("run_started_at")
        monitor.record_release_interval(gap["release_intervals"], release)
        self.assertNotIn("20", gap["release_intervals"])


class UATAllocationTest(unittest.TestCase):
    def test_later_job_queue_is_observed_after_initial_uat_progress(self):
        source = run(50)
        source.update(status="in_progress", conclusion=None, created_at="2020-01-01T01:00:00Z",
                      updated_at="2020-01-01T01:12:00Z")
        previous = {"seen": {"overlap:50:1": "observed"},
                    "release_intervals": {"20": {"id": 20, "created_at": source["created_at"], "completed_at": None}}}
        jobs = [{"id": 501, "status": "completed", "runner_id": 1, "started_at": "2020-01-01T01:00:02Z"},
                {"id": 502, "status": "queued", "runner_id": 0, "started_at": None, "created_at": "2020-01-01T01:01:00Z"},
                {"id": 503, "status": "queued", "runner_id": 0, "started_at": None, "created_at": "2020-01-01T01:11:00Z"},
                {"id": 504, "status": "queued", "runner_id": 3, "started_at": None, "created_at": "2020-01-01T01:01:00Z"}]
        with patch.object(monitor, "runs", return_value=[source]), patch.object(monitor, "git", return_value=source["created_at"]), \
                patch.object(monitor, "api", return_value={"total_count": 4, "jobs": jobs}) as jobs_api, \
                patch.object(monitor, "run_info", return_value=source), \
                patch.object(monitor, "datetime", wraps=datetime) as clock:
            clock.now.return_value = datetime(2020, 1, 1, 1, 12, tzinfo=UTC)
            warning, notices = monitor.observations(REPOSITORY, None, {}, previous, True)
            self.assertEqual(len(notices), 1)
            self.assertIn("job 502 has awaited a runner for over 10 minutes", notices[0])
            self.assertIn("Possible shared-runner contention", notices[0])
            repeated, notices = monitor.observations(REPOSITORY, None, {}, warning, True)
            self.assertEqual(notices, [])
            source.update(status="completed", conclusion="success")
            jobs[1].update(status="completed", runner_id=2, started_at="2020-01-01T01:11:59Z")
            recovered, notices = monitor.observations(REPOSITORY, None, {}, repeated, True)
            self.assertEqual(len(notices), 1)
            self.assertIn("job 502 received a runner", notices[0])
            _, notices = monitor.observations(REPOSITORY, None, {}, recovered, True)
            self.assertEqual(notices, [])
            # One final scan catches waits that completed between observations.
            jobs_api.reset_mock()
            final_event = {"workflow_run": source}
            historical, notices = monitor.observations(REPOSITORY, None, final_event, previous, True)
            self.assertEqual(len(notices), 1)
            self.assertIn("received a runner after 659 seconds", notices[0])
            _, notices = monitor.observations(REPOSITORY, None, final_event, historical, True)
            self.assertEqual(notices, [])
            self.assertEqual(jobs_api.call_count, 1)
            later_release = deepcopy(previous)
            later_release["release_intervals"]["20"]["created_at"] = "2020-01-01T01:12:00Z"
            _, notices = monitor.observations(REPOSITORY, None, final_event, later_release, True)
            self.assertEqual(notices, [])


class TestFlightCompletionTest(unittest.TestCase):
    def fixture(self):
        original = run(201, "ship-ios-testflight.yml", "github-actions[bot]")
        upload = {"source_sha": "a" * 40, "bundle_id": "com.hushh.app", "marketing_version": "2.0.0", "build_number": "159"}
        recovery = run(301, testflight.RESUME)
        value = testflight.bind_recovery(original, upload, 301, 1, {"internal": "active", "build_id": "apple-build-159"})
        steps = {"Validate dispatch and original upload provenance", "Reconcile the existing uploaded build",
                 "Resume idempotent group distribution", "Bind recovery evidence to the original upload"}
        jobs = {"total_count": 1, "jobs": [{"name": "resume", "conclusion": "success",
                "steps": [{"name": name, "conclusion": "success"} for name in steps]}]}
        return original, upload, recovery, value, jobs

    def test_skipped_distribution_is_not_success_and_bound_recovery_preserves_authority(self):
        original, upload, recovery, value, jobs = self.fixture()
        ledger = FakeLedger(counted(4))
        request = ledger.state["requests"]["4"]
        upload["source_sha"] = value["source_sha"] = request["sha"]
        child = request["lanes"]["testflight"]
        child.update(state="running", run_id=201)
        original["display_title"] = core.marker("4", request, "testflight")
        inventory = {"total_count": 0, "workflow_runs": []}
        def transport(path):
            return inventory if "/workflows/" in path else jobs
        def artifact(repo, identity, name, filename, **kwargs):
            return upload if identity == 201 else value
        with patch.object(github, "api", side_effect=transport), patch.object(github, "artifact_json", side_effect=artifact), \
                patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", return_value=original), patch.object(github, "dispatch_child") as dispatch:
            github.reconcile_children(ledger)
            self.assertEqual(child["state"], "failure")
            self.assertFalse(child["completion_verified"])
            self.assertIn("completion_error", child)
            original["conclusion"] = "failure"  # An upload followed by failed distribution also blocks admission.
            github.reconcile_children(ledger)
            self.assertIn("completion_error", child)
            github.dispatch_pending(ledger)
            dispatch.assert_not_called()

            inventory.update(total_count=1, workflow_runs=[recovery])
            github.reconcile_children(ledger)
            self.assertEqual(child["state"], "success")
            self.assertTrue(child["completion_verified"])
            self.assertNotIn("completion_error", child)
            self.assertEqual(child["recovery"], {"recovery_run_id": 301, "recovery_run_attempt": 1})
            self.assertIn("Recovered by", monitor.evidence(REPOSITORY, ledger.state, "4", "testflight", child, original))
            self.assertEqual((ledger.state["count"], child["run_id"], request["sha"]), (4, 201, upload["source_sha"]))
            dispatch.assert_not_called()

    def test_stale_recovery_does_not_hide_valid_rerun_of_an_older_recovery(self):
        original, upload, recovery, value, jobs = self.fixture()
        original["run_attempt"] = 2
        stale = run(302, testflight.RESUME)
        stale_value = testflight.bind_recovery(run(201), upload, 302, 1, value)
        recovery.update(run_attempt=2, triggering_actor={"login": "maintainer"})
        value = testflight.bind_recovery(original, upload, 301, 2, value)
        inventory = {"total_count": 2, "workflow_runs": [stale, recovery]}
        def artifact(repo, identity, *args, **kwargs):
            return {201: upload, 301: value, 302: stale_value}[identity]
        with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                patch.object(github, "api", side_effect=lambda path: inventory if "/workflows/" in path else jobs), \
                patch.object(github, "artifact_json", side_effect=artifact):
            self.assertEqual(testflight.completion(REPOSITORY, original, upload["source_sha"]),
                             {"recovery_run_id": 301, "recovery_run_attempt": 2})

    def test_recovery_rejects_wrong_identity_authority_steps_and_truncated_inventory(self):
        fields = {"source_sha": "b" * 40, "build_number": "160", "marketing_version": "2.0.1", "bundle_id": "wrong",
                  "upload_run_id": 200, "upload_run_attempt": 2, "recovery_run_id": 302,
                  "recovery_run_attempt": 2, "schema_version": 2, "internal": "inactive"}
        for invalid in [*fields, "actor", "triggering_actor", "path", "head_branch", "repository", "event", "step", "truncated", "old-original-attempt"]:
            with self.subTest(invalid=invalid):
                original, upload, recovery, value, jobs = self.fixture()
                inventory = {"total_count": 1, "workflow_runs": [recovery]}
                if invalid in fields: value[invalid] = fields[invalid]
                elif invalid in {"actor", "triggering_actor"}: recovery[invalid] = {"login": "outsider"}
                elif invalid == "path": recovery[invalid] = ".github/workflows/other.yml"
                elif invalid == "head_branch": recovery[invalid] = "feature"
                elif invalid == "repository": recovery[invalid] = {"full_name": "attacker/repo"}
                elif invalid == "event": recovery[invalid] = "push"
                elif invalid == "step": jobs["jobs"][0]["steps"][0]["conclusion"] = "skipped"
                elif invalid == "truncated": inventory["total_count"] = 21
                else: original["run_attempt"] = 2
                with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                        patch.object(github, "api", side_effect=lambda path: inventory if "/workflows/" in path else jobs), \
                        patch.object(github, "artifact_json", side_effect=lambda repo, identity, *args, **kwargs: upload if identity == 201 else value), \
                        self.assertRaises(core.UnsafeRelease):
                    testflight.completion(REPOSITORY, original, upload["source_sha"])

    def test_original_requires_both_positive_steps_and_active_distribution(self):
        original, upload, _, _, _ = self.fixture()
        for invalid in (None, "skipped-job", "skipped-step", "inactive"):
            jobs = {"total_count": 1, "jobs": [{"name": "Process and distribute uploaded TestFlight build", "conclusion": "success",
                    "steps": [{"name": name, "conclusion": "success"} for name in (
                        "Wait for valid TestFlight processing", "Attach the same valid build to both TestFlight groups")]}]}
            distribution = {"internal": "active", "build_id": "apple-build-159"}
            if invalid == "skipped-job": jobs["jobs"][0]["conclusion"] = "skipped"
            if invalid == "skipped-step": jobs["jobs"][0]["steps"][0]["conclusion"] = "skipped"
            if invalid == "inactive": distribution["internal"] = "inactive"
            inventory = {"total_count": 0, "workflow_runs": []}
            with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                    patch.object(github, "api", side_effect=lambda path: inventory if "/workflows/" in path else jobs), \
                    patch.object(github, "artifact_json", side_effect=lambda repo, identity, name, *args, **kwargs: upload if name == "testflight-upload-receipt" else distribution):
                if invalid:
                    with self.assertRaises(core.UnsafeRelease): testflight.completion(REPOSITORY, original, upload["source_sha"])
                else:
                    self.assertEqual(testflight.completion(REPOSITORY, original, upload["source_sha"]), {})

    def test_optional_hardware_skip_does_not_skip_distribution_or_bypass_cancel_and_upload_gates(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ship-ios-testflight.yml").read_text()
        job = workflow.split("\n  distribute:\n", 1)[1]
        expression = re.search(r"    if: \$\{\{ (.+) \}\}", job)[1]
        self.assertIn("!cancelled()", expression)  # Overrides GitHub's implicit success() on skipped ancestors.
        for cancelled, preflight, ship, dry_run, expected in (
            (False, "success", "success", False, True), (True, "success", "success", False, False),
            (False, "failure", "success", False, False), (False, "success", "failure", False, False),
            (False, "success", "success", True, False)):
            predicate = expression.replace("!cancelled()", str(not cancelled)).replace("&&", "and")
            predicate = predicate.replace("needs.preflight.result", repr(preflight)).replace("needs.ship.result", repr(ship))
            predicate = predicate.replace("inputs.dry_run", str(dry_run)).replace("true", "True")
            self.assertEqual(eval(predicate, {"__builtins__": {}}), expected)


class HistoricalReleaseBundleTest(unittest.TestCase):
    def test_captured_controls_import_and_select_versions_without_source_checkout(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/release-ios-appstore.yml").read_text()
        files = re.search(r"for file in (scripts/ci/materialize-ios-asc-key.sh[^;]+); do", workflow)[1].split()
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            for name in files:
                target = bundle / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / name, target)
            environment = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
            result = subprocess.run([sys.executable, str(bundle / "scripts/ci/release-cadence.py"), "--help"],
                                    cwd=bundle, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            driver = ("import importlib.util,sys;sys.path.insert(0,'scripts/ci');"
                      "s=importlib.util.spec_from_file_location('release','scripts/ci/submit-appstore-version.py');"
                      "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                      "m.asc_get=lambda *args:{'data':[]};"
                      "print(m.resolve_packaging_version('synthetic','app','1.4.1','IOS'))")
            result = subprocess.run([sys.executable, "-c", driver], cwd=bundle, env=environment,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "1.4.1")


if __name__ == "__main__":
    unittest.main()
