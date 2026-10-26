#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Production-first cutover and exact-attempt maintenance receipt regressions."""
import hashlib
import io
import json
import unittest
import zipfile
from copy import deepcopy
from unittest.mock import patch
import release_cadence_maintenance as maintenance
import release_cadence_native as native
from test_release_cadence import REPOSITORY, NEW_POLICY, GOVERNANCE, FakeLedger, counted, run, receipt, core, github


class ProductionCutoverTest(unittest.TestCase):
    def baseline(self, state, ordinal=8):
        sha = f"{ordinal:040x}"
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

    def test_non_milestone_production_cutover_preserves_global_two_four_phase(self):
        state = counted(32)
        core.adopt_cadence(state, 101, NEW_POLICY)
        state["requests"]["4"]["lanes"]["testflight"] = {"state": "failure", "run_id": 200}
        ledger = FakeLedger(state)
        policy, production, value = self.baseline(state, 31)
        sources = deepcopy(state["sources"])
        future = deepcopy(state["requests"]["32"])
        with patch.object(github, "configuration", return_value=(policy, GOVERNANCE)), \
                patch.object(github, "run_info", return_value=production), patch.object(github, "receipt", return_value=value):
            maintenance.adopt_production_baseline(ledger, policy, 102)
            self.assertEqual((state["count"], state["sources"]), (32, sources))
            self.assertNotIn("31", state["requests"])
            self.assertEqual(state["requests"]["32"], future)
            self.assertEqual(state["requests"]["4"]["lanes"]["testflight"], {"state": "failure", "run_id": 200})
            self.assertTrue(all(child["state"] == "superseded" for ordinal, request in state["requests"].items()
                                if 4 < int(ordinal) <= 31 for child in request["lanes"].values()))
            before = deepcopy(state)
            maintenance.adopt_production_baseline(ledger, policy, 103)
            self.assertEqual(state, before)
            self.assertEqual(maintenance.production_baseline(state, policy, REPOSITORY, revalidate=True)["ordinal"], 31)
            for number in range(33, 37):
                sha = f"{number:040x}"
                core.account(state, run(number, sha=sha), receipt(sha), sha, 104, policy)
            self.assertEqual(set(state["requests"]["34"]["lanes"]), {"testflight"})
            self.assertEqual(set(state["requests"]["36"]["lanes"]), {"testflight", "deploy", "appstore"})

    def test_unhealthy_or_started_cutover_cannot_change_any_state(self):
        for case in ("failed", "spoofed", "retry_actor", "partial", "wrong_source", "health", "half_started", "intent", "deferred", "malformed"):
            with self.subTest(case=case):
                state = counted(8)
                core.adopt_cadence(state, 101, NEW_POLICY)
                ledger = FakeLedger(state)
                policy, production, value = self.baseline(state)
                if case == "failed":
                    production["conclusion"] = "failure"
                if case == "spoofed":
                    production["head_branch"] = "feature"
                if case == "retry_actor":
                    production["triggering_actor"] = {"login": "outsider"}
                if case == "partial":
                    value["scope"] = "backend"
                if case == "wrong_source":
                    value["sha"] = "f" * 40
                if case == "health":
                    value["verification"]["frontend_health"] = "failure"
                if case == "half_started":
                    state["requests"]["8"]["lanes"]["deploy"] = {"state": "success", "run_id": 200}
                if case == "intent":
                    state["requests"]["8"]["lanes"]["testflight"]["intent_at"] = ""
                if case == "deferred":
                    state["requests"]["8"]["lanes"]["appstore"] = {"state": "deferred", "run_id": 201}
                if case == "malformed":
                    state["production_baseline"] = {}
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
            if "artifacts?" in path:
                return inventory
            if "/jobs?" in path:
                return {"total_count": 1, "jobs": [job]}
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


class PreuploadReplacementTest(unittest.TestCase):
    def fixture(self):
        state = counted(8)
        core.adopt_cadence(state, 101, NEW_POLICY)
        request = state["requests"]["8"]
        child = {"state": "failure", "run_id": 200, "run_attempt": 1,
                 "intent_at": "2026-10-22T02:00:00Z", "completion_verified": False}
        request["lanes"]["testflight"] = child
        failed = run(200, "ship-ios-testflight.yml", "github-actions[bot]")
        failed.update(conclusion="failure", display_title=core.marker("8", request, "testflight"))
        controller = run(500, "release-cadence.yml")
        controller.update(status="in_progress", conclusion=None)
        proof = {"run": deepcopy(failed), "jobs": [{"id": 300}],
                 "artifacts": {"total_count": 0, "artifacts": []}}
        return FakeLedger(state), failed, controller, proof

    def test_replacement_archives_authority_and_resets_only_the_failed_lane(self):
        ledger, failed, controller, proof = self.fixture()
        before = deepcopy(ledger.state)
        with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", side_effect=[deepcopy(failed), deepcopy(failed)]), \
                patch.object(native, "preupload_failure_proof", return_value=proof), \
                patch.object(github, "api", side_effect=AssertionError("No dispatch is authorized here")):
            maintenance.replace_preupload_testflight(ledger, 200, ledger.head, controller)
        request = ledger.state["requests"]["8"]
        self.assertEqual(request["lanes"]["testflight"], {"state": "pending"})
        audit = request["preupload_replacements"]
        self.assertEqual(audit, [{"lane": "testflight",
                                 "previous_child": before["requests"]["8"]["lanes"]["testflight"],
                                 "proof_sha256": core.state_digest(proof), "reviewed_head": ledger.head,
                                 "controller_run_id": 500, "operator": "maintainer",
                                 "reason": "prearchive_api_gate_failure"}])
        expected = deepcopy(before)
        expected["requests"]["8"]["lanes"]["testflight"] = {"state": "pending"}
        expected["requests"]["8"]["preupload_replacements"] = deepcopy(audit)
        self.assertEqual(ledger.state, expected)
        self.assertEqual(ledger.saves, [expected])
        with self.assertRaises(core.UnsafeRelease):
            core.verify_child(ledger.state, failed, REPOSITORY, "8", "100")
        # The audit must retain a copy, even when later dispatch fills the lane.
        request["lanes"]["testflight"].update(state="running", run_id=201)
        self.assertEqual(audit[0]["previous_child"], before["requests"]["8"]["lanes"]["testflight"])

    def test_invalid_authority_or_preupload_proof_cannot_change_the_ledger(self):
        for defect in ("controller_actor", "controller_event", "controller_branch", "stale_head",
                       "malformed_head", "unknown_run", "duplicate_run", "wrong_lane", "child_state",
                       "completion_error", "used_budget", "active_release", "marker", "fork", "actor",
                       "workflow", "source_binding", "stored_attempt", "retry_actor", "proof"):
            with self.subTest(defect=defect):
                ledger, failed, controller, proof = self.fixture()
                request = ledger.state["requests"]["8"]
                identity, reviewed = 200, ledger.head
                if defect == "controller_actor":
                    controller["actor"]["login"] = "outsider"
                if defect == "controller_event":
                    controller["event"] = "repository_dispatch"
                if defect == "controller_branch":
                    controller["head_branch"] = "feature"
                if defect == "stale_head":
                    reviewed = "e" * 40
                if defect == "malformed_head":
                    ledger.head = reviewed = "not-a-sha"
                if defect == "unknown_run":
                    identity = 999
                if defect == "duplicate_run":
                    ledger.state["requests"]["4"]["lanes"]["testflight"] = deepcopy(request["lanes"]["testflight"])
                if defect == "wrong_lane":
                    request["lanes"]["deploy"] = request["lanes"]["testflight"]
                    request["lanes"]["testflight"] = {"state": "pending"}
                if defect == "child_state":
                    request["lanes"]["testflight"]["state"] = "success"
                if defect == "completion_error":
                    request["lanes"]["testflight"]["completion_error"] = "Upload delivery is unverified"
                if defect == "used_budget":
                    request["preupload_replacements"] = [{"previous_child": {"run_id": 199}}]
                if defect == "active_release":
                    request["lanes"]["appstore"] = {"state": "running", "run_id": 400}
                if defect == "marker":
                    failed["display_title"] = "Unbound release"
                if defect == "fork":
                    failed["head_repository"]["full_name"] = "other/repo"
                if defect == "actor":
                    failed["actor"]["login"] = "maintainer"
                if defect == "workflow":
                    failed["path"] = ".github/workflows/release-ios-appstore.yml"
                if defect == "source_binding":
                    request["uat_run_id"] = 999
                if defect == "stored_attempt":
                    request["lanes"]["testflight"]["run_attempt"] = 2
                if defect == "retry_actor":
                    failed.update(run_attempt=2, triggering_actor={"login": "outsider"})
                    request["lanes"]["testflight"]["run_attempt"] = 2
                before = deepcopy(ledger.state)
                with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                        patch.object(github, "run_info", side_effect=[deepcopy(failed), deepcopy(failed)]), \
                        patch.object(native, "preupload_failure_proof", side_effect=core.UnsafeRelease("Unproven upload boundary")
                                     if defect == "proof" else None, return_value=proof), \
                        patch.object(github, "api", side_effect=AssertionError("Unexpected GitHub transport")):
                    with self.assertRaises(core.UnsafeRelease):
                        maintenance.replace_preupload_testflight(ledger, identity, reviewed, controller)
                self.assertEqual(ledger.state, before)
                self.assertEqual(ledger.saves, [])

    def test_fresh_run_change_before_cas_and_new_run_cannot_reset_the_budget(self):
        for defect in ("attempt", "status", "metadata", "new_failed_run_after_replacement"):
            with self.subTest(defect=defect):
                ledger, failed, controller, proof = self.fixture()
                fresh = deepcopy(failed)
                if defect == "attempt":
                    fresh["run_attempt"] = 2
                if defect == "status":
                    fresh.update(status="in_progress", conclusion=None)
                if defect == "metadata":
                    fresh["updated_at"] = "2026-10-22T02:00:01Z"
                if defect == "new_failed_run_after_replacement":
                    request = ledger.state["requests"]["8"]
                    request["preupload_replacements"] = [{"previous_child": deepcopy(request["lanes"]["testflight"])}]
                    request["lanes"]["testflight"]["run_id"] = 201
                    failed["id"] = fresh["id"] = 201
                before = deepcopy(ledger.state)
                with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                        patch.object(github, "run_info", side_effect=[failed, fresh]), \
                        patch.object(native, "preupload_failure_proof", return_value=proof):
                    with self.assertRaises(core.UnsafeRelease):
                        maintenance.replace_preupload_testflight(ledger, failed["id"], ledger.head, controller)
                self.assertEqual(ledger.state, before)
                self.assertEqual(ledger.saves, [])

    def test_dedicated_controller_preserves_accounting_and_uses_normal_admission(self):
        ledger, failed, controller, proof = self.fixture()
        before = deepcopy(ledger.state)
        with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", side_effect=[controller, failed, failed]), \
                patch.object(github, "Ledger", return_value=ledger), \
                patch.object(native, "preupload_failure_proof", return_value=proof), \
                patch.object(github, "runs", side_effect=AssertionError("Operator replacement cannot scan or count UAT")), \
                patch.object(github, "adopt_cadence", side_effect=AssertionError("Operator replacement cannot adopt accounting")), \
                patch.object(github, "reconcile_children") as refresh, \
                patch.object(github, "dispatch_pending") as admit:
            result = github.reconcile(REPOSITORY, controller["id"], {}, reviewed_head=ledger.head, retry_run_id=200)
        self.assertIs(result, ledger.state)
        self.assertEqual((result["count"], result["sources"]), (before["count"], before["sources"]))
        self.assertEqual(result["requests"]["8"]["origin_run_id"], before["requests"]["8"]["origin_run_id"])
        self.assertEqual(result["requests"]["8"]["lanes"]["testflight"], {"state": "pending"})
        refresh.assert_called_once_with(ledger)
        admit.assert_called_once_with(ledger)


class OperatorRecoveryInputsTest(unittest.TestCase):
    def test_operator_actions_are_explicit_paired_and_mutually_exclusive(self):
        controller = run(500, "release-cadence.yml")
        head = "f" * 40
        for retire, reviewed, retry in ((0, "", 0), (8, head, 0), (0, head, 200)):
            maintenance.check_operator_inputs(controller, False, "", retire, reviewed, retry)
        for defect in ("both", "missing_head", "head_only", "full", "checkpoint_recovery",
                       "schedule", "clock", "negative_id", "boolean_id"):
            with self.subTest(defect=defect):
                changed = deepcopy(controller)
                full, recovery, retire, reviewed, retry = False, "", 0, head, 200
                if defect == "both":
                    retire = 8
                if defect == "missing_head":
                    reviewed = ""
                if defect == "head_only":
                    retry = 0
                if defect == "full":
                    full = True
                if defect == "checkpoint_recovery":
                    recovery = head
                if defect == "schedule":
                    changed["event"] = "schedule"
                if defect == "clock":
                    changed["event"] = "repository_dispatch"
                if defect == "negative_id":
                    retry = -1
                if defect == "boolean_id":
                    retry = True
                with self.assertRaises(core.UnsafeRelease):
                    maintenance.check_operator_inputs(changed, full, recovery, retire, reviewed, retry)


class PreuploadFailureProofTest(unittest.TestCase):
    def fixture(self):
        failed = run(200, "ship-ios-testflight.yml", "github-actions[bot]")
        failed["conclusion"] = "failure"
        skipped = ("Create UAT archive", "Verify archived app and extension versions",
                   "Verify archive assets, privacy, and own symbols", "Export and upload TestFlight build",
                   "Preserve dry-run UAT IPA in private bucket", "Upload redacted private IPA receipt",
                   "Preserve uploaded build identity for recovery", "Upload recovery receipt before Apple processing",
                   "Preserve redacted distribution outputs")
        steps = [{"name": name, "status": "completed", "conclusion": "skipped"} for name in skipped]
        steps += [{"name": name, "status": "completed", "conclusion": "success"} for name in
                  ("Assert source SHA", "Resolve next TestFlight build number", "Remove protected runner files")]
        steps.append({"name": "Run TestFlight API unit gates", "status": "completed", "conclusion": "failure"})
        names = ("Resolve green UAT release source", "Prove physical iPhone capture gate",
                 "Build and distribute normal UAT TestFlight build", "Process and distribute uploaded TestFlight build")
        jobs = []
        for number, name in enumerate(names):
            job = {"id": 300 + number, "name": name, "run_id": 200, "run_attempt": 1,
                   "head_sha": failed["head_sha"], "head_branch": "main", "status": "completed",
                   "conclusion": "skipped", "runner_name": None, "runner_id": 0, "steps": []}
            if number == 0:
                job.update(conclusion="success", runner_name="ubuntu", runner_id=1)
            if number == 2:
                job.update(conclusion="failure", runner_name="macOS", runner_id=2, steps=steps)
            jobs.append(job)
        return failed, {"total_count": 0, "artifacts": []}, {"total_count": 4, "jobs": jobs}

    def test_only_a_complete_unuploaded_prearchive_failure_is_proven(self):
        for defect in (None, "expired_upload", "other_artifact", "partial_artifacts", "partial_jobs",
                       "missing_job", "job_attempt", "job_sha", "job_running", "source_failure",
                       "physical_allocated", "distribution_allocated", "distribution_runner_id",
                       "other_failure", "missing_archive", "duplicate_archive", "archive_ran",
                       "upload_ran", "cleanup_failed", "run_running"):
            with self.subTest(defect=defect):
                failed, artifacts, inventory = self.fixture()
                jobs = inventory["jobs"]
                steps = jobs[2]["steps"]
                if defect in {"expired_upload", "other_artifact"}:
                    artifacts.update(total_count=1, artifacts=[{"name": "testflight-upload-receipt"
                                                               if defect == "expired_upload" else "other-evidence",
                                                               "expired": True}])
                if defect == "partial_artifacts":
                    artifacts["total_count"] = 1
                if defect == "partial_jobs":
                    inventory["total_count"] = 5
                if defect == "missing_job":
                    jobs.pop()
                    inventory["total_count"] = 3
                if defect == "job_attempt":
                    jobs[2]["run_attempt"] = 2
                if defect == "job_sha":
                    jobs[2]["head_sha"] = "b" * 40
                if defect == "job_running":
                    jobs[2]["status"] = "in_progress"
                if defect == "source_failure":
                    jobs[0]["conclusion"] = "failure"
                if defect == "physical_allocated":
                    jobs[1]["runner_name"] = "macOS"
                if defect == "distribution_allocated":
                    jobs[3]["runner_name"] = "ubuntu"
                if defect == "distribution_runner_id":
                    jobs[3]["runner_id"] = 9
                if defect == "other_failure":
                    steps.append({"name": "Another gate", "conclusion": "failure"})
                if defect == "missing_archive":
                    steps.pop(0)
                if defect == "duplicate_archive":
                    steps.append(deepcopy(steps[0]))
                if defect == "archive_ran":
                    steps[0]["conclusion"] = "success"
                if defect == "upload_ran":
                    steps[3]["conclusion"] = "success"
                if defect == "cleanup_failed":
                    steps[-2]["conclusion"] = "failure"
                if defect == "run_running":
                    failed.update(status="in_progress", conclusion=None)
                with patch.object(github, "api", side_effect=[artifacts, inventory]):
                    if defect is None:
                        self.assertEqual(native.preupload_failure_proof(REPOSITORY, failed),
                                         {"run": failed, "jobs": jobs, "artifacts": artifacts})
                    else:
                        with self.assertRaises(core.UnsafeRelease):
                            native.preupload_failure_proof(REPOSITORY, failed)


if __name__ == "__main__":
    unittest.main()
