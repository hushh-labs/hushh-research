#!/usr/bin/env python3
"""Focused tests for bounded, fail-closed UAT capacity admission."""

from __future__ import annotations

import importlib.util
import json
import itertools
import pathlib
import subprocess
import sys
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/ci/wait-uat-capacity.py"
SPEC = importlib.util.spec_from_file_location("wait_uat_capacity", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
wait = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = wait
SPEC.loader.exec_module(wait)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class CapacityAdmissionTests(unittest.TestCase):
    def test_candidates_follow_full_scope_and_one_chat_inheritance(self) -> None:
        backend = types.SimpleNamespace(scope="backend", deploy_backend=True, deploy_frontend=False)
        frontend = types.SimpleNamespace(scope="frontend", deploy_backend=False, deploy_frontend=True)
        self.assertEqual(
            wait.capacity_args("full", backend)[-4:],
            ["--candidate-service", "consent-protocol",
             "--candidate-service", "consent-protocol-drive-worker"],
        )
        self.assertEqual(wait.capacity_args("full", frontend)[-1], "--no-candidates")
        self.assertEqual(
            wait.capacity_args("one-chat", None)[-2:],
            ["--inherit-candidate-service", "consent-protocol"],
        )

    def test_over_budget_report_is_distinct_from_query_failure(self) -> None:
        blocked = {"environment": "uat", "project": "hushh-pda-uat",
                   "phase": "pre-deploy", "admitted": False,
                   "projected_connections": 844, "admission_limit": 800}
        with patch.object(wait, "command", return_value=subprocess.CompletedProcess(
            [], 0, json.dumps(blocked), ""
        )):
            self.assertFalse(wait.capacity_report("one-chat", None)["admitted"])
        with patch.object(wait, "command", return_value=subprocess.CompletedProcess(
            [], 2, "", "job inventory drift: unprofiled overlay job"
        )):
            with self.assertRaisesRegex(wait.AdmissionError, "inventory/authentication"):
                wait.capacity_report("one-chat", None)
        with patch.object(wait, "command", return_value=subprocess.CompletedProcess(
            [], 0, "ADMIT", ""
        )):
            with self.assertRaisesRegex(wait.AdmissionError, "not JSON"):
                wait.capacity_report("one-chat", None)

    def test_capacity_report_rejects_inconsistent_admission(self) -> None:
        inconsistent = {"environment": "uat", "project": "hushh-pda-uat",
                        "phase": "pre-deploy", "admitted": True,
                        "projected_connections": 844, "admission_limit": 800}
        with patch.object(wait, "command", return_value=subprocess.CompletedProcess(
            [], 0, json.dumps(inconsistent), ""
        )):
            with self.assertRaisesRegex(wait.AdmissionError, "invalid admission shape"):
                wait.capacity_report("one-chat", None)

    def test_only_extra_jobs_with_no_missing_profiles_are_retryable(self) -> None:
        diagnostics = {
            "temporary extra": (
                "capacity budget blocked: job inventory drift: "
                "unprofiled=['one-chat-ready-123-1'], missing=[]",
                wait.TransientJobInventoryDrift,
            ),
            "missing profile": (
                "capacity budget blocked: job inventory drift: "
                "unprofiled=['temporary'], missing=['scheduled-job']",
                wait.AdmissionError,
            ),
            "no extra": (
                "capacity budget blocked: job inventory drift: unprofiled=[], missing=[]",
                wait.AdmissionError,
            ),
            "malformed extra": (
                "capacity budget blocked: job inventory drift: "
                "unprofiled=[object()], missing=[]",
                wait.AdmissionError,
            ),
            "authentication": (
                "capacity budget blocked: Cloud Run jobs list permission denied",
                wait.AdmissionError,
            ),
        }
        for label, (diagnostic, expected) in diagnostics.items():
            with self.subTest(label=label), patch.object(
                wait, "command", return_value=subprocess.CompletedProcess([], 2, "", diagnostic)
            ):
                with self.assertRaises(expected) as raised:
                    wait.capacity_report("one-chat", None)
                if expected is wait.AdmissionError:
                    self.assertNotIsInstance(raised.exception, wait.TransientJobInventoryDrift)

    def test_waits_for_capacity_and_revalidates_before_handoff(self) -> None:
        clock = FakeClock()
        backend = types.SimpleNamespace(scope="backend", deploy_backend=True, deploy_frontend=False)
        reports = [
            {"admitted": False, "projected_connections": 844, "admission_limit": 800},
            {"admitted": False, "projected_connections": 844, "admission_limit": 800},
            {"admitted": True, "projected_connections": 774, "admission_limit": 800},
            {"admitted": True, "projected_connections": 774, "admission_limit": 800},
        ]
        with (
            patch.object(wait, "verify_request") as authority,
            patch.object(wait, "resolved_scope", return_value=backend) as scope,
            patch.object(wait, "capacity_report", side_effect=reports) as capacity,
            patch.object(wait.time, "monotonic", side_effect=clock.monotonic),
            patch.object(wait.time, "sleep", side_effect=clock.sleep),
        ):
            result = wait.wait_for_capacity("a" * 40, "auto", "full",
                                            max_wait_seconds=300, poll_seconds=120)
        self.assertEqual(result, "backend")
        self.assertEqual(clock.sleeps, [120, 120])
        self.assertEqual(authority.call_count, 2)
        self.assertEqual(scope.call_count, 4)
        self.assertEqual(capacity.call_count, 4)

    def test_scope_churn_cannot_spin_past_deadline(self) -> None:
        backend = types.SimpleNamespace(scope="backend", deploy_backend=True, deploy_frontend=False)
        frontend = types.SimpleNamespace(scope="frontend", deploy_backend=False, deploy_frontend=True)
        clock = itertools.count()
        admitted = {"admitted": True, "projected_connections": 774,
                    "admission_limit": 800}
        with (
            patch.object(wait, "verify_request"),
            patch.object(wait, "resolved_scope", side_effect=itertools.cycle([backend, frontend])),
            patch.object(wait, "capacity_report", return_value=admitted),
            patch.object(wait.time, "monotonic", side_effect=lambda: next(clock)),
            patch.object(wait.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(wait.AdmissionError, "not admitted"):
                wait.wait_for_capacity("a" * 40, "auto", "full",
                                       max_wait_seconds=5, poll_seconds=1)
        sleep.assert_not_called()

    def test_admitted_query_cannot_handoff_after_deadline(self) -> None:
        clock = FakeClock()

        def slow_report(*_args):
            clock.now = 301
            return {
                "admitted": True,
                "projected_connections": 700,
                "admission_limit": 800,
            }

        with (
            patch.object(wait, "verify_request"),
            patch.object(wait, "capacity_report", side_effect=slow_report),
            patch.object(wait.time, "monotonic", side_effect=clock.monotonic),
        ):
            with self.assertRaisesRegex(wait.AdmissionError, "deadline"):
                wait.wait_for_capacity("a" * 40, "auto", "one-chat")

    def test_query_timeout_uses_remaining_budget_and_terminates_descendants(
        self,
    ) -> None:
        token = wait.QUERY_DEADLINE.set(10)
        process = unittest.mock.Mock(pid=123, returncode=-15)
        process.communicate.side_effect = [
            subprocess.TimeoutExpired(["query"], 4),
            ("", ""),
        ]
        try:
            with (
                patch.object(wait.time, "monotonic", return_value=5),
                patch.object(wait.subprocess, "Popen", return_value=process),
                patch.object(wait.os, "killpg") as kill,
            ):
                with self.assertRaisesRegex(wait.AdmissionError, "timed out"):
                    wait.command(["query"])
                self.assertEqual(
                    process.communicate.call_args_list[0].kwargs["timeout"], 4
                )
                kill.assert_called_once_with(123, wait.signal.SIGTERM)
        finally:
            wait.QUERY_DEADLINE.reset(token)

    def test_inventory_error_stops_without_sleep(self) -> None:
        with (
            patch.object(wait, "verify_request"),
            patch.object(wait, "capacity_report", side_effect=wait.AdmissionError("inventory drift")),
            patch.object(wait.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(wait.AdmissionError, "inventory drift"):
                wait.wait_for_capacity("a" * 40, "auto", "one-chat")
        sleep.assert_not_called()

    def test_temporary_job_drift_waits_then_admits_after_recheck(self) -> None:
        clock = FakeClock()
        admitted = {"admitted": True, "projected_connections": 774,
                    "admission_limit": 800}
        with (
            patch.object(wait, "verify_request") as authority,
            patch.object(wait, "capacity_report", side_effect=[
                wait.TransientJobInventoryDrift("temporary unprofiled jobs: overlay-1"),
                admitted,
                wait.TransientJobInventoryDrift("temporary unprofiled jobs: overlay-2"),
                admitted,
                admitted,
            ]) as capacity,
            patch.object(wait.time, "monotonic", side_effect=clock.monotonic),
            patch.object(wait.time, "sleep", side_effect=clock.sleep),
        ):
            scope = wait.wait_for_capacity("a" * 40, "auto", "one-chat",
                                           max_wait_seconds=300, poll_seconds=60)
        self.assertEqual(scope, "backend")
        self.assertEqual(clock.sleeps, [60, 60])
        self.assertEqual(capacity.call_count, 5)
        self.assertEqual(authority.call_count, 3)

    def test_temporary_job_drift_times_out_with_job_name(self) -> None:
        clock = FakeClock()
        with (
            patch.object(wait, "verify_request"),
            patch.object(wait, "capacity_report", side_effect=wait.TransientJobInventoryDrift(
                "temporary unprofiled jobs: overlay-1"
            )),
            patch.object(wait.time, "monotonic", side_effect=clock.monotonic),
            patch.object(wait.time, "sleep", side_effect=clock.sleep),
        ):
            with self.assertRaisesRegex(wait.AdmissionError, "overlay-1.*within 250s"):
                wait.wait_for_capacity("a" * 40, "auto", "one-chat",
                                       max_wait_seconds=250, poll_seconds=120)
        self.assertEqual(clock.sleeps, [120, 120, 10])

    def test_wait_is_bounded_and_never_exceeds_deadline(self) -> None:
        clock = FakeClock()
        blocked = {"admitted": False, "projected_connections": 844,
                   "admission_limit": 800}
        with (
            patch.object(wait, "verify_request"),
            patch.object(wait, "capacity_report", return_value=blocked),
            patch.object(wait.time, "monotonic", side_effect=clock.monotonic),
            patch.object(wait.time, "sleep", side_effect=clock.sleep),
        ):
            with self.assertRaisesRegex(wait.AdmissionError, "not admitted"):
                wait.wait_for_capacity("a" * 40, "auto", "one-chat",
                                       max_wait_seconds=250, poll_seconds=120)
        self.assertEqual(clock.sleeps, [120, 120, 10])


class WorkflowWiringTests(unittest.TestCase):
    def test_both_requests_wait_outside_shared_mutation_lock(self) -> None:
        for filename in ("deploy-uat.yml", "deploy-uat-one-chat.yml"):
            with self.subTest(workflow=filename):
                source = (ROOT / ".github/workflows" / filename).read_text()
                self.assertIn("group: uat-release-requests-", source)
                self.assertIn("queue: max", source)
                self.assertIn("  wait-capacity:\n", source)
                self.assertIn("  deploy:\n", source)
                wait_job = source.split("  wait-capacity:\n", 1)[1].split("  deploy:\n", 1)[0]
                deploy_job = source.split("  deploy:\n", 1)[1]
                self.assertNotIn("group: deploy-uat", wait_job)
                self.assertIn("group: deploy-uat", deploy_job)
                self.assertIn("scripts/ci/wait-uat-capacity.py", wait_job)
                self.assertIn("--environment uat", deploy_job)
        full = (ROOT / ".github/workflows/deploy-uat.yml").read_text()
        self.assertIn("inputs.scope == 'frontend' && 'frontend' || 'backend'", full)
        self.assertIn("needs: [select-target, wait-capacity]", full)
        self.assertLess(full.index("- name: Enforce UAT database connection budget before deployment"),
                        full.index("- name: Apply UAT DB migrations behind account deletion fence"))
        one_chat = (ROOT / ".github/workflows/deploy-uat-one-chat.yml").read_text()
        self.assertIn("group: uat-release-requests-backend", one_chat)
        self.assertIn("needs: wait-capacity", one_chat)
        self.assertLess(one_chat.index("- name: Enforce UAT database connection budget"),
                        one_chat.index("- name: Deploy and verify only the backend service"))


if __name__ == "__main__":
    unittest.main()
