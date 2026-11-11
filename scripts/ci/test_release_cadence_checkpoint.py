#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Release cadence checkpoint publication and monitoring contracts."""
import json
import os
import subprocess
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from test_release_cadence import REPOSITORY, NEW_POLICY, GOVERNANCE, FakeLedger, counted, run, core, monitor


class CheckpointMonitoringTest(unittest.TestCase):
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

    def test_retired_workflow_has_no_active_accounting_producer(self):
        root = Path(__file__).parents[2]
        self.assertFalse((root / ".github/workflows/release-cadence.yml").exists())
        policy = json.loads((root / "config/ci-governance.json").read_text())
        for surface in ("uat", "production"):
            self.assertNotIn("automatic_release_workflow", policy[surface])


if __name__ == "__main__":
    unittest.main()
