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
        self.profile["environments"]["production"].pop("external_database_workloads")
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
            5
            if args[:3] == ("secrets", "versions", "describe")
            or args[:4] == ("run", "jobs", "executions", "list")
            else (
                3
                if args[:2] == ("secrets", "describe")
                else (
                    3
                    if args[:3]
                    in {("run", "services", "list"), ("run", "jobs", "list")}
                    else 4
                )
            )
        )
        return copy.deepcopy(self.rows[args[:length]])

    def add_external_one(self) -> None:
        external = self.profile["environments"]["uat"]["external_database_workloads"]
        connection = external["connection_name"]
        annotations = {"run.googleapis.com/cloudsql-instances": connection}
        secret = external["database_secret"]

        def runtime_spec(image: str) -> dict:
            return {
                "serviceAccountName": external["runtime_account"],
                "containers": [
                    {
                        "image": image,
                        "env": [
                            {
                                "name": "DATABASE_URL",
                                "valueFrom": {
                                    "secretKeyRef": {
                                        "name": secret["name"],
                                        "key": secret["version"],
                                    }
                                },
                            }
                        ],
                    }
                ],
            }

        service = external["service"]
        revision_name = "one-uat-00001-mzl"
        revision = {
            "metadata": {
                "name": revision_name,
                "uid": service["revisions"][revision_name]["uid"],
                "namespace": external["namespace"],
                "annotations": copy.deepcopy(annotations),
            },
            "spec": runtime_spec(service["image"]),
        }
        service_doc = {
            "metadata": {
                "name": "one-uat",
                "uid": service["uid"],
                "namespace": external["namespace"],
                "creationTimestamp": service["created"],
                "generation": 1,
            },
            "spec": {
                "template": {
                    "metadata": {"annotations": copy.deepcopy(annotations)},
                    "spec": runtime_spec(service["image"]),
                }
            },
            "status": {
                "traffic": [{"revisionName": revision_name, "percent": 100}],
                "latestReadyRevisionName": revision_name,
            },
        }
        service["spec_sha256"] = inventory._fingerprint(service_doc["spec"])
        service["revisions"][revision_name]["spec_sha256"] = inventory._fingerprint(
            revision["spec"]
        )

        job = external["job"]
        job_task = runtime_spec(job["image"])
        job_doc = {
            "metadata": {
                "name": "one-uat-migrate",
                "uid": job["uid"],
                "namespace": external["namespace"],
                "creationTimestamp": job["created"],
                "generation": 1,
            },
            "spec": {
                "template": {
                    "metadata": {"annotations": copy.deepcopy(annotations)},
                    "spec": {"template": {"spec": job_task}},
                }
            },
        }
        execution = {
            "metadata": {
                "name": "one-uat-migrate-sample",
                "namespace": external["namespace"],
                "annotations": copy.deepcopy(annotations),
                "ownerReferences": [
                    {
                        "kind": "Job",
                        "name": "one-uat-migrate",
                        "uid": job["uid"],
                        "apiVersion": "serving.knative.dev/v1",
                        "controller": True,
                        "blockOwnerDeletion": True,
                    }
                ],
            },
            "spec": {"template": {"spec": job_task}},
            "status": {"completionTime": "2026-11-07T00:02:40Z"},
        }
        job["spec_sha256"] = inventory._fingerprint(job_doc["spec"])
        job["execution_spec_sha256"] = inventory._fingerprint(execution["spec"])

        self.rows[("run", "services", "list")].append({"metadata": {"name": "one-uat"}})
        self.rows[("run", "services", "describe", "one-uat")] = service_doc
        self.rows[("run", "revisions", "list", "--service=one-uat")] = [revision]
        self.rows[("run", "jobs", "list")].append(
            {"metadata": {"name": "one-uat-migrate"}}
        )
        self.rows[("run", "jobs", "describe", "one-uat-migrate")] = job_doc
        self.rows[("run", "jobs", "executions", "list", "--job=one-uat-migrate")] = [
            execution
        ]
        self.rows[("secrets", "describe", secret["name"])] = {
            "name": f"projects/{external['namespace']}/secrets/{secret['name']}",
            "createTime": secret["resource_created"],
        }
        self.rows[
            (
                "secrets",
                "versions",
                "describe",
                secret["version"],
                f"--secret={secret['name']}",
            )
        ] = {
            "name": f"projects/{external['namespace']}/secrets/{secret['name']}/versions/{secret['version']}",
            "createTime": secret["version_created"],
            "state": "ENABLED",
        }

    def test_external_one_is_bound_to_its_separate_database_and_exact_workloads(
        self,
    ) -> None:
        self.add_external_one()
        with mock.patch.object(budget, "gcloud_json", side_effect=self.read):
            result = budget.collect(self.profile, "uat")
        service_rows, job_rows = inventory.non_target_rows(
            result["non_target_workloads"],
            self.profile["environments"]["uat"],
            "uat",
            "us-central1",
        )
        self.assertEqual([row["name"] for row in service_rows], ["one-uat"])
        self.assertEqual([row["name"] for row in job_rows], ["one-uat-migrate"])
        isolated_profile = copy.deepcopy(self.profile)
        isolated_profile["environments"]["uat"]["services"] = {}
        isolated_profile["environments"]["uat"]["jobs"] = {}
        isolated_inventory = {
            **result,
            "services": {"one-uat": result["services"]["one-uat"]},
            "jobs": {"one-uat-migrate": result["jobs"]["one-uat-migrate"]},
        }
        report = budget.evaluate(isolated_profile, "uat", isolated_inventory)
        self.assertEqual(
            report["projected_connections"], report["administrative_reserve"]
        )
        self.assertEqual({row["name"] for row in report["services"]}, {"one-uat"})
        self.assertEqual({row["name"] for row in report["jobs"]}, {"one-uat-migrate"})
        with self.assertRaisesRegex(budget.BudgetError, "service inventory differs"):
            budget.evaluate(
                isolated_profile,
                "uat",
                {**isolated_inventory, "non_target_workloads": None},
            )

        original = copy.deepcopy(self.rows)
        for defect, mutate, error in (
            (
                "shared SQL attachment",
                lambda rows: rows[("run", "revisions", "list", "--service=one-uat")][0][
                    "metadata"
                ]["annotations"].update(
                    {"run.googleapis.com/cloudsql-instances": CONNECTION}
                ),
                "attaches to budgeted Cloud SQL",
            ),
            (
                "secret alias remap",
                lambda rows: rows[("run", "revisions", "list", "--service=one-uat")][0][
                    "metadata"
                ]["annotations"].update(
                    {
                        "run.googleapis.com/secrets": "one-uat-database-url:projects/other/secrets/shared-db"
                    }
                ),
                "secret alias drift",
            ),
            (
                "migration routed to shared SQL",
                lambda rows: rows[
                    ("run", "jobs", "executions", "list", "--job=one-uat-migrate")
                ][0]["metadata"]["annotations"].update(
                    {"run.googleapis.com/cloudsql-instances": CONNECTION}
                ),
                "SQL attachment drift",
            ),
            (
                "recreated secret version",
                lambda rows: rows[
                    (
                        "secrets",
                        "versions",
                        "describe",
                        "1",
                        "--secret=one-uat-database-url",
                    )
                ].update({"createTime": "2026-11-07T01:00:00Z"}),
                "secret incarnation drift",
            ),
            (
                "new retained revision",
                lambda rows: rows[
                    ("run", "revisions", "list", "--service=one-uat")
                ].append(
                    copy.deepcopy(
                        rows[("run", "revisions", "list", "--service=one-uat")][0]
                    )
                ),
                "retained revision drift",
            ),
            (
                "active migration",
                lambda rows: rows[
                    ("run", "jobs", "executions", "list", "--job=one-uat-migrate")
                ][0]["status"].clear(),
                "still active",
            ),
            (
                "unknown service",
                lambda rows: rows[("run", "services", "list")].append(
                    {"metadata": {"name": "unreviewed-service"}}
                ),
                "unprofiled",
            ),
        ):
            with self.subTest(defect=defect):
                self.rows = copy.deepcopy(original)
                mutate(self.rows)
                with (
                    mock.patch.object(budget, "gcloud_json", side_effect=self.read),
                    self.assertRaisesRegex(budget.BudgetError, error),
                ):
                    budget.collect(self.profile, "uat")

    def test_optional_personal_backend_cannot_attach_to_uat_sql(self) -> None:
        for name in ("backend-dev-ankit", "backend-dev-akshat"):
            with self.subTest(service=name):
                revision = f"{name}-revision"
                self.rows[("run", "services", "list")].append(
                    {"metadata": {"name": name}}
                )
                self.rows[("run", "services", "describe", name)] = {
                    "status": {
                        "traffic": [{"revisionName": revision, "percent": 100}],
                        "latestReadyRevisionName": revision,
                    },
                }
                metadata = {
                    "name": revision,
                    "annotations": {
                        "run.googleapis.com/cloudsql-instances": f"hushh-pda-uat:us-central1:{name}-pg",
                    },
                }
                self.rows[("run", "revisions", "list", f"--service={name}")] = [
                    {"metadata": metadata},
                ]
                with mock.patch.object(budget, "gcloud_json", side_effect=self.read):
                    self.assertNotIn(
                        name, budget.collect(self.profile, "uat")["services"]
                    )
                    with mock.patch.dict(
                        metadata["annotations"],
                        {"run.googleapis.com/cloudsql-instances": CONNECTION},
                    ):
                        with self.assertRaisesRegex(
                            budget.BudgetError, "attaches to budgeted Cloud SQL"
                        ):
                            budget.collect(self.profile, "uat")

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
        proof = actual.pop("non_target_workloads")
        self.assertEqual(proof.services, ())
        self.assertEqual(proof.jobs, ())
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


if __name__ == "__main__":
    unittest.main()
