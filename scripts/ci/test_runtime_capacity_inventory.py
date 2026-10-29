"""Bounded cloud inventory collection without weaker capacity admission."""

from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("runtime-capacity-budget.py")
SPEC = importlib.util.spec_from_file_location("runtime_capacity_budget", MODULE_PATH)
assert SPEC and SPEC.loader
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
inventory = budget._inventory
CONNECTION = "hushh-pda-uat:us-central1:hushh-uat-pg"


class RuntimeCapacityCollectionTest(unittest.TestCase):
    def test_file_import_consumers_resolve_the_same_checkout_without_pythonpath(
        self,
    ) -> None:
        observability = (
            MODULE_PATH.parents[2] / "deploy/observability/reconcile_capacity.py"
        )
        with tempfile.TemporaryDirectory() as cwd:
            for script in (MODULE_PATH, observability):
                with self.subTest(script=script.name):
                    result = subprocess.run(
                        [sys.executable, "-I", str(script), "--help"],
                        cwd=cwd,
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("usage:", result.stdout)

    def setUp(self) -> None:
        self.profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        # Both collector paths inspect the same synthetic inventory so their
        # results can be compared without relying on changing cloud state.
        self.profile["environments"]["production"] = copy.deepcopy(
            self.profile["environments"]["uat"]
        )
        config = self.profile["environments"]["uat"]
        self.service_names = sorted(
            [*config["services"], *config["non_database_services"]]
        )
        self.job_names = list(config["jobs"])
        self.rows: dict[tuple[str, ...], object] = {
            ("sql", "instances", "describe", config["database_instance"]): {
                "state": "RUNNABLE",
                "settings": {
                    "databaseFlags": [
                        {"name": "cloudsql.iam_authentication", "value": "on"},
                        {"name": "max_connections", "value": "1000"},
                    ]
                },
            },
            ("run", "services", "list"): [
                {"metadata": {"name": name}} for name in self.service_names
            ],
            ("run", "jobs", "list"): [
                {"metadata": {"name": name}} for name in self.job_names
            ],
        }
        for name in self.service_names:
            current = f"{name}-current"
            self.rows[("run", "services", "describe", name)] = {
                "status": {
                    "traffic": [{"revisionName": current, "percent": 100}],
                    "latestReadyRevisionName": current,
                }
            }
            self.rows[("run", "revisions", "list", f"--service={name}")] = [
                {"metadata": {"name": current, "annotations": {}}}
            ]
        for name in self.job_names:
            self.rows[("run", "jobs", "describe", name)] = {"metadata": {"name": name}}

    def read(self, *args: str) -> object:
        length = (
            3
            if args[:3] in {("run", "services", "list"), ("run", "jobs", "list")}
            else 4
        )
        return copy.deepcopy(self.rows[args[:length]])

    def test_bounded_uat_reads_preserve_complete_serial_inventory(self) -> None:
        with mock.patch.object(budget, "gcloud_json", side_effect=self.read) as serial:
            expected = budget.collect(self.profile, "production")
        lock = threading.Lock()
        overlap = {kind: threading.Event() for kind in ("services", "jobs")}
        active = {kind: 0 for kind in overlap}
        peak = active.copy()
        described: set[str] = set()
        revisions: set[str] = set()

        def read(*args: str) -> object:
            kind = args[1]
            if args[:3] == ("run", "revisions", "list"):
                name = args[3].removeprefix("--service=")
                with lock:
                    self.assertIn(name, described)
                    revisions.add(name)
            if args[:3] == ("run", "jobs", "list"):
                self.assertEqual(revisions, set(self.service_names))
            if args[:3] not in {("run", kind, "describe") for kind in overlap}:
                return self.read(*args)
            with lock:
                active[kind] += 1
                peak[kind] = max(peak[kind], active[kind])
                if active[kind] == 3:
                    overlap[kind].set()
            try:
                # This fails on the old serial collector without using a
                # wall-clock speed threshold or real cloud requests.
                self.assertTrue(
                    overlap[kind].wait(timeout=2), "independent reads stayed serial"
                )
                if kind == "services":
                    with lock:
                        described.add(args[3])
                return self.read(*args)
            finally:
                with lock:
                    active[kind] -= 1

        with mock.patch.object(budget, "gcloud_json", side_effect=read) as concurrent:
            actual = budget.collect(self.profile, "uat")
        self.assertEqual(actual, expected)
        config = self.profile["environments"]["uat"]
        self.assertEqual(
            actual,
            {
                "database_max_connections": 1000,
                "services": {
                    name: {
                        "service": self.rows[("run", "services", "describe", name)],
                        "revisions": self.rows[
                            ("run", "revisions", "list", f"--service={name}")
                        ],
                    }
                    for name in config["services"]
                },
                "jobs": {
                    name: self.rows[("run", "jobs", "describe", name)]
                    for name in self.job_names
                },
            },
        )
        self.assertCountEqual(concurrent.call_args_list, serial.call_args_list)
        self.assertEqual(peak, {"services": 3, "jobs": 3})
        self.assertEqual(active, {"services": 0, "jobs": 0})

    def test_parallel_inventory_still_rejects_incomplete_or_sql_capable_non_database_services(
        self,
    ) -> None:
        name = self.profile["environments"]["uat"]["non_database_services"][0]
        key = ("run", "revisions", "list", f"--service={name}")
        original = copy.deepcopy(self.rows)
        for defect, message in (
            (None, "revision inventory unavailable"),
            ([], "referenced revision unavailable"),
            (
                [
                    {
                        "metadata": {
                            "name": f"{name}-current",
                            "annotations": {
                                "run.googleapis.com/cloudsql-instances": CONNECTION,
                            },
                        }
                    }
                ],
                "attaches to budgeted Cloud SQL",
            ),
        ):
            with self.subTest(defect=message):
                self.rows = copy.deepcopy(original)
                self.rows[key] = defect
                with mock.patch.object(budget, "gcloud_json", side_effect=self.read):
                    with self.assertRaisesRegex(budget.BudgetError, message):
                        budget.collect(self.profile, "uat")

    def test_failed_parallel_read_joins_running_work_before_returning(self) -> None:
        running = threading.Event()
        failed = threading.Event()
        completed = threading.Event()
        release = threading.Event()
        returned = threading.Event()
        errors: list[BaseException] = []

        def read(name: str) -> dict:
            if name == "failed":
                self.assertTrue(running.wait(timeout=2))
                failed.set()
                raise budget.BudgetError("required cloud read failed")
            running.set()
            self.assertTrue(failed.wait(timeout=2))
            self.assertTrue(release.wait(timeout=2))
            completed.set()
            return {"name": name}

        def collect() -> None:
            try:
                inventory._collect_named_inventory(
                    ["failed", "running"], read, parallel=True
                )
            except BaseException as error:
                errors.append(error)
            finally:
                returned.set()

        collector = threading.Thread(target=collect)
        collector.start()
        try:
            self.assertTrue(failed.wait(timeout=2))
            self.assertFalse(
                returned.wait(timeout=0.1), "collector left a running read behind"
            )
        finally:
            release.set()
            collector.join(timeout=2)
        self.assertFalse(collector.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], budget.BudgetError)
        self.assertTrue(completed.is_set())


class ReviewedMonitoringCapacityTest(unittest.TestCase):
    def setUp(self):
        self.health = inventory._health_module()
        fixture = (
            MODULE_PATH.parents[2]
            / "consent-protocol/tests/fixtures/protected_configuration_job.json"
        )
        self.native = json.loads(
            fixture.read_text().replace("<reviewed-source-sha>", self.health.SOURCE)
        )
        self.profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        spec = importlib.util.spec_from_file_location(
            "runtime_capacity_fixtures",
            MODULE_PATH.with_name("runtime_capacity_fixtures.py"),
        )
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        self.current = fixtures.retained_production_inventory(
            self.profile, fixtures.revision
        )
        self.current["jobs"][self.health.NAME] = self.native["job"]
        self.active = []

    def read(self, *args):
        if args[:2] == ("builds", "describe"):
            return copy.deepcopy(self.native["build"])
        if args[:4] == ("run", "jobs", "executions", "list"):
            self.assertIn(
                "--filter=NOT status.completionTime>=1970-01-01T00:00:00Z", args
            )
            self.assertIn("--limit=501", args)
            return copy.deepcopy(self.active)
        if args[:3] == ("run", "jobs", "describe"):
            return copy.deepcopy(self.native["job"])
        raise AssertionError(args)

    def qualify(self):
        # A fresh adapter per attempt keeps the immutable-build cache isolated.
        return self.health.qualify(self.native["job"], lambda *args: self.read(*args))

    def test_native_monitoring_incarnation_adds_zero_without_losing_database_reservations(
        self,
    ):
        with self.assertRaisesRegex(budget.BudgetError, "job inventory drift"):
            budget.evaluate(
                self.profile, "production", self.current, phase="post-release"
            )
        without_monitor = copy.deepcopy(self.current)
        del without_monitor["jobs"][self.health.NAME]
        expected = budget.evaluate(
            self.profile, "production", without_monitor, phase="post-release"
        )
        self.current["verified_non_sql_job"] = self.qualify()
        actual = budget.evaluate(
            self.profile, "production", self.current, phase="post-release"
        )
        self.assertEqual(
            actual["projected_connections"], expected["projected_connections"]
        )
        self.assertEqual(
            actual["administrative_reserve"], expected["administrative_reserve"]
        )
        self.assertEqual(actual["jobs"][:-1], expected["jobs"])
        self.assertEqual(actual["jobs"][-1]["connections"], 0)
        self.current["verified_non_sql_job"] = actual["jobs"][-1]
        with self.assertRaises(budget.BudgetError):
            budget.evaluate(
                self.profile, "production", self.current, phase="post-release"
            )

    def test_complete_history_cannot_omit_a_known_active_execution(self):
        row = self.native["events"][-1]["protoPayload"]["response"]
        self.active = [row]
        qualified = self.qualify()
        recorded = qualified.review_history(self.native["events"])
        self.assertEqual(recorded["failed_execution_count"], 3)
        with self.assertRaises(ValueError):
            qualified.review_history(self.native["events"][:-1])

    def test_qualification_rejects_changed_source_spec_and_active_execution_overrides(
        self,
    ):
        original = copy.deepcopy(self.native)
        for changed in (
            "archive",
            "build-step",
            "image",
            "uid",
            "environment",
            "active",
            "bound",
        ):
            with self.subTest(changed=changed):
                self.native = copy.deepcopy(original)
                self.active = []
                if changed == "archive":
                    self.native["build"]["source"]["storageSource"]["generation"] = "1"
                elif changed == "build-step":
                    self.native["build"]["steps"][0]["env"] = ["PYTHONPATH=/unreviewed"]
                elif changed == "image":
                    self.native["build"]["results"]["images"][0]["digest"] = (
                        "sha256:" + "0" * 64
                    )
                elif changed == "uid":
                    self.native["job"]["metadata"]["uid"] = "replacement"
                elif changed == "environment":
                    task = self.native["job"]["spec"]["template"]["spec"]["template"][
                        "spec"
                    ]
                    task["containers"][0]["env"].append(
                        {"name": "PGHOST", "value": "unreviewed"}
                    )
                else:
                    row = copy.deepcopy(
                        self.native["events"][-1]["protoPayload"]["response"]
                    )
                    if changed == "active":
                        row["spec"]["template"]["spec"]["containers"][0]["args"] = [
                            "different.py"
                        ]
                        self.active = [row]
                    else:
                        self.active = [row] * 501
                with self.assertRaises(ValueError):
                    self.qualify()


if __name__ == "__main__":
    unittest.main()
