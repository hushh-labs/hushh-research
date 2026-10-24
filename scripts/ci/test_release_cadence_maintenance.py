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


if __name__ == "__main__":
    unittest.main()
