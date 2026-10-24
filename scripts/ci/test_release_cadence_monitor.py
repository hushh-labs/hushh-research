#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Read-only GitHub release observation and notification regressions."""
import unittest
import hashlib
import io
import zipfile
import release_cadence_maintenance as maintenance
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
from unittest.mock import patch
from test_release_cadence import REPOSITORY, NEW_POLICY, GOVERNANCE, FakeLedger, counted, run, receipt, core, github, monitor, testflight


class ProductionCutoverTest(unittest.TestCase):
    def baseline(self, state):
        sha = f"{8:040x}"
        value = receipt(sha)
        value["candidate"] = {f"{lane}_revision": value["final"][f"{lane}_revision"] for lane in ("backend", "frontend")}
        for lane in ("backend", "frontend"):
            value["verification"].update({f"{lane}_provenance": "success", f"{lane}_health": "success"})
            value["final"].pop(f"{lane}_sha")
        production = run(900, "deploy-production.yml", "maintainer")
        return {**NEW_POLICY, "production_baseline_run_id": 900}, production, value

    def test_real_cutover_preserves_accounting_and_starts_only_future_two_four(self):
        state = counted(8)
        core.adopt_cadence(state, 101, NEW_POLICY)
        state["requests"]["4"]["lanes"]["testflight"] = {"state": "failure", "run_id": 200}
        ledger = FakeLedger(state)
        policy, production, value = self.baseline(state)
        sources = deepcopy(state["sources"])
        with patch.object(github, "configuration", return_value=(policy, GOVERNANCE)), \
                patch.object(github, "run_info", return_value=production), patch.object(github, "receipt", return_value=value):
            maintenance.adopt_production_baseline(ledger, policy, 102)
            self.assertEqual(state["count"], 8)
            self.assertEqual(state["sources"], sources)
            self.assertEqual(state["requests"]["4"]["lanes"]["testflight"], {"state": "failure", "run_id": 200})
            self.assertTrue(all(child["state"] == "superseded" for child in state["requests"]["8"]["lanes"].values()))
            before = deepcopy(state)
            maintenance.adopt_production_baseline(ledger, policy, 103)
            self.assertEqual(state, before)
            maintenance.production_baseline(state, policy, REPOSITORY, revalidate=True)
            for number in range(9, 13):
                sha = f"{number:040x}"
                core.account(state, run(number, sha=sha), receipt(sha), sha, 104, policy)
            self.assertEqual(set(state["requests"]["10"]["lanes"]), {"testflight"})
            self.assertEqual(set(state["requests"]["12"]["lanes"]), {"testflight", "deploy", "appstore"})
            changed_policy = {**policy, "production_baseline_run_id": 901}
            with self.assertRaises(core.UnsafeRelease):
                maintenance.adopt_production_baseline(ledger, changed_policy, 105)

    def test_unhealthy_or_started_cutover_cannot_change_any_state(self):
        for case in ("failed", "spoofed", "retry_actor", "partial", "wrong_source", "health", "half_started", "intent", "deferred", "malformed"):
            with self.subTest(case=case):
                state = counted(8)
                core.adopt_cadence(state, 101, NEW_POLICY)
                ledger = FakeLedger(state)
                policy, production, value = self.baseline(state)
                if case == "failed": production["conclusion"] = "failure"
                if case == "spoofed": production["head_branch"] = "feature"
                if case == "retry_actor": production["triggering_actor"] = {"login": "outsider"}
                if case == "partial": value["scope"] = "backend"
                if case == "wrong_source": value["sha"] = "f" * 40
                if case == "health": value["verification"]["frontend_health"] = "failure"
                if case == "half_started": state["requests"]["8"]["lanes"]["deploy"] = {"state": "success", "run_id": 200}
                if case == "intent": state["requests"]["8"]["lanes"]["testflight"]["intent_at"] = ""
                if case == "deferred": state["requests"]["8"]["lanes"]["appstore"] = {"state": "deferred", "run_id": 201}
                if case == "malformed": state["production_baseline"] = {}
                before = deepcopy(state)
                with patch.object(github, "configuration", return_value=(policy, GOVERNANCE)), \
                        patch.object(github, "run_info", return_value=production), patch.object(github, "receipt", return_value=value):
                    with self.assertRaises(core.UnsafeRelease):
                        maintenance.adopt_production_baseline(ledger, policy, 102)
                self.assertEqual(state, before)

    def test_adapter_uses_exact_attempt_upload_not_artifact_order(self):
        source = run(42)
        source.update(run_attempt=2, triggering_actor={"login": "maintainer"}, repository={"full_name": REPOSITORY, "id": 1},
                      head_repository={"full_name": REPOSITORY, "id": 1})
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as bundle:
            bundle.writestr("uat-release-status.json", json.dumps(receipt(source["head_sha"])))
        archive = stream.getvalue()
        def artifact(identity, created):
            return {"id": identity, "name": "uat-release-42", "created_at": created, "expired": False,
                    "size_in_bytes": len(archive), "digest": "sha256:" + hashlib.sha256(archive).hexdigest(),
                    "workflow_run": {"id": 42, "head_sha": source["head_sha"], "head_branch": "main", "repository_id": 1, "head_repository_id": 1}}
        inventory = {"total_count": 2, "artifacts": [artifact(999, "2026-10-22T01:00:00Z"), artifact(100, "2026-10-22T02:00:03Z")]}
        job = {"name": "Deploy UAT Scope", "run_id": 42, "run_attempt": 2, "head_sha": source["head_sha"], "head_branch": "main", "status": "completed",
               "steps": [{"name": "Upload UAT deploy artifacts", "status": "completed", "conclusion": "success", "started_at": "2026-10-22T02:00:00Z", "completed_at": "2026-10-22T02:00:05Z"}]}
        def api(path):
            if "artifacts?" in path: return inventory
            if "/jobs?" in path: return {"total_count": 1, "jobs": [job]}
            return source
        import release_artifact_receipts as receipts
        from types import SimpleNamespace
        with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), patch.object(github, "api", side_effect=api), \
                patch.object(github, "artifact_json", side_effect=core.UnsafeRelease("Missing unique uat-release-42 artifact")), \
                patch.object(receipts.retention, "run_command", return_value=SimpleNamespace(stdout=archive)) as download:
            self.assertEqual(github.receipt(REPOSITORY, 42, "uat")["sha"], source["head_sha"])
            self.assertIn("/100/zip", download.call_args.args[0][-1])
            source["triggering_actor"] = {"login": "outsider"}
            with self.assertRaises(core.UnsafeRelease):
                github.receipt(REPOSITORY, 42, "uat")


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
        saved = {"number": 1, "body": monitor.issue_body(state, {}, 100), "comments": 0}
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
                monitor.publish(REPOSITORY, deepcopy(saved), state, {"seen": {"one": "done"}}, ["First notice"], 100, "maintainer")
            self.assertIn("pending_notice", monitor.read_journal(saved["body"]))
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
                patch.object(monitor, "api", return_value={"total_count": 1, "jobs": [{"started_at": "2020-01-01T01:01:00Z"}]}):
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
                patch.object(monitor, "api", return_value={"total_count": 1, "jobs": [{"started_at": "2020-01-01T01:01:00Z"}]}):
            gap, notices = monitor.observations(REPOSITORY, state, {}, {}, True)
        self.assertEqual(gap["release_intervals"]["20"]["created_at"], release["run_started_at"])
        self.assertFalse(any("started while" in value for value in notices))
        release.pop("run_started_at")
        monitor.record_release_interval(gap["release_intervals"], release)
        self.assertNotIn("20", gap["release_intervals"])


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
