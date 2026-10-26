"""Preflight failure must retain known cleanup custody without granting mutations."""

import importlib
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

MAINTENANCE = importlib.import_module("uat-retention-maintenance")
PREFLIGHT_FAILURES = (
    "maintenance_due",
    "find_release",
    "live_release_matches",
    "latest_deploy_observation",
)


def saved_checkpoint(status, pending):
    receipt = json.dumps(
        {
            "schema_version": 1,
            "checkpoint_version": 2,
            "environment": "uat",
            "project": "hushh-pda-uat",
            "release_run_id": 9,
            "observed_run_id": 20,
            "pass_status": status,
            "pending_services": ["consent-protocol"],
        }
    )
    intent = json.dumps(
        {
            "schema_version": 1,
            "service": "consent-protocol",
            "project": "hushh-pda-uat",
            "region": "us-central1",
            "release_run_id": "9",
            "not_before": 13660,
            "pending_mutation": {"revision": "consent-protocol-00001-abc"}
            if pending
            else None,
        }
    )
    return receipt, intent


class PreflightCheckpointTest(unittest.TestCase):
    def test_preflight_failure_preserves_publishable_checkpoint_and_pending_intent(
        self,
    ):
        for stage in PREFLIGHT_FAILURES:
            for status, pending in (
                ("complete", False),
                ("complete", True),
                ("unresolved", False),
            ):
                with (
                    self.subTest(stage=stage, status=status, pending=pending),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    directory = pathlib.Path(temporary)
                    output = directory / "output"
                    receipt, intent = saved_checkpoint(status, pending)

                    def restore(_repository, target, **_kwargs):
                        (target / "completed.json").write_text(receipt)
                        (target / "consent-protocol.json").write_text(intent)

                    with (
                        mock.patch.dict(
                            os.environ,
                            {
                                "GITHUB_REPOSITORY": "org/repo",
                                "GITHUB_OUTPUT": str(output),
                            },
                        ),
                        mock.patch.object(
                            sys,
                            "argv",
                            ["maintenance", "--apply", "--state-dir", str(directory)],
                        ),
                        mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                        mock.patch.object(
                            MAINTENANCE, "restore_state", side_effect=restore
                        ),
                        mock.patch.object(
                            MAINTENANCE, "latest_deploy_observation", return_value=21
                        ),
                        mock.patch.object(
                            MAINTENANCE,
                            "find_release",
                            return_value=(123, {"status": "healthy"}),
                        ),
                        mock.patch.object(
                            MAINTENANCE, "live_release_matches", return_value=True
                        ),
                        mock.patch.object(
                            MAINTENANCE,
                            stage,
                            side_effect=MAINTENANCE.retention.UnsafeState(
                                "Drive worker is not ready"
                            ),
                        ),
                        mock.patch.object(MAINTENANCE, "run_retention") as mutate,
                    ):
                        with self.assertRaisesRegex(
                            MAINTENANCE.retention.UnsafeState,
                            "Drive worker is not ready",
                        ):
                            MAINTENANCE.main()
                    self.assertTrue(
                        output.exists(),
                        "preflight must preserve its existing checkpoint for publication",
                    )
                    self.assertEqual(output.read_text(), "checkpoint_ready=true\n")
                    self.assertEqual(
                        (directory / "completed.json").read_text(), receipt
                    )
                    self.assertEqual(
                        (directory / "consent-protocol.json").read_text(), intent
                    )
                    mutate.assert_not_called()
                    self.assert_intent_fenced(directory, status, pending)

    def test_preflight_failure_never_publishes_missing_or_invalid_checkpoint(self):
        for kind in ("absent", "malformed", "symlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                output = directory / "output"

                def restore(_repository, target, **_kwargs):
                    if kind == "malformed":
                        (target / "completed.json").write_text("{}")
                    elif kind == "symlink":
                        (target / "prior").write_text("{}")
                        (target / "completed.json").symlink_to(target / "prior")

                with (
                    mock.patch.dict(
                        os.environ,
                        {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                    ),
                    mock.patch.object(
                        sys,
                        "argv",
                        ["maintenance", "--apply", "--state-dir", str(directory)],
                    ),
                    mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                    mock.patch.object(
                        MAINTENANCE, "restore_state", side_effect=restore
                    ),
                    mock.patch.object(
                        MAINTENANCE,
                        "find_release",
                        side_effect=MAINTENANCE.retention.UnsafeState(
                            "preflight refused"
                        ),
                    ),
                    mock.patch.object(MAINTENANCE, "run_retention") as mutate,
                ):
                    with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                        MAINTENANCE.main()
                self.assertFalse(output.exists())
                mutate.assert_not_called()

    def test_first_checkpoint_precedes_live_health_when_no_prior_receipt_exists(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            output = directory / "output"
            with (
                mock.patch.dict(
                    os.environ,
                    {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                ),
                mock.patch.object(
                    sys,
                    "argv",
                    ["maintenance", "--apply", "--state-dir", str(directory)],
                ),
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state"),
                mock.patch.object(
                    MAINTENANCE,
                    "find_release",
                    return_value=(123, {"status": "healthy"}),
                ),
                mock.patch.object(
                    MAINTENANCE, "latest_deploy_observation", return_value=124
                ),
                mock.patch.object(
                    MAINTENANCE,
                    "live_release_matches",
                    side_effect=MAINTENANCE.retention.UnsafeState(
                        "Drive worker is not ready"
                    ),
                ),
                mock.patch.object(MAINTENANCE, "run_retention") as mutate,
            ):
                with self.assertRaisesRegex(
                    MAINTENANCE.retention.UnsafeState, "Drive worker"
                ):
                    MAINTENANCE.main()
            checkpoint = json.loads((directory / "completed.json").read_text())
            self.assertEqual(checkpoint["pass_status"], "in_progress")
            self.assertEqual(
                (checkpoint["release_run_id"], checkpoint["observed_run_id"]),
                (123, 124),
            )
            self.assertEqual(
                set(checkpoint["pending_services"]),
                set(MAINTENANCE.LANES["uat"]["services"]),
            )
            self.assertTrue((directory / "README.txt").is_file())
            self.assertEqual(output.read_text(), "checkpoint_ready=true\n")
            mutate.assert_not_called()

    def assert_intent_fenced(self, directory, status, pending):
        self.assertEqual(
            (directory / "README.txt").read_text(),
            "uat drain evidence; never deployment authority.\n",
        )
        with (
            mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
            mock.patch.object(MAINTENANCE, "restore_state"),
        ):
            if status == "unresolved" or pending:
                with self.assertRaisesRegex(
                    MAINTENANCE.retention.UnsafeState,
                    "provider outcome is unresolved",
                ):
                    MAINTENANCE.assert_no_pending_mutations(
                        "org/repo", directory, "uat"
                    )
            else:
                MAINTENANCE.assert_no_pending_mutations("org/repo", directory, "uat")


class PublicationHistoryRecoveryTest(unittest.TestCase):
    def test_guard_only_refusal_keeps_prior_unpublished_mutation_fenced(self):
        repository = "org/repo"
        runs = [
            {
                "id": number,
                "path": ".github/workflows/capacity-maintenance.yml",
                "head_branch": "main",
                "repository": {"full_name": repository},
                "head_repository": {"full_name": repository},
            }
            for number in (3, 2, 1)
        ]

        def inventory(_repository, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": runs}
            number = int(endpoint.split("/")[1])
            return {
                "total_count": 1,
                "jobs": [
                    {
                        "id": number,
                        "name": "UAT bounded revision cleanup",
                        "status": "in_progress"
                        if number == 2 and recovering
                        else "completed",
                        "steps": [
                            {
                                "name": "Prepare or finish eligible uat revision cleanup",
                                "conclusion": "failure",
                            },
                            {
                                "name": "Save uat cleanup checkpoint",
                                "conclusion": "success" if number == 1 else "skipped",
                            },
                        ],
                    }
                ],
            }

        for recovering, qualified in ((False, True), (True, False), (True, True)):
            with (
                self.subTest(recovering=recovering, qualified=qualified),
                mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "2"}),
                mock.patch.object(MAINTENANCE, "api", side_effect=inventory),
                mock.patch.object(
                    MAINTENANCE, "trusted_checkpoint_run", return_value=True
                ),
                mock.patch.object(
                    MAINTENANCE,
                    "guard_only_preflight_proof",
                    side_effect=lambda _repo, _env, run, _job: (
                        {"run_id": 3} if qualified and run["id"] == 3 else None
                    ),
                ),
            ):
                # A matching run ID alone cannot exempt an active rerun/attempt.
                with self.assertRaises(MAINTENANCE.retention.UnsafeState):
                    MAINTENANCE.assert_checkpoint_publication(repository, "uat")


if __name__ == "__main__":
    unittest.main()
