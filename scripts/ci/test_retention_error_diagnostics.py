"""Maintenance failures expose fixed diagnostics, never provider or subprocess text."""

import os
import importlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

MAINTENANCE = importlib.import_module("uat-retention-maintenance")
DIAGNOSTICS = importlib.import_module("retention_pass_diagnostics")


class RetentionErrorDiagnosticTest(unittest.TestCase):
    def test_release_context_stage_and_due_skip_output_are_preserved(self):
        args = SimpleNamespace(
            verify_source_only=True,
            apply=False,
            force_inspection=False,
            state_dir=Path("/private/state"),
            environment="production",
            release_run_id="123",
        )
        context = SimpleNamespace(
            load_operational=mock.Mock(return_value="operational"),
            worker=mock.Mock(return_value="worker"),
        )
        DIAGNOSTICS.load_release_context(context, args, "org/repo", MAINTENANCE)
        self.assertEqual(args.operational_anchor, "operational")
        self.assertEqual(args.worker_anchor, "worker")
        self.assertEqual(DIAGNOSTICS.CURRENT_STAGE.get(), "release_context")

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "github-output"
            due = mock.Mock(return_value=False)
            self.assertFalse(
                DIAGNOSTICS.should_run_preflight(args, "org/repo", due, str(output))
            )
            due.assert_called_once_with(
                "org/repo",
                args.state_dir,
                environment="production",
                release_run_id=123,
                restore=True,
            )
            self.assertEqual(output.read_text(), "cleanup_ready=false\n")
            self.assertEqual(DIAGNOSTICS.CURRENT_STAGE.get(), "due_check")

        args.force_inspection = True
        due.reset_mock()
        self.assertTrue(DIAGNOSTICS.should_run_preflight(args, "org/repo", due, None))
        due.assert_not_called()

    def test_publication_guard_failure_carries_its_fixed_pre_mutation_stage(self):
        error = ValueError("private provider response")
        with tempfile.TemporaryDirectory() as temporary:
            with (
                mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "org/repo"}),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "uat-retention-maintenance.py",
                        "--apply",
                        "--release-run-id",
                        "1",
                        "--state-dir",
                        temporary,
                    ],
                ),
                mock.patch.object(
                    MAINTENANCE,
                    "assert_checkpoint_publication",
                    side_effect=error,
                ) as publication,
            ):
                with self.assertRaises(ValueError):
                    MAINTENANCE.maintenance_pass()
        publication.assert_called_once_with("org/repo", "uat")
        self.assertEqual(
            DIAGNOSTICS.safe_failure_diagnostic(
                DIAGNOSTICS.CURRENT_STAGE.get(), error, MAINTENANCE.retention
            ),
            "Hosted maintenance stopped: stage=publication_guard kind=invalid_data",
        )

    def test_manual_production_apply_bounds_release_lookup_after_checkpoint_restore(self):
        for event, ref, force, environment, pass_deadline, expected in (
            ("workflow_dispatch", "main", True, "production", 295, 220),
            ("workflow_dispatch", "main", True, "production", 180, 180),
            ("workflow_dispatch", "main", False, "production", 295, 90),
            ("workflow_dispatch", "uat", True, "production", 295, 90),
            ("repository_dispatch", "main", True, "production", 295, 90),
            ("workflow_dispatch", "main", True, "uat", 295, 90),
        ):
            with self.subTest(event=event, ref=ref, force=force, environment=environment):
                with tempfile.TemporaryDirectory() as temporary:
                    args = SimpleNamespace(
                        environment=environment, apply=True, force_inspection=force,
                        release_run_id="123", state_dir=Path(temporary),
                        check_mutations=False,
                    )
                    lookup = MAINTENANCE._LOOKUP_DEADLINE
                    retention = MAINTENANCE.retention
                    original = lookup.set(90)
                    outer = retention.PASS_DEADLINE.set(pass_deadline)

                    def guard(*_):
                        self.assertEqual(lookup.get(), 90)

                    def release(*_):
                        self.assertEqual(lookup.get(), expected)
                        self.assertEqual(retention.PASS_DEADLINE.get(), pass_deadline)

                    try:
                        with (
                            mock.patch.dict(os.environ, {
                                "GITHUB_REPOSITORY": "org/repo",
                                "GITHUB_EVENT_NAME": event, "GITHUB_REF_NAME": ref,
                            }),
                            mock.patch.object(MAINTENANCE.time, "monotonic", return_value=130),
                            mock.patch.object(MAINTENANCE, "maintenance_cli", return_value=args),
                            mock.patch.object(DIAGNOSTICS, "checkpoint_guard", side_effect=guard),
                            mock.patch.object(DIAGNOSTICS, "restore_checkpoint", side_effect=guard),
                            mock.patch.object(DIAGNOSTICS, "load_release_context", side_effect=release),
                            mock.patch.object(DIAGNOSTICS, "should_run_preflight", return_value=True),
                            mock.patch.object(DIAGNOSTICS, "find_release", side_effect=release),
                        ):
                            self.assertEqual(MAINTENANCE.maintenance_pass(), 0)
                    finally:
                        lookup.reset(original)
                        retention.PASS_DEADLINE.reset(outer)

    def test_child_failure_reports_only_stage_kind_and_bounded_exit_code(self):
        error = subprocess.CalledProcessError(
            7,
            ["gcloud", "run", "services", "list", "--project=private-project"],
            output="private stdout payload",
            stderr="private stderr payload",
        )

        diagnostic = DIAGNOSTICS.safe_failure_diagnostic(
            "revision_cleanup", error, MAINTENANCE.retention
        )

        self.assertEqual(
            diagnostic,
            "Hosted maintenance stopped: stage=revision_cleanup "
            "kind=child_process_failure exit_code=7",
        )
        for private in (
            "gcloud",
            "private-project",
            "private stdout",
            "private stderr",
        ):
            self.assertNotIn(private, diagnostic)

    def test_refusals_and_other_errors_never_echo_messages_or_paths(self):
        cases = (
            (
                MAINTENANCE.retention.UnsafeState("private refusal detail"),
                "safety_refusal",
            ),
            (
                MAINTENANCE.retention.BudgetExpired("private timeout detail"),
                "budget_expired",
            ),
            (
                subprocess.TimeoutExpired(
                    ["gh", "api", "private/path"], 10, stderr="private response"
                ),
                "child_process_timeout",
            ),
            (OSError(13, "private file detail", "/private/path"), "os_error"),
            (ValueError("private JSON body"), "invalid_data"),
            (KeyError("private account field"), "missing_state_key"),
        )
        for error, kind in cases:
            with self.subTest(kind=kind):
                diagnostic = DIAGNOSTICS.safe_failure_diagnostic(
                    "publication_guard", error, MAINTENANCE.retention
                )
                self.assertEqual(
                    diagnostic,
                    f"Hosted maintenance stopped: stage=publication_guard kind={kind}"
                    + (" os_code=13" if isinstance(error, OSError) else ""),
                )
                for private in (
                    "private",
                    "account",
                    "response",
                    "detail",
                    "body",
                    "path",
                ):
                    self.assertNotIn(private, diagnostic)

    def test_http_status_and_stage_are_validated_before_output(self):
        error = ValueError("private response")
        error.response = SimpleNamespace(status_code=503)
        self.assertEqual(
            DIAGNOSTICS.safe_failure_diagnostic(
                "startup", error, MAINTENANCE.retention
            ),
            "Hosted maintenance stopped: stage=startup kind=invalid_data http_status=503",
        )
        self.assertEqual(
            DIAGNOSTICS.safe_failure_diagnostic(
                "due_check", error, MAINTENANCE.retention
            ),
            "Hosted maintenance stopped: stage=due_check kind=invalid_data http_status=503",
        )
        error.response.status_code = 700
        self.assertEqual(
            DIAGNOSTICS.safe_failure_diagnostic(
                "private-input", error, MAINTENANCE.retention
            ),
            "Hosted maintenance stopped: stage=unknown kind=invalid_data",
        )
        error.response.status_code = "503"
        self.assertEqual(
            DIAGNOSTICS.safe_failure_diagnostic(
                "unknown", error, MAINTENANCE.retention
            ),
            "Hosted maintenance stopped: stage=unknown kind=invalid_data",
        )


if __name__ == "__main__":
    unittest.main()
