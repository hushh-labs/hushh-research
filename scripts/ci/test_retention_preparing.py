#!/usr/bin/env python3
"""A failed initial observation preserves repair authority without asserting settlement."""

import importlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import retention_publication as publication

owner = importlib.import_module("uat-retention-maintenance")


class PreparingCheckpointTests(unittest.TestCase):
    def test_initial_lookup_failure_publishes_due_preparation_but_never_replaces_orphan_custody(self):
        for orphan in (False, True):
            with self.subTest(orphan=orphan), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                if orphan:
                    (state / "consent-protocol.json").write_text('{"pending_mutation":true}')
                args = SimpleNamespace(environment="uat", state_dir=state, apply=True)
                with patch.dict(os.environ, {"GITHUB_OUTPUT": str(state / "output")}), \
                     patch.object(owner.production_retention_context, "services", return_value=["consent-protocol"]), \
                     patch.object(owner, "latest_deploy_observation", side_effect=owner.retention.UnsafeState("lookup unavailable")) as observation:
                    with self.assertRaises(owner.retention.UnsafeState):
                        publication.begin(owner, args, "hushh-labs/hushh-research", 42)
                if orphan:
                    self.assertFalse((state / "completed.json").exists())
                    observation.assert_not_called()
                else:
                    saved = publication.completion_receipt(owner, state, "uat")
                    self.assertEqual((saved["pass_status"], saved["observed_run_id"]), ("preparing", None))
                    self.assertIn("checkpoint_ready=true", (state / "output").read_text())
                    with patch.object(owner, "restore_state"), patch.object(owner, "latest_deploy_observation") as latest:
                        self.assertTrue(owner.maintenance_due("repo", state, environment="uat", restore=False))
                        latest.assert_not_called()

    def test_unknown_observation_is_not_a_completed_or_legacy_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            record = {"schema_version": 1, "checkpoint_version": 3, "environment": "uat",
                      "project": "hushh-pda-uat", "release_run_id": 42, "observed_run_id": None,
                      "pass_status": "preparing", "pending_services": ["consent-protocol"]}
            path = state / "completed.json"
            path.write_text(json.dumps(record))
            self.assertIsNotNone(publication.completion_receipt(owner, state, "uat"))
            for change in ({"pass_status": "complete"}, {"checkpoint_version": 2}, {"pending_services": ["unrelated"]}):
                path.write_text(json.dumps({**record, **change}))
                with self.assertRaises(owner.retention.UnsafeState):
                    publication.completion_receipt(owner, state, "uat")


if __name__ == "__main__":
    unittest.main()
