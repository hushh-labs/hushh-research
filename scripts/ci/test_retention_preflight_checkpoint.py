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


def restored_bridge():
    return {
        "version": 1,
        "project": "hushh-pda",
        "service": "consent-protocol",
        "status": "intent",
        "requested": True,
        "revision": "consent-protocol-cap-" + "a" * 16,
        "sourceFingerprint": "a" * 64,
        "serviceControlsFingerprint": "b" * 64,
        "sourceRevision": "consent-protocol-source",
        "displacedLatestRevision": "consent-protocol-old",
        "traffic": [],
        "pins": {
            "RUNTIME": {
                "version": "projects/hushh-pda/secrets/runtime/versions/1",
                "unchangedSinceSource": True,
            }
        },
    }


class EarlyCheckpointCases:
    def test_health_failure_preserves_restored_checkpoint_and_intents(
        self,
    ):
        bridge = restored_bridge()
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            output = state / "output"
            inherited = b'{"pending_mutation":{"action":"delete","revisions":["old"]}}'
            prior = {
                "schema_version": 1,
                "checkpoint_version": 2,
                "environment": "uat",
                "project": "hushh-pda-uat",
                "release_run_id": 9,
                "observed_run_id": 20,
                "pass_status": "unresolved",
                "pending_services": ["consent-protocol"],
                "capacity_bridge": bridge,
            }

            def restore(*_args, **_kwargs):
                (state / "consent-protocol.json").write_bytes(inherited)
                (state / "completed.json").write_text(json.dumps(prior))

            with (
                mock.patch.dict(
                    "os.environ",
                    {"GITHUB_REPOSITORY": "org/repo", "GITHUB_OUTPUT": str(output)},
                ),
                mock.patch.object(
                    sys, "argv", ["maintenance", "--state-dir", str(state), "--apply"]
                ),
                mock.patch.object(MAINTENANCE, "assert_checkpoint_publication"),
                mock.patch.object(MAINTENANCE, "restore_state", side_effect=restore),
                mock.patch.object(MAINTENANCE, "maintenance_due", return_value=True),
                mock.patch.object(
                    MAINTENANCE,
                    "find_release",
                    return_value=(123, {"status": "healthy"}),
                ) as source,
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
            self.assertIs(source.call_args.kwargs["require_live"], False)
            checkpoint = json.loads((state / "completed.json").read_text())
            self.assertEqual((state / "completed.json").read_text(), json.dumps(prior))
            self.assertTrue((state / "README.txt").is_file())
            self.assertEqual(checkpoint["capacity_bridge"], bridge)
            self.assertEqual((state / "consent-protocol.json").read_bytes(), inherited)
            self.assertIn("checkpoint_ready=true", output.read_text())
            mutate.assert_not_called()


class PreflightCheckpointTest(EarlyCheckpointCases, unittest.TestCase):
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
                "updated_at": "2026-10-27T00:00:20Z",
                "status": "completed",
            }
            for number in (3, 2, 1)
        ]

        def inventory(_repository, endpoint):
            if endpoint.startswith("workflows/"):
                return {"workflow_runs": runs, "total_count": len(runs)}
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


class ExecutionChronologyTest(unittest.TestCase):
    def history(self, updated, *, active=False, inventory_defect=None):
        base = {
            "path": ".github/workflows/capacity-maintenance.yml",
            "head_branch": "main",
            "repository": {"full_name": "org/repo"},
            "head_repository": {"full_name": "org/repo"},
            "status": "completed",
            "run_attempt": 1,
        }
        newer = {**base, "id": 200, "updated_at": "2026-10-27T00:00:20Z"}
        older = {
            **base,
            "id": 100,
            "run_attempt": 2,
            "updated_at": updated,
            "status": "in_progress" if active else "completed",
        }
        saved = {
            "name": "UAT bounded revision cleanup",
            "status": "completed",
            "completed_at": "2026-10-27T00:00:20Z",
            "steps": [
                {
                    "name": "Prepare or finish eligible uat revision cleanup",
                    "conclusion": "success",
                },
                {
                    "name": "Save uat cleanup checkpoint",
                    "conclusion": "success",
                    "completed_at": "2026-10-27T00:00:10Z",
                },
            ],
        }
        missing = {
            **saved,
            "status": "in_progress" if active else "completed",
            "steps": [
                {
                    "name": "Prepare or finish eligible uat revision cleanup",
                    "conclusion": "failure",
                },
                {"name": "Save uat cleanup checkpoint", "conclusion": "failure"},
            ],
        }
        calls = []

        def api(_repository, endpoint):
            calls.append(endpoint)
            if endpoint.startswith("workflows/"):
                rows = [newer, newer if inventory_defect == "duplicate" else older]
                count = (
                    1001
                    if inventory_defect == "overflow"
                    else 3
                    if inventory_defect == "truncated"
                    else 2
                )
                return {"total_count": count, "workflow_runs": rows}
            return {
                "total_count": 1,
                "jobs": [saved if endpoint.startswith("runs/200/") else missing],
            }

        with (
            mock.patch.object(MAINTENANCE, "api", side_effect=api),
            mock.patch.object(MAINTENANCE, "trusted_checkpoint_run", return_value=True),
        ):
            MAINTENANCE.assert_checkpoint_publication("org/repo", "uat")
        return calls

    def test_older_id_rerun_after_or_equal_to_publication_cannot_hide_behind_newer_id(
        self,
    ):
        for updated in ("2026-10-27T00:00:25Z", "2026-10-27T00:00:10Z", None):
            with (
                self.subTest(updated=updated),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.history(updated)
        with self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "still active"):
            self.history("2026-10-27T00:00:05Z", active=True)
        calls = self.history("2026-10-27T00:00:05Z")
        self.assertFalse(any(endpoint.startswith("runs/100/") for endpoint in calls))

    def test_metadata_inventory_must_be_complete_unique_and_bounded_before_any_anchor(
        self,
    ):
        for defect in ("duplicate", "overflow", "truncated"):
            with (
                self.subTest(defect=defect),
                self.assertRaises(MAINTENANCE.retention.UnsafeState),
            ):
                self.history("2026-10-27T00:00:05Z", inventory_defect=defect)


if __name__ == "__main__":
    unittest.main()
