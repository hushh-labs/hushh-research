#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Core release accounting, exact dispatch authority and production join regressions."""
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release_cadence as core
import release_cadence_github as github

REPOSITORY = "org/repo"
POLICY = {"enabled": True, "testflight_every": 4, "production_every": 8,
          "submit_for_review": False, "release_after_approval": False,
          "state_branch": "automation/release-cadence-state"}
GOVERNANCE = {lane: {"manual_dispatch_users": ["maintainer"], "automatic_release_workflow": core.CONTROLLER}
              for lane in ("uat", "production")}


def run(run_id, workflow="deploy-uat.yml", actor="maintainer", sha="a" * 40):
    return {"id": run_id, "path": f".github/workflows/{workflow}", "head_branch": "main",
            "repository": {"full_name": REPOSITORY}, "head_repository": {"full_name": REPOSITORY},
            "event": "workflow_dispatch", "status": "completed", "conclusion": "success",
            "actor": {"login": actor}, "created_at": "2026-10-22T01:00:00Z",
            "updated_at": "2026-10-22T02:00:00Z", "head_sha": sha, "run_attempt": 1}


def receipt(sha, scope="all"):
    return {"sha": sha, "status": "healthy", "scope": scope,
            "final": {"backend_sha": sha if scope != "frontend" else "f" * 40,
                      "backend_revision": "backend-verified", "frontend_sha": sha,
                      "frontend_revision": "frontend-verified"},
            "verification": {"provenance_success": "true"}}


def counted(total=8):
    state = core.new_state("0" * 40, "2026-10-22T00:00:00Z")
    for number in range(1, total + 1):
        sha = f"{number:040x}"
        source = run(number, sha=sha)
        value = receipt(sha, "frontend" if number % 4 == 0 else "all")
        core.account(state, source, value, sha, 100, POLICY)
    return state


class AccountingTest(unittest.TestCase):
    def test_four_eight_same_source_and_rerun_deduplication(self):
        state = counted()
        self.assertEqual(state["count"], 8)
        self.assertEqual(set(state["requests"]), {"4", "8"})
        self.assertEqual(set(state["requests"]["4"]["lanes"]), {"testflight"})
        self.assertEqual(set(state["requests"]["8"]["lanes"]), {"testflight", "deploy", "appstore"})
        source_sha = state["requests"]["8"]["sha"]
        self.assertFalse(core.account(state, run(999), receipt(source_sha), source_sha, 101, POLICY))
        self.assertEqual(state["count"], 8)

    def test_receipt_identity_counts_frontend_deploy_with_inherited_backend(self):
        source = run(1, sha="b" * 40)  # Workflow HEAD differs from the deployed source.
        value = receipt("a" * 40, "frontend")
        self.assertEqual(core.verified_uat(source, value, REPOSITORY, ["maintainer"]), "a" * 40)
        for where, field, replacement in (("run", "head_branch", "feature"), ("run", "conclusion", "failure"),
                                           ("receipt", "status", "rolled_back"), ("receipt", "scope", "none")):
            with self.subTest(field=field):
                changed_run, changed_receipt = deepcopy(source), deepcopy(value)
                (changed_run if where == "run" else changed_receipt)[field] = replacement
                with self.assertRaises(core.UnsafeRelease):
                    core.verified_uat(changed_run, changed_receipt, REPOSITORY, ["maintainer"])
        value["verification"]["provenance_success"] = "false"
        with self.assertRaises(core.UnsafeRelease):
            core.verified_uat(source, value, REPOSITORY, ["maintainer"])


class FakeLedger:
    def __init__(self, state):
        self.state, self.repository, self.base = state, REPOSITORY, f"repos/{REPOSITORY}"
        self.head = "f" * 40
        self.saves = []

    def save(self, *, force=False):
        self.saves.append(deepcopy(self.state))

    def verify_checkpoint(self):
        return {"ledger_sha": self.head, "state_sha256": core.state_digest(self.state)}


class DispatchTest(unittest.TestCase):
    def test_quiet_hourly_checks_do_not_write_state_or_publish_a_new_certificate(self):
        ledger = object.__new__(github.Ledger)
        ledger.head, ledger.state = "published", counted(4)
        ledger.saved_digest = core.state_digest(ledger.state)
        with patch.object(github, "api") as request:
            ledger.save()
            request.assert_not_called()

    def dispatch_api(self, calls):
        def invoke(path, data=None, **kwargs):
            self.assertTrue(path.endswith("/dispatches"))
            calls.append((path, data))
            run_id = 200 + len(calls)
            return {"workflow_run_id": run_id, "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}"}
        return invoke

    def test_production_deploy_and_build_are_dispatched_together_with_one_sha(self):
        ledger, calls = FakeLedger(counted()), []
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
        self.assertIn("deploy-production.yml", calls[0][0])
        self.assertIn("release-ios-appstore.yml", calls[1][0])
        self.assertEqual(calls[0][1]["inputs"]["sha"], calls[1][1]["inputs"]["sha"])
        self.assertEqual(calls[1][1]["inputs"]["production_deploy_run_id"], "201")
        self.assertEqual(calls[1][1]["inputs"]["backend_target"], "production")
        self.assertEqual(ledger.state["requests"]["4"]["lanes"]["testflight"]["state"], "superseded")
        self.assertTrue(any(snapshot["requests"]["8"]["lanes"]["deploy"]["state"] == "dispatching" for snapshot in ledger.saves))

    def test_half_dispatched_pair_resumes_app_without_duplicate_deployment(self):
        ledger, calls = FakeLedger(counted()), []
        ledger.state["requests"]["8"]["lanes"]["deploy"] = {"state": "success", "run_id": 155}
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
        self.assertFalse(any("deploy-production.yml" in path for path, _ in calls))
        self.assertEqual(calls[0][1]["inputs"]["production_deploy_run_id"], "155")

    def test_uncertain_dispatch_is_persisted_and_never_blindly_retried(self):
        ledger = FakeLedger(counted())
        with patch.object(github, "api", side_effect=core.UnsafeRelease("uncertain")):
            with self.assertRaises(core.UnsafeRelease):
                github.dispatch_pending(ledger)
        child = ledger.state["requests"]["8"]["lanes"]["deploy"]
        self.assertEqual(child["state"], "dispatching")
        self.assertNotIn(".", child["intent_at"].split("+")[0])
        with patch.object(github, "runs", return_value=[]):
            with self.assertRaises(core.UnsafeRelease):
                github.reconcile_children(ledger)

    def test_filtered_history_cap_does_not_silently_advance_accounting(self):
        with patch.object(github, "api", return_value={"total_count": 1000, "workflow_runs": []}):
            with self.assertRaisesRegex(core.UnsafeRelease, "1,000-run cap"):
                github.runs(REPOSITORY, "deploy-uat.yml", "2026-10-22T00:00:00Z", until="2026-10-22T00:00:01Z")

    def test_history_is_partitioned_before_github_truncates_it(self):
        responses = [{"total_count": 1000, "workflow_runs": []},
                     {"total_count": 1, "workflow_runs": [run(1)]},
                     {"total_count": 2, "workflow_runs": [run(1), run(2)]}]
        with patch.object(github, "api", side_effect=responses):
            found = github.runs(REPOSITORY, "deploy-uat.yml", "2026-10-22T00:00:00Z", until="2026-10-22T01:00:00Z")
        self.assertEqual({item["id"] for item in found}, {1, 2})

    def test_apple_deferral_retries_later_without_redeploying_production(self):
        from datetime import datetime, timedelta, timezone
        ledger, calls = FakeLedger(counted()), []
        children = ledger.state["requests"]["8"]["lanes"]
        children["deploy"] = {"state": "success", "run_id": 155}
        children["appstore"] = {"state": "deferred", "run_id": 156,
                                "retry_after": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
            self.assertFalse(any("release-ios-appstore.yml" in path for path, _ in calls))
            children["appstore"]["retry_after"] = "1970-01-01T00:00:00+00:00"
            github.dispatch_pending(ledger)
        self.assertFalse(any("deploy-production.yml" in path for path, _ in calls))
        self.assertEqual(children["appstore"]["deferred_runs"], [156])
        self.assertEqual(children["appstore"]["state"], "running")

    def test_newer_production_candidate_supersedes_an_old_deferred_app(self):
        ledger, calls = FakeLedger(counted(16)), []
        older = ledger.state["requests"]["8"]["lanes"]
        older["deploy"] = {"state": "success", "run_id": 155}
        older["appstore"] = {"state": "deferred", "run_id": 156, "retry_after": "9999-01-01"}
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
        self.assertEqual(older["appstore"]["state"], "superseded")
        self.assertEqual(calls[0][1]["inputs"]["sha"], f"{16:040x}")


class ReconciliationTest(unittest.TestCase):
    def test_expired_or_missing_deferral_is_not_mistaken_for_a_public_release(self):
        ledger = FakeLedger(counted(8))
        request = ledger.state["requests"]["8"]
        request["lanes"]["appstore"] = {"state": "running", "run_id": 202}
        child = run(202, "release-ios-appstore.yml", "github-actions[bot]")
        child["display_title"] = core.marker("8", request, "appstore")
        jobs = {"total_count": 1, "jobs": [{"name": "Process and prepare uploaded App Store build", "conclusion": "skipped", "steps": []}]}
        with patch.object(github, "run_info", return_value=child), patch.object(github, "artifact_json", return_value=None), \
                patch.object(github, "api", return_value=jobs):
            with self.assertRaisesRegex(core.UnsafeRelease, "No positive App Store completion proof"):
                github.reconcile_children(ledger)

    def invoke(self, inventory, receipts, *, event=None, ancestor=True, extra_api=None):
        ledger = FakeLedger(core.new_state("0" * 40, "2026-10-22T00:00:00Z"))
        controller = run(100, core.CONTROLLER)
        controller["event"] = "workflow_run"
        lookup = {100: controller, **{value["id"]: value for value in inventory}}
        with patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                patch.object(github, "Ledger", return_value=ledger), \
                patch.object(github, "runs", return_value=inventory), \
                patch.object(github, "run_info", side_effect=lambda repo, identity: lookup[identity]), \
                patch.object(github, "ancestor", return_value=ancestor), \
                patch.object(github, "receipt", side_effect=lambda repo, identity, prefix, **kwargs: receipts[identity]), \
                patch.object(github, "api", return_value=extra_api), \
                patch.object(github, "reconcile_children"), patch.object(github, "dispatch_pending"):
            return github.reconcile(REPOSITORY, 100, event or {}), ledger

    def test_out_of_order_completion_and_duplicate_source_are_counted_once(self):
        older, newer, duplicate = run(20, sha="1" * 40), run(10, sha="2" * 40), run(30, sha="1" * 40)
        older["updated_at"] = "2026-10-22T02:01:00Z"
        newer["updated_at"] = "2026-10-22T02:02:00Z"
        values = {20: receipt("1" * 40), 10: receipt("2" * 40, "frontend"), 30: receipt("1" * 40)}
        state, _ = self.invoke([newer, duplicate, older], values)
        self.assertEqual(state["count"], 2)
        self.assertEqual(state["sources"]["1" * 40]["ordinal"], 1)
        self.assertEqual(state["sources"]["2" * 40]["ordinal"], 2)

    def test_old_policy_source_is_not_counted_even_after_late_completion(self):
        state, _ = self.invoke([run(20)], {}, ancestor=False)
        self.assertEqual(state["count"], 0)

    def test_successful_noop_does_not_poison_the_counter(self):
        jobs = {"total_count": 2, "jobs": [
            {"name": "Select UAT target", "steps": [{"name": "Summarize unchanged UAT target", "conclusion": "success"}]},
            {"name": "Deploy UAT Scope", "conclusion": "skipped"}]}
        state, _ = self.invoke([run(20)], {20: None}, extra_api=jobs)
        self.assertEqual(state["count"], 0)
        self.assertEqual(state["noops"], [20])
        jobs["jobs"][1]["conclusion"] = "success"
        with self.assertRaisesRegex(core.UnsafeRelease, "NO_OP proof"):
            self.invoke([run(20)], {20: None}, extra_api=jobs)

    def test_failed_deploy_and_failed_rerun_do_not_create_release_intents(self):
        source = run(20)
        source["conclusion"] = "failure"
        state, _ = self.invoke([source], {})
        self.assertEqual(state["count"], 0)
        self.assertEqual(state["requests"], {})


class AuthorityTest(unittest.TestCase):
    def test_quiet_reviewed_recovery_publishes_a_fresh_checkpoint(self):
        ledger = object.__new__(github.Ledger)
        ledger.repository, ledger.base = REPOSITORY, f"repos/{REPOSITORY}"
        ledger.branch, ledger.head, ledger.tree = POLICY["state_branch"], "reviewed-head", "old-tree"
        ledger.state = core.new_state("0" * 40, "2026-10-22T00:00:00Z")
        ledger.state["writer_run_id"] = 100
        ledger.saved_digest = core.state_digest(ledger.state)
        controller = run(101, core.CONTROLLER)
        responses = ({"sha": "new-blob"}, {"sha": "new-tree"}, {"sha": "recovered-head"}, {})
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"GITHUB_RUN_ID": "101", "RUNNER_TEMP": directory}), \
                patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                patch.object(github, "Ledger", return_value=ledger), \
                patch.object(github, "run_info", return_value=controller), \
                patch.object(ledger, "verify_checkpoint", side_effect=core.UnsafeRelease("interrupted publication")), \
                patch.object(github, "runs", return_value=[]), \
                patch.object(github, "api", side_effect=responses):
            github.reconcile(REPOSITORY, 101, {}, recovery_head="reviewed-head")
            checkpoint = json.loads(Path(directory, "release-cadence-authority/checkpoint.json").read_text())
            self.assertEqual(checkpoint["ledger_sha"], ledger.head)
            self.assertEqual(checkpoint["state_sha256"], core.state_digest(ledger.state))
            self.assertEqual(ledger.state["count"], 0)
            self.assertEqual(ledger.state["requests"], {})

    def test_interrupted_checkpoint_recovery_requires_reviewed_head_and_independent_sources(self):
        ledger = FakeLedger(counted(4))
        controller = run(101, core.CONTROLLER)
        origin = run(100, core.CONTROLLER)
        origin["event"] = "workflow_run"
        sources = {source["run_id"]: (sha, source) for sha, source in ledger.state["sources"].items()}
        def observed(repo, identity):
            if identity == 100:
                return origin
            return run(identity, sha=sources[identity][0])
        with patch.object(github, "ancestor", return_value=True), patch.object(github, "run_info", side_effect=observed), \
                patch.object(github, "receipt", side_effect=lambda repo, identity, prefix: receipt(sources[identity][0], sources[identity][1]["receipt"]["scope"])):
            github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, POLICY)
            with self.assertRaises(core.UnsafeRelease):
                github.verify_recovery(ledger, "unreviewed-head", controller, GOVERNANCE, POLICY)
            ledger.state["count"] += 1
            with self.assertRaises(core.UnsafeRelease):
                github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, POLICY)

    def authority_fixture(self):
        state = counted()
        state["writer_run_id"] = 100
        state["requests"]["8"]["lanes"]["deploy"] = {"state": "running", "run_id": 200}
        child = run(200, "deploy-production.yml", "github-actions[bot]")
        child["display_title"] = core.marker("8", state["requests"]["8"], "deploy")
        controller = run(100, core.CONTROLLER)
        controller["event"] = "workflow_run"
        source = run(8, sha=state["requests"]["8"]["sha"])
        return state, child, controller, source

    def test_controller_snapshot_binds_exact_child_and_source(self):
        state, child, controller, source = self.authority_fixture()
        ledger = FakeLedger(state)
        snapshot = {"ledger_sha": ledger.head, "state_sha256": core.state_digest(state)}
        def verify_snapshot():
            core.require(snapshot["state_sha256"] == core.state_digest(ledger.state), "not controller authority")
            return snapshot
        with patch.object(github, "Ledger", return_value=ledger), patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", side_effect=lambda repo, identity: {100: controller, 8: source}[identity]), \
                patch.object(ledger, "verify_checkpoint", side_effect=verify_snapshot):
            self.assertEqual(github.recorded_authority(REPOSITORY, child)[1], "deploy")
            ledger.state["requests"]["8"]["submit_for_review"] = True
            with self.assertRaisesRegex(core.UnsafeRelease, "not controller authority"):
                github.recorded_authority(REPOSITORY, child)

    def test_ledger_rollback_and_forgery_are_rejected_by_newest_checkpoint(self):
        ledger = object.__new__(github.Ledger)
        ledger.repository, ledger.base, ledger.head, ledger.state = REPOSITORY, f"repos/{REPOSITORY}", "old", counted()
        artifact = {"created_at": "2026-10-22T01:00:00Z", "expired": False, "workflow_run": {"id": 100}}
        controller = run(100, core.CONTROLLER)
        with patch.object(github, "api", return_value={"artifacts": [artifact]}), \
                patch.object(github, "run_info", return_value=controller), \
                patch.object(github, "artifact_json", return_value={"ledger_sha": "new", "state_sha256": core.state_digest(ledger.state)}):
            with self.assertRaisesRegex(core.UnsafeRelease, "newest immutable"):
                ledger.verify_checkpoint()
            with patch.object(github, "Ledger", return_value=ledger), \
                    patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)):
                with self.assertRaisesRegex(core.UnsafeRelease, "newest immutable"):
                    github.recorded_authority(REPOSITORY, run(200, "deploy-production.yml", "github-actions[bot]"))

    def test_extra_production_switch_and_unbound_child_are_rejected(self):
        state, child, _, _ = self.authority_fixture()
        request = state["requests"]["8"]
        bad = deepcopy(child)
        bad["id"] = 201
        with self.assertRaises(core.UnsafeRelease):
            core.verify_child(state, bad, REPOSITORY, "8", "100")
        values = core.dispatch_inputs("8", request, "deploy")
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory, "event.json")
            environment = {"GITHUB_EVENT_PATH": str(event), "GITHUB_REPOSITORY": REPOSITORY,
                           "GITHUB_RUN_ID": "200", "GITHUB_REF_NAME": "main", "GITHUB_EVENT_NAME": "workflow_dispatch"}
            with patch.dict(os.environ, environment), patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                    patch.object(github, "run_info", return_value=child), \
                    patch.object(github, "recorded_authority", return_value=(request, "deploy")):
                event.write_text(json.dumps({"inputs": values}))
                self.assertIs(github.authorize_current("production", "github-actions[bot]"), request)
                values["enable_one_email_kyc"] = "true"
                event.write_text(json.dumps({"inputs": values}))
                with self.assertRaisesRegex(core.UnsafeRelease, "authorized plan"):
                    github.authorize_current("production", "github-actions[bot]")


class ProductionJoinTest(unittest.TestCase):
    def test_join_requires_exact_healthy_provenance_and_never_latest_run(self):
        deployment = run(200, "deploy-production.yml")
        value = {"sha": "a" * 40, "status": "healthy", "final": {"backend_revision": "candidate"},
                 "candidate": {"backend_revision": "candidate"},
                 "verification": {"backend_provenance": "success", "backend_health": "success"}}
        with patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", return_value=deployment) as get_run, \
                patch.object(github, "receipt", return_value=value):
            self.assertEqual(github.wait_production(REPOSITORY, 200, "a" * 40), value)
            self.assertEqual(get_run.call_args.args, (REPOSITORY, 200))
            for changed in ({**value, "sha": "b" * 40}, {**value, "status": "rolled_back"},
                            {**value, "final": {"backend_revision": "old"}}):
                with patch.object(github, "receipt", return_value=changed):
                    with self.assertRaises(core.UnsafeRelease):
                        github.wait_production(REPOSITORY, 200, "a" * 40)
            deployment["path"] = ".github/workflows/untrusted.yml"
            with self.assertRaises(core.UnsafeRelease):
                github.wait_production(REPOSITORY, 200, "a" * 40)


if __name__ == "__main__":
    unittest.main()
