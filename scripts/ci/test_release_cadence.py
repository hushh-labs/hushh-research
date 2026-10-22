#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Core release accounting, exact dispatch authority and production join regressions."""
import json
import importlib.util
import os
import tempfile
import unittest
import sys
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import release_cadence as core
import release_cadence_github as github
import release_cadence_monitor as monitor

REPOSITORY = "org/repo"
POLICY = {"enabled": True, "testflight_every": 4, "production_every": 8,
          "submit_for_review": False, "release_after_approval": False,
          "state_branch": "automation/release-cadence-state"}
NEW_POLICY = {**POLICY, "testflight_every": 2, "production_every": 4}
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


class CadenceTransitionTest(unittest.TestCase):
    def test_count_two_or_three_catches_latest_milestone_once_without_recounting(self):
        for total in (2, 3):
            with self.subTest(total=total):
                state = counted(total)
                sources = deepcopy(state["sources"])
                core.adopt_cadence(state, 101, NEW_POLICY)
                request = state["requests"]["2"]
                self.assertEqual((request["sha"], request["uat_run_id"]), (f"{2:040x}", 2))
                self.assertEqual(set(request["lanes"]), {"testflight"})
                self.assertEqual(state["sources"], sources)
                before = deepcopy(state)
                core.adopt_cadence(state, 102, NEW_POLICY)
                self.assertEqual(state, before)
                for number in range(total + 1, 5):
                    sha = f"{number:040x}"
                    core.account(state, run(number, sha=sha), receipt(sha), sha, 102, NEW_POLICY)
                self.assertEqual(state["count"], 4)
                self.assertEqual(set(state["requests"]["4"]["lanes"]), {"testflight", "deploy", "appstore"})
                self.assertEqual(state["requests"]["4"]["sha"], f"{4:040x}")

    def test_existing_running_legacy_authority_is_preserved(self):
        state = counted(8)
        request = state["requests"]["8"]
        request["lanes"]["deploy"] = {"state": "running", "run_id": 200}
        old_requests = deepcopy(state["requests"])
        core.adopt_cadence(state, 101, NEW_POLICY)
        self.assertEqual(state["requests"], old_requests)
        self.assertEqual(state["cadence"]["effective_from"], 9)
        child = run(200, "deploy-production.yml", "github-actions[bot]")
        child["display_title"] = core.marker("8", request, "deploy")
        self.assertEqual(core.verify_child(state, child, REPOSITORY, "8", "100")[1], "deploy")

    def test_recovery_preserves_both_policy_periods(self):
        state = counted(8)
        core.adopt_cadence(state, 101, NEW_POLICY)
        for number in (9, 10):
            sha = f"{number:040x}"
            core.account(state, run(number, sha=sha), receipt(sha), sha, 101, NEW_POLICY)
        ledger = FakeLedger(state)
        controller = run(102, core.CONTROLLER)
        def observed(repo, identity):
            if identity in {100, 101}:
                value = run(identity, core.CONTROLLER)
                value["event"] = "workflow_run"
                return value
            return run(identity, sha=f"{identity:040x}")
        with patch.object(github, "ancestor", return_value=True), patch.object(github, "run_info", side_effect=observed), \
                patch.object(github, "receipt", side_effect=lambda repo, identity, prefix:
                             state["sources"][f"{identity:040x}"]["receipt"]):
            github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)
            original_observed = observed
            def clock_observed(repo, identity):
                value = original_observed(repo, identity)
                if identity in {100, 101}:
                    value.update(event="repository_dispatch", actor={"login": "github-actions[bot]"})
                return value
            with patch.object(github, "run_info", side_effect=clock_observed):
                github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)
                denied = {**controller, "event": "repository_dispatch", "actor": {"login": "github-actions[bot]"}}
                with self.assertRaisesRegex(core.UnsafeRelease, "production operator"):
                    github.verify_recovery(ledger, ledger.head, denied, GOVERNANCE, NEW_POLICY)
            state["requests"]["4"]["lanes"]["deploy"] = {"state": "pending"}
            with self.assertRaisesRegex(core.UnsafeRelease, "lane mismatch"):
                github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)
            del state["requests"]["4"]["lanes"]["deploy"]
            del state["requests"]["10"]
            with self.assertRaisesRegex(core.UnsafeRelease, "milestones"):
                github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)

    def test_recovery_requires_new_milestone_and_rejects_malformed_epoch_even_at_zero(self):
        state = counted(2)
        core.adopt_cadence(state, 101, NEW_POLICY)
        ledger = FakeLedger(state)
        origin = run(101, core.CONTROLLER)
        origin["event"] = "workflow_run"
        controller = run(102, core.CONTROLLER)
        with patch.object(github, "ancestor", return_value=True), \
                patch.object(github, "run_info", side_effect=lambda repo, identity:
                             origin if identity == 101 else run(identity, sha=f"{identity:040x}")), \
                patch.object(github, "receipt", side_effect=lambda repo, identity, prefix: receipt(f"{identity:040x}")):
            github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)
            del state["requests"]["2"]
            with self.assertRaisesRegex(core.UnsafeRelease, "milestones"):
                github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)
        for total in (0, 2):
            for invalid in (None, {}, [], {"effective_from": 1}):
                with self.subTest(total=total, invalid=invalid):
                    ledger = FakeLedger(counted(total))
                    ledger.state["cadence"] = invalid
                    with self.assertRaisesRegex(core.UnsafeRelease, "cadence transition"):
                        github.verify_recovery(ledger, ledger.head, controller, GOVERNANCE, NEW_POLICY)


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
    def setUp(self):
        admission = patch.object(github, "uat_busy", return_value=False)
        admission.start()
        self.addCleanup(admission.stop)
        predecessor = patch.object(github, "production_predecessor_accepted", return_value=True)
        predecessor.start()
        self.addCleanup(predecessor.stop)
        summaries = patch.object(github, "defer_release")
        summaries.start()
        self.addCleanup(summaries.stop)

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

    def test_new_four_production_pair_yields_to_uat_and_keeps_one_source(self):
        state = counted(3)
        core.adopt_cadence(state, 101, NEW_POLICY)
        sha = f"{4:040x}"
        core.account(state, run(4, sha=sha), receipt(sha), sha, 101, NEW_POLICY)
        ledger, calls = FakeLedger(state), []
        with patch.object(github, "uat_busy", return_value=True), patch.object(github, "api") as transport:
            github.dispatch_pending(ledger)
        transport.assert_not_called()
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[1]["inputs"]["sha"] == sha for call in calls))
        self.assertEqual(calls[1][1]["inputs"]["production_deploy_run_id"], "201")
        self.assertEqual(state["requests"]["4"]["lanes"]["testflight"]["state"], "pending")

    def test_production_deploy_and_build_are_dispatched_together_with_one_sha(self):
        ledger, calls = FakeLedger(counted()), []
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
        self.assertIn("deploy-production.yml", calls[0][0])
        self.assertIn("release-ios-appstore.yml", calls[1][0])
        self.assertEqual(calls[0][1]["inputs"]["sha"], calls[1][1]["inputs"]["sha"])
        self.assertEqual(calls[1][1]["inputs"]["production_deploy_run_id"], "201")
        self.assertEqual(calls[1][1]["inputs"]["backend_target"], "production")
        self.assertEqual(len(calls), 2)
        self.assertEqual(ledger.state["requests"]["8"]["lanes"]["testflight"]["state"], "pending")
        self.assertEqual(ledger.state["requests"]["4"]["lanes"]["testflight"]["state"], "superseded")
        self.assertTrue(any(snapshot["requests"]["8"]["lanes"]["deploy"]["state"] == "dispatching" for snapshot in ledger.saves))
        for lane in ("deploy", "appstore"):
            ledger.state["requests"]["8"]["lanes"][lane]["state"] = "success"
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
        self.assertEqual(len(calls), 3)
        self.assertIn("ship-ios-testflight.yml", calls[-1][0])
        self.assertEqual(calls[-1][1]["inputs"]["sha"], calls[0][1]["inputs"]["sha"])

    def test_scoped_uat_waits_for_complementary_receipts_then_dispatches_once(self):
        ledger, calls = FakeLedger(counted()), []
        children = ledger.state["requests"]["8"]["lanes"]
        with patch.object(github, "api", self.dispatch_api(calls)), \
                patch.object(github, "production_predecessor_accepted", return_value=False), \
                patch.object(github, "defer_release") as deferred:
            github.dispatch_pending(ledger)
        self.assertEqual(calls, [])
        self.assertEqual(ledger.state["count"], 8)
        for lane in ("deploy", "appstore"):
            self.assertEqual(children[lane], {"state": "pending"})
        deferred.assert_called_once_with("production requires complete exact-SHA UAT acceptance")
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
            github.dispatch_pending(ledger)
        self.assertEqual(len(calls), 2)

    def test_predecessor_lookup_failure_cannot_record_a_dispatch_intent(self):
        ledger = FakeLedger(counted())
        with patch.object(github, "api") as request, \
                patch.object(github, "production_predecessor_accepted", side_effect=RuntimeError("unreadable")):
            with self.assertRaisesRegex(RuntimeError, "unreadable"):
                github.dispatch_pending(ledger)
        request.assert_not_called()
        self.assertEqual(ledger.state["requests"]["8"]["lanes"]["deploy"], {"state": "pending"})

    def test_uat_arriving_during_predecessor_lookup_prevents_intent(self):
        ledger = FakeLedger(counted())
        with patch.object(github, "api") as request, \
                patch.object(github, "uat_busy", side_effect=[False, True]), \
                patch.object(github, "production_predecessor_accepted", return_value=True):
            github.dispatch_pending(ledger)
        request.assert_not_called()
        self.assertEqual(ledger.state["requests"]["8"]["lanes"]["deploy"], {"state": "pending"})

    def test_half_dispatched_pair_resumes_app_without_duplicate_deployment(self):
        ledger, calls = FakeLedger(counted()), []
        ledger.state["requests"]["8"]["lanes"]["deploy"] = {"state": "success", "run_id": 155}
        with patch.object(github, "api", self.dispatch_api(calls)), \
                patch.object(github, "production_predecessor_accepted") as predecessor:
            github.dispatch_pending(ledger)
        predecessor.assert_not_called()
        self.assertFalse(any("deploy-production.yml" in path for path, _ in calls))
        self.assertEqual(calls[0][1]["inputs"]["production_deploy_run_id"], "155")

    def test_uat_arrival_between_production_dispatches_yields_and_resumes_once(self):
        ledger, calls = FakeLedger(counted()), []
        children = ledger.state["requests"]["8"]["lanes"]
        with patch.object(github, "api", self.dispatch_api(calls)), \
                patch.object(github, "uat_busy", side_effect=[False, False, True]):
            github.dispatch_pending(ledger)
        self.assertEqual(len(calls), 1)
        self.assertEqual(children["deploy"]["run_id"], 201)
        self.assertEqual(children["appstore"]["state"], "pending")
        with patch.object(github, "api", self.dispatch_api(calls)):
            github.dispatch_pending(ledger)
            github.dispatch_pending(ledger)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][1]["inputs"]["production_deploy_run_id"], "201")
        self.assertEqual(calls[0][1]["inputs"]["sha"], calls[1][1]["inputs"]["sha"])
        self.assertEqual(children["testflight"]["state"], "pending")

    def test_running_release_bundles_cannot_admit_a_competing_bundle(self):
        for active in ("testflight", "production"):
            with self.subTest(active=active):
                ledger, calls = FakeLedger(counted(12)), []
                if active == "testflight":
                    ledger.state["requests"]["4"]["lanes"]["testflight"] = {"state": "running", "run_id": 150}
                else:
                    for index, lane in enumerate(("deploy", "appstore")):
                        ledger.state["requests"]["8"]["lanes"][lane] = {"state": "running", "run_id": 155 + index}
                with patch.object(github, "api", self.dispatch_api(calls)):
                    github.dispatch_pending(ledger)
                self.assertEqual(calls, [])
                self.assertEqual(ledger.state["count"], 12)
                self.assertEqual(ledger.state["requests"]["12"]["lanes"]["testflight"]["state"], "pending")

    def test_continuous_production_candidates_cannot_starve_testflight(self):
        for last_testflight, first in ((4, "testflight"), (12, "production")):
            with self.subTest(last_testflight=last_testflight):
                ledger, calls = FakeLedger(counted(16)), []
                ledger.state["requests"][str(last_testflight)]["lanes"]["testflight"] = {"state": "success", "run_id": 140}
                for index, lane in enumerate(("deploy", "appstore")):
                    ledger.state["requests"]["8"]["lanes"][lane] = {"state": "success", "run_id": 155 + index}
                children = ledger.state["requests"]["16"]["lanes"]
                with patch.object(github, "api", self.dispatch_api(calls)):
                    github.dispatch_pending(ledger)
                    expected = 1 if first == "testflight" else 2
                    self.assertEqual(len(calls), expected)
                    self.assertIn("ship-ios-testflight.yml" if first == "testflight" else "deploy-production.yml", calls[0][0])
                    for child in children.values():
                        if child["state"] == "running":
                            child["state"] = "success"
                    github.dispatch_pending(ledger)
                self.assertEqual(len(calls), 3)
                self.assertEqual({value["inputs"]["sha"] for _, value in calls}, {f"{16:040x}"})

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
            self.assertEqual(children["appstore"]["state"], "pending")
            children["testflight"]["state"] = "success"
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


class AdmissionTest(unittest.TestCase):
    def test_every_nonterminal_uat_status_defers_without_creating_dispatch_intent(self):
        from urllib.parse import parse_qs, urlsplit
        for busy in ("requested", "queued", "pending", "waiting", "in_progress"):
            with self.subTest(status=busy):
                ledger, posts = FakeLedger(counted()), []
                def observed(path, data=None, **kwargs):
                    if data is not None:
                        posts.append((path, data))
                        return {"workflow_run_id": 201, "html_url": f"https://github.com/{REPOSITORY}/actions/runs/201"}
                    self.assertIn("/workflows/deploy-uat.yml/runs?", path)
                    query = parse_qs(urlsplit(path).query)
                    self.assertEqual(query["per_page"], ["1"])
                    return {"total_count": int(query["status"] == [busy])}
                with patch.object(github, "api", side_effect=observed), patch.object(github, "defer_release") as deferred:
                    github.dispatch_pending(ledger)
                self.assertEqual(posts, [])
                deferred.assert_called_once_with("UAT is queued or running")
                self.assertEqual(ledger.state["requests"]["8"]["lanes"]["deploy"], {"state": "pending"})
                self.assertEqual(ledger.state["count"], 8)

    def test_unreadable_uat_admission_fails_closed_before_dispatch_intent(self):
        for response in (None, {}, {"total_count": "0"}, {"total_count": -1}):
            with self.subTest(response=response):
                ledger = FakeLedger(counted(4))
                with patch.object(github, "api", return_value=response) as request:
                    with self.assertRaisesRegex(core.UnsafeRelease, "UAT release admission"):
                        github.dispatch_pending(ledger)
                request.assert_called_once()
                self.assertEqual(ledger.state["requests"]["4"]["lanes"]["testflight"], {"state": "pending"})
        ledger = FakeLedger(counted(4))
        with patch.object(github, "api", side_effect=core.UnsafeRelease("unavailable")):
            with self.assertRaises(core.UnsafeRelease):
                github.dispatch_pending(ledger)
        self.assertEqual(ledger.state["requests"]["4"]["lanes"]["testflight"], {"state": "pending"})


class ReconciliationTest(unittest.TestCase):
    def retirement_fixture(self):
        ledger, inventory, jobs = FakeLedger(counted(16)), {}, {}
        identity = 200
        for ordinal, request in ledger.state["requests"].items():
            for lane, child in request["lanes"].items():
                identity += 1
                child.update(state="failure", run_id=identity, run_attempt=1)
                if ordinal == "16" and lane == "deploy":
                    child["state"] = "success"
                observed = run(identity, core.WORKFLOWS[lane], "github-actions[bot]")
                observed.update(conclusion=child["state"], display_title=core.marker(ordinal, request, lane))
                inventory[identity] = observed
                if lane == "deploy":
                    continue
                packaging = ("Resolve automatic packaging before allocating macOS" if lane == "testflight"
                             else "Admit automatic App Store version or defer without a Mac")
                names = (["Build and distribute normal UAT TestFlight build", "Process and distribute uploaded TestFlight build"]
                         if lane == "testflight" else ["Build, upload & prepare iOS App Store release", "Process and prepare uploaded App Store build"])
                rows = [{"name": "preflight", "conclusion": "failure", "steps": [{"name": packaging, "conclusion": "failure"}]}]
                rows += [{"name": name, "conclusion": "skipped", "runner_name": None} for name in names]
                jobs[identity] = {"total_count": len(rows), "jobs": rows}
        replacement = ledger.state["requests"]["16"]
        value = {"sha": replacement["sha"], "status": "healthy", "scope": "all",
                 "candidate": {"backend_revision": "ready", "frontend_revision": "web-ready"},
                 "final": {"backend_revision": "ready", "frontend_revision": "web-ready"},
                 "verification": {key: "success" for key in ("backend_provenance", "backend_health", "frontend_provenance", "frontend_health")}}
        return ledger, inventory, jobs, value

    def test_reviewed_retirement_preserves_history_and_rejects_uncertain_uploads(self):
        for invalid in (None, "stale", "frontier", "active", "attempt", "native-ran", "missing-jobs", "replacement", "frontend", "actor"):
            with self.subTest(invalid=invalid):
                ledger, inventory, jobs, value = self.retirement_fixture()
                controller = run(100, core.CONTROLLER)
                head, frontier = ledger.head, 16
                if invalid == "stale": head = "e" * 40
                if invalid == "frontier": frontier = 12
                first = next(iter(inventory))
                if invalid == "active": ledger.state["requests"]["4"]["lanes"]["testflight"]["state"] = "running"
                if invalid == "attempt": inventory[first]["run_attempt"] = 2
                if invalid == "native-ran": jobs[first]["jobs"][1]["conclusion"] = "success"
                if invalid == "missing-jobs": jobs[first]["jobs"].pop()
                if invalid == "replacement": value["sha"] = "b" * 40
                if invalid == "frontend": value["verification"]["frontend_health"] = "failure"
                if invalid == "actor": controller["actor"]["login"] = "outsider"
                before = deepcopy(ledger.state)
                with patch.object(github, "configuration", return_value=(NEW_POLICY, GOVERNANCE)), \
                        patch.object(github, "run_info", side_effect=lambda repo, identity: inventory[identity]), \
                        patch.object(github, "api", side_effect=lambda path: jobs[int(path.split('/runs/')[1].split('/')[0])]), \
                        patch.object(github, "receipt", return_value=value):
                    if invalid:
                        with self.assertRaises(core.UnsafeRelease):
                            github.retire_obsolete_failures(ledger, frontier, head, controller)
                        self.assertEqual(ledger.state, before)
                        self.assertEqual(ledger.saves, [])
                        continue
                    github.retire_obsolete_failures(ledger, frontier, head, controller)
                restored = deepcopy(ledger.state)
                for ordinal, request in restored["requests"].items():
                    for child in request["lanes"].values():
                        if int(ordinal) < 16:
                            audit = child.pop("retirement")
                            self.assertEqual(child["state"], "superseded")
                            self.assertEqual(audit["reviewed_head"], head)
                            self.assertEqual(audit["operator"], "maintainer")
                            child["state"] = audit["previous_state"]
                self.assertEqual(restored, before)
                self.assertEqual(len(ledger.saves), 1)
                with patch.object(github, "run_info", side_effect=lambda repo, identity: inventory[identity]) as info:
                    github.reconcile_children(ledger, first)
                # Only latest non-retired failed/successful children can be polled.
                self.assertNotIn(first, [call.args[1] for call in info.call_args_list])

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

    def test_clock_wake_requires_exact_bot_event_before_any_state_access(self):
        controller = run(100, core.CONTROLLER, "github-actions[bot]")
        controller["event"] = "repository_dispatch"
        tick = {"action": "capacity-maintenance-clock"}
        ledger = FakeLedger(core.new_state("0" * 40, "2026-10-22T00:00:00Z"))
        with patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", return_value=controller), \
                patch.object(github, "Ledger", return_value=ledger) as open_ledger, \
                patch.object(github, "runs", return_value=[]), \
                patch.object(github, "reconcile_children"), patch.object(github, "dispatch_pending"):
            github.reconcile(REPOSITORY, 100, tick)
            open_ledger.assert_called_once()
            invalid = [({}, {}, {}), ({}, {"action": "another-event"}, {}),
                       ({"actor": {"login": "maintainer"}}, tick, {}),
                       ({"actor": {"login": "outsider"}}, tick, {}),
                       ({"head_branch": "feature"}, tick, {}),
                       ({"path": ".github/workflows/other.yml"}, tick, {}),
                       ({"event": "push"}, tick, {}),
                       ({"run_attempt": 2, "triggering_actor": {"login": "outsider"}}, tick, {}),
                       ({}, tick, {"full": True}), ({}, tick, {"recovery_head": "f" * 40})]
            original = deepcopy(controller)
            for change, payload, options in invalid:
                with self.subTest(change=change, payload=payload, options=options):
                    controller.clear()
                    controller.update({**original, **change})
                    open_ledger.reset_mock()
                    with self.assertRaises(core.UnsafeRelease):
                        github.reconcile(REPOSITORY, 100, payload, **options)
                    open_ledger.assert_not_called()
            controller.clear()
            controller.update({**original, "run_attempt": 2, "triggering_actor": {"login": "maintainer"}})
            github.reconcile(REPOSITORY, 100, tick)

    def test_failed_exact_child_retry_is_polled_without_a_completion_event(self):
        ledger = FakeLedger(counted(4))
        child = ledger.state["requests"]["4"]["lanes"]["testflight"]
        child.update(state="failure", run_id=200, run_attempt=1)
        observed = run(200, "ship-ios-testflight.yml", "github-actions[bot]")
        observed.update(display_title=core.marker("4", ledger.state["requests"]["4"], "testflight"),
                        run_attempt=2, triggering_actor={"login": "outsider"})
        with patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                patch.object(github, "run_info", return_value=observed), \
                patch.object(monitor, "run_info", return_value=observed), \
                patch.object(monitor, "runs", return_value=[]), \
                patch.object(monitor, "git", return_value=observed["created_at"]), \
                patch.object(monitor, "evidence", return_value="Verified receipt"):
            with self.assertRaisesRegex(core.UnsafeRelease, "retry actor"):
                github.reconcile_children(ledger)
            self.assertEqual(child["state"], "failure")
            previous = {"release_highwater": 4, "seen": {"release:4:testflight": "200:1:failure"}}
            journal, notices = monitor.observations(REPOSITORY, ledger.state, {}, previous, True)
            self.assertEqual(notices, [])
            self.assertIn("release:4:testflight", journal["pending_releases"])
            observed["triggering_actor"]["login"] = "maintainer"
            github.reconcile_children(ledger)
            self.assertEqual((child["state"], child["run_attempt"]), ("success", 2))
            recovered, notices = monitor.observations(REPOSITORY, ledger.state, {}, journal, True)
            self.assertTrue(any("success" in notice and "Verified receipt" in notice for notice in notices))
            _, repeated = monitor.observations(REPOSITORY, ledger.state, {}, recovered, True)
            self.assertEqual(repeated, [])
        ledger = FakeLedger(counted(84))
        for request in ledger.state["requests"].values():
            for child in request["lanes"].values():
                child.update(state="failure", run_id=200)
        with patch.object(github, "run_info") as info:
            with self.assertRaisesRegex(core.UnsafeRelease, "20 unresolved"):
                github.reconcile_children(ledger)
            info.assert_not_called()

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
        for conclusion in ("failure", "cancelled"):
            with self.subTest(conclusion=conclusion):
                source = run(20)
                source["conclusion"] = conclusion
                state, _ = self.invoke([source], {}, event={"workflow_run": source})
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
            controller.update(event="repository_dispatch", actor={"login": "github-actions[bot]"})
            self.assertEqual(github.recorded_authority(REPOSITORY, child)[1], "deploy")
            controller["actor"]["login"] = "maintainer"
            with self.assertRaisesRegex(core.UnsafeRelease, "repository bot"):
                github.recorded_authority(REPOSITORY, child)
            controller["actor"]["login"] = "github-actions[bot]"
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


    def test_event_transport_preserves_exact_automatic_release_plan(self):
        state, child, _, _ = self.authority_fixture()
        request = state["requests"]["8"]
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory, "event.json")
            environment = {"GITHUB_EVENT_PATH": str(event), "GITHUB_REPOSITORY": REPOSITORY,
                           "GITHUB_RUN_ID": "200", "GITHUB_REF_NAME": "main", "GITHUB_EVENT_NAME": "workflow_dispatch"}
            for lane in ("testflight", "deploy", "appstore"):
                boolean_fields = {"testflight": {"dry_run", "require_hardware", "run_core_tests"},
                                  "appstore": {"dry_run", "submit_for_review", "release_after_approval"},
                                  "deploy": set()}[lane]
                expected = core.dispatch_inputs("8", request, lane)
                surface = "uat" if lane == "testflight" else "production"
                with patch.dict(os.environ, environment), \
                        patch.object(github, "configuration", return_value=(POLICY, GOVERNANCE)), \
                        patch.object(github, "run_info", return_value=child), \
                        patch.object(github, "recorded_authority", return_value=(request, lane)):
                    forms = [expected, {k: (v == "true" if k in boolean_fields else v)
                                        for k, v in expected.items()},
                             {k: v for k, v in expected.items() if v != ""},
                             {k: v if v != "" else None for k, v in expected.items()}]
                    for values in forms:
                        with self.subTest(lane=lane, valid_transport=values):
                            event.write_text(json.dumps({"inputs": values}))
                            self.assertIs(github.authorize_current(surface, "github-actions[bot]"), request)
                    event.write_text(json.dumps({"inputs": expected}))
                    original_state = request["lanes"][lane]["state"]
                    request["lanes"][lane]["state"] = "superseded"
                    with self.assertRaisesRegex(core.UnsafeRelease, "Retired releases"):
                        github.authorize_current(surface, "github-actions[bot]")
                    request["lanes"][lane]["state"] = "failure"
                    self.assertIs(github.authorize_current(surface, "github-actions[bot]"), request)
                    request["lanes"][lane]["state"] = original_state
                    for key, value in expected.items():
                        mutations = [{**expected, key: "f" * 40 if key == "sha" else value + "changed"}]
                        if value:
                            mutations += [{k: v for k, v in expected.items() if k != key}, {**expected, key: None}]
                        if key in boolean_fields:
                            mutations += [{**expected, key: value != "true"}, {**expected, key: 0}]
                        if lane == "deploy" and key in {"run_predeploy_backup_job", "enable_one_email_kyc"}:
                            mutations += [{**expected, key: False}]
                        for changed in mutations:
                            with self.subTest(lane=lane, rejected_field=key):
                                event.write_text(json.dumps({"inputs": changed}))
                                with self.assertRaises(core.UnsafeRelease):
                                    github.authorize_current(surface, "github-actions[bot]")
                    secret = "never-echo-this-caller-value"
                    event.write_text(json.dumps({"inputs": {**expected, secret: secret}}))
                    with self.assertRaisesRegex(core.UnsafeRelease, "unexpected_count=1") as error:
                        github.authorize_current(surface, "github-actions[bot]")
                    self.assertNotIn(secret, str(error.exception))


class MonitorTest(unittest.TestCase):
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
        with patch.object(monitor, "artifact_json", return_value={"source_sha": "b" * 40, "build_number": "1"}), \
                self.assertRaisesRegex(core.UnsafeRelease, "source mismatch"):
            monitor.evidence(REPOSITORY, state, "8", "testflight", child, observed)
        child = {"state": "success", "run_id": 202}
        request["lanes"]["appstore"] = child
        observed["id"] = 202
        observed["path"] = ".github/workflows/release-ios-appstore.yml"
        observed["display_title"] = core.marker("8", request, "appstore")
        with patch.object(monitor, "artifact_json", return_value={"sha": request["sha"], "reason": "apple_review_pending"}):
            self.assertIn("no publication claimed", monitor.evidence(REPOSITORY, state, "8", "appstore", child, observed))

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
