"""Preflight failure must retain known cleanup custody without granting mutations."""

import importlib
import json
import os
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock

MAINTENANCE = importlib.import_module("uat-retention-maintenance")


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
        for stage in ("find_release", "live_release_matches"):
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

    def assert_intent_fenced(self, directory, status, pending):
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


class EvidenceTransportTest(unittest.TestCase):
    def test_raw_api_transport_and_closed_refusal_never_log_payloads_or_credentials(self):
        source = MAINTENANCE.retention_preflight_evidence.AUDITED_SOURCE_SHA
        run, job = {"id": 100, "head_sha": source}, {"id": 200}
        for supports_escape_flag in (False, True):
            calls, output = [], StringIO()

            def command(*arguments):
                calls.append(arguments)
                if arguments == ("gh", "api", "--help"):
                    return "--allow-escape-sequences" if supports_escape_flag else "usage"
                if arguments[:2] == ("gh", "api"):
                    return "PRIVATE_LOG_SENTINEL"
                return MAINTENANCE.retention_preflight_evidence.AUDITED_SOURCE_BLOBS[
                    arguments[-1].split(":", 1)[1]
                ]

            with (
                self.subTest(supports_escape_flag=supports_escape_flag),
                redirect_stdout(output),
                mock.patch.object(MAINTENANCE, "command", side_effect=command),
                mock.patch.object(MAINTENANCE.retention_preflight_evidence, "qualify_guard_only_run", return_value=None),
                mock.patch.object(MAINTENANCE.retention_preflight_evidence, "_steps_match", return_value=False),
                mock.patch.object(MAINTENANCE.retention_preflight_evidence, "raw_log_matches", return_value=False),
            ):
                self.assertIsNone(MAINTENANCE.guard_only_preflight_proof("org/repo", "uat", run, job))
            self.assertEqual(calls[1][:3], ("gh", "api", "repos/org/repo/actions/jobs/200/logs"))
            self.assertEqual("--allow-escape-sequences" in calls[1], supports_escape_flag)
            self.assertNotIn("PRIVATE_LOG_SENTINEL", output.getvalue())
            self.assertFalse(json.loads(output.getvalue())["guard_evidence_refused"]["raw_log_match"])

        with redirect_stdout(output := StringIO()), mock.patch.object(
            MAINTENANCE, "command", side_effect=MAINTENANCE.subprocess.CalledProcessError(
                1, ["gh"], stderr="HTTP 403 PRIVATE_CREDENTIAL_SENTINEL"
            )
        ):
            self.assertIsNone(MAINTENANCE.guard_only_preflight_proof("org/repo", "uat", run, job))
        self.assertNotIn("PRIVATE_CREDENTIAL_SENTINEL", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["guard_evidence_refused"]["reason"], "http_403")


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
            return {"total_count": 1, "jobs": [{
                "id": number,
                "name": "UAT bounded revision cleanup",
                "status": "in_progress" if number == 2 and recovering else "completed",
                "steps": [
                    {"name": "Prepare or finish eligible uat revision cleanup", "conclusion": "failure"},
                    {"name": "Save uat cleanup checkpoint", "conclusion": "success" if number == 1 else "skipped"},
                ],
            }]}

        for recovering, qualified in ((False, True), (True, False), (True, True)):
            with (
                self.subTest(recovering=recovering, qualified=qualified),
                mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "2"}),
                mock.patch.object(MAINTENANCE, "api", side_effect=inventory),
                mock.patch.object(MAINTENANCE, "trusted_checkpoint_run", return_value=True),
                mock.patch.object(
                    MAINTENANCE, "guard_only_preflight_proof",
                    side_effect=lambda _repo, _env, run, _job: {"run_id": 3}
                    if qualified and run["id"] == 3 else None,
                ),
            ):
                if recovering and qualified:
                    MAINTENANCE.assert_checkpoint_publication(repository, "uat")
                else:
                    with self.assertRaisesRegex(MAINTENANCE.retention.UnsafeState, "without publishing"):
                        MAINTENANCE.assert_checkpoint_publication(repository, "uat")


if __name__ == "__main__":
    unittest.main()
