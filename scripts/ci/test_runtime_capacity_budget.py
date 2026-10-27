"""Capacity admission contracts for deployment overlap."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("runtime-capacity-budget.py")
SPEC = importlib.util.spec_from_file_location("runtime_capacity_budget", MODULE_PATH)
assert SPEC and SPEC.loader
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "runtime_capacity_fixtures", Path(__file__).with_name("runtime_capacity_fixtures.py")
)
assert FIXTURE_SPEC and FIXTURE_SPEC.loader
fixtures = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(fixtures)

CONNECTION = "hushh-pda-uat:us-central1:hushh-uat-pg"
SETTINGS = {
    "container": "backend",
    "workers_per_instance": 2,
    "candidate": {
        "max_instances": 5,
        "workers_per_instance": 2,
        "asyncpg_pool_max": 4,
        "sqlalchemy_pool_size": 3,
        "sqlalchemy_max_overflow": 0,
    },
}


revision = fixtures.revision


class RuntimeCapacityBudgetTest(unittest.TestCase):
    def test_effective_async_pool_capacity_matches_minimum_override(self) -> None:
        for minimum, maximum, expected in (
            ("8", "4", 110),
            (None, "1", 50),
            ("0", "1", 40),
        ):
            with self.subTest(minimum=minimum, maximum=maximum):
                row = revision("consent-protocol-effective")
                env = row["spec"]["containers"][0]["env"]
                env[0]["value"] = maximum
                if minimum is not None:
                    env.append({"name": "DB_POOL_MIN_SIZE", "value": minimum})
                result = budget.revision_connections(
                    row, "consent-protocol", SETTINGS, CONNECTION
                )
                self.assertEqual(result["connections"], expected)

    def test_unbounded_or_uninspectable_pool_controls_fail_closed(self) -> None:
        controls = [
            {"name": "DB_SQLALCHEMY_USE_NULL_POOL", "value": value}
            for value in ("1", "TRUE", "yes", "on")
        ] + [
            {"name": name, "valueFrom": {"secretKeyRef": {"name": "private-setting"}}}
            for name in ("DB_POOL_MIN_SIZE", "DB_SQLALCHEMY_USE_NULL_POOL")
        ]
        for control in controls:
            with self.subTest(control=control):
                row = revision("consent-protocol-unbounded")
                container = row["spec"]["containers"][0]
                container["env"].append(control)
                with self.assertRaises(budget.BudgetError):
                    budget.revision_connections(
                        row, "consent-protocol", SETTINGS, CONNECTION
                    )
                # Jobs use the same effective-capacity contract.
                with self.assertRaises(budget.BudgetError):
                    budget.pool_capacity(container, "job", required=False)
        for minimum in ("40", "invalid"):
            with self.subTest(modifier_only=minimum), self.assertRaises(budget.BudgetError):
                budget.pool_capacity({"env": [{"name": "DB_POOL_MIN_SIZE", "value": minimum}]},
                                     "job", required=False)

    def test_frontend_only_admits_zero_incremental_sql_without_job_inventory(self) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        account = "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        current = "hushh-webapp-current"
        ready = "hushh-webapp-ready"
        candidate = "hushh-webapp-candidate"

        def workload(name: str) -> dict:
            return {
                "metadata": {"name": name, "annotations": {}},
                "spec": {"serviceAccountName": account, "containers": [{"env": []}]},
            }

        service = {
            "spec": {"template": workload("template")},
            "status": {
                "traffic": [{"revisionName": current, "percent": 100}],
                "latestReadyRevisionName": ready,
            },
        }
        revisions = {name: workload(name) for name in (current, ready, candidate)}
        project_policy = {"bindings": [{
            "role": "roles/secretmanager.secretAccessor",
            "members": [f"serviceAccount:{account}"],
        }]}

        def inventory(*args: str) -> dict:
            if args[:3] == ("projects", "get-iam-policy", "hushh-pda-uat"):
                return copy.deepcopy(project_policy)
            if args[:3] == ("run", "services", "describe"):
                self.assertEqual(args[3], "hushh-webapp")
                return copy.deepcopy(service)
            if args[:3] == ("run", "revisions", "describe"):
                return copy.deepcopy(revisions[args[3]])
            raise AssertionError(f"Unexpected global capacity inventory: {args[:3]}")

        with mock.patch.object(budget, "gcloud_json", side_effect=inventory):
            report = budget.frontend_only_report(
                profile, "uat", candidate_revision=candidate
            )
        self.assertEqual(report["admission_mode"], "frontend-only-incremental")
        self.assertEqual(report["projected_connections"], 0)
        self.assertEqual(report["verified_frontend_revisions"], sorted(revisions))
        self.assertTrue(report["admitted"])

        # The narrow lane must fail closed on a SQL-capable template or any
        # candidate, even though it intentionally does not inspect jobs.
        for change, expected in (
            (lambda: service["spec"]["template"]["metadata"]["annotations"].update(
                {"run.googleapis.com/cloudsql-instances": CONNECTION}
            ), "Cloud SQL attachment"),
            (lambda: revisions[candidate]["spec"]["containers"][0]["env"].append(
                {"name": "PGSSLMODE", "value": "redacted"}
            ), "database configuration"),
            (lambda: revisions[candidate]["spec"]["containers"][0]["env"].append(
                {"name": "GENERIC_ENDPOINT", "value": "postgresql://redacted"}
            ), "database configuration"),
            (lambda: revisions[candidate]["spec"]["containers"][0]["env"].append(
                {"name": "GENERIC_SECRET", "valueFrom": {
                    "secretKeyRef": {"name": "DB_PASSWORD", "key": "latest"}
                }}
            ), "database configuration"),
            (lambda: revisions[candidate]["spec"].update({"volumes": [{"name": "db"}]}),
             "volumes require"),
            (lambda: revisions[candidate]["spec"].update(
                {"serviceAccountName": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"}
            ), "runtime identity"),
        ):
            with self.subTest(expected=expected):
                clean_service = copy.deepcopy(service)
                clean_revisions = copy.deepcopy(revisions)
                change()
                with mock.patch.object(budget, "gcloud_json", side_effect=inventory):
                    with self.assertRaisesRegex(budget.BudgetError, expected):
                        budget.frontend_only_report(
                            profile, "uat", candidate_revision=candidate
                        )
                service = clean_service
                revisions = clean_revisions

        project_policy["bindings"].append({
            "role": "roles/cloudsql.client",
            "members": [f"serviceAccount:{account}"],
        })
        with mock.patch.object(budget, "gcloud_json", side_effect=inventory):
            with self.assertRaisesRegex(budget.BudgetError, "unreviewed project IAM role"):
                budget.frontend_only_report(profile, "uat")
        project_policy["bindings"].pop()

        with mock.patch.object(budget, "gcloud_json", side_effect=inventory):
            with self.assertRaisesRegex(budget.BudgetError, "limited to UAT"):
                budget.frontend_only_report(profile, "production")
            with self.assertRaisesRegex(budget.BudgetError, "candidate revision identity"):
                budget.frontend_only_report(
                    profile, "uat", candidate_revision="consent-protocol-123"
                )

    def test_worker_override_counts_connections_and_conflicts_fail_closed(self) -> None:
        row = revision("consent-protocol-test")
        container = row["spec"]["containers"][0]
        container["env"].append({"name": "WEB_CONCURRENCY", "value": "3"})
        self.assertEqual(
            budget.revision_connections(row, "consent-protocol", SETTINGS, CONNECTION)[
                "connections"
            ],
            105,
        )
        container["args"] = ["--workers=3"]
        self.assertEqual(
            budget.revision_connections(row, "consent-protocol", SETTINGS, CONNECTION)[
                "workers_per_instance"
            ],
            3,
        )
        for args in (
            ["--workers", "2"],
            ["-w0"],
            ["gunicorn --workers 5"],
            ["exec gunicorn server:app -w 5"],
            ["exec gunicorn server:app -w${OTHER_WORKERS}"],
            ["exec gunicorn server:app '-w' 5"],
        ):
            with self.subTest(args=args):
                container["args"] = args
                with self.assertRaises(budget.BudgetError):
                    budget.revision_connections(
                        row, "consent-protocol", SETTINGS, CONNECTION
                    )
        container["args"] = []
        container["args"] = ["-w", "3", "--worker-tmp-dir", "/tmp"]
        self.assertEqual(
            budget.revision_connections(row, "consent-protocol", SETTINGS, CONNECTION)["workers_per_instance"],
            3,
        )
        container["command"] = ["gunicorn", "--workers", "5"]
        with self.assertRaises(budget.BudgetError):
            budget.revision_connections(row, "consent-protocol", SETTINGS, CONNECTION)

    def test_environment_policy_is_atomic_and_live_limit_stays_strict(self) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        # UAT admits up to 900 projected (reserve included) of 1000 since
        # 2026-10-15: measured num_backends peaked at 256 over 7 days (median
        # 86), and a fully maxed 862 still fits under max_connections.
        self.assertEqual(budget.connection_policy(profile, "uat"), {
            "database_max_connections": 1000,
            "admission_limit": 900,
            "administrative_reserve": 100,
        })
        self.assertEqual(budget.connection_policy(profile, "production"), {
            "database_max_connections": 400,
            "admission_limit": 300,
            "administrative_reserve": 30,
        })
        for invalid in (None, {}, {"database_max_connections": 400},
                        {"database_max_connections": True, "admission_limit": 300,
                         "administrative_reserve": 30}):
            with self.subTest(invalid=invalid):
                changed = copy.deepcopy(profile)
                changed["environments"]["production"]["connection_policy"] = invalid
                with self.assertRaises(budget.BudgetError):
                    budget.connection_policy(changed, "production")
        for live in (100, 1000):
            with self.subTest(live=live), self.assertRaisesRegex(
                budget.BudgetError, f"max_connections is {live}; profile requires 400"
            ):
                budget.evaluate(profile, "production", {"database_max_connections": live})

    def test_production_admission_boundary_counts_reserve(self) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        config = profile["environments"]["production"]
        config["services"] = {}
        config["jobs"] = {"drill": {"connections_per_task": 270,
                                     "concurrent_executions": 1}}
        inventory = {"database_max_connections": 400, "services": {}, "jobs": {
            "drill": {"metadata": {"name": "drill"}, "spec": {"template": {
                "spec": {"taskCount": 1, "parallelism": 1,
                         "template": {"spec": {"containers": [{"env": []}]}}}
            }}}
        }}
        report = budget.evaluate(profile, "production", inventory)
        self.assertEqual(report["projected_connections"], 300)
        self.assertTrue(report["admitted"])
        config["jobs"]["drill"]["connections_per_task"] = 271
        self.assertFalse(budget.evaluate(profile, "production", inventory)["admitted"])

    def test_deferred_retirement_counts_multiple_old_generations_until_deletion(
        self,
    ) -> None:
        service = {
            "status": {"traffic": [{"revisionName": "app-current", "percent": 100}]}
        }
        revisions = [
            revision("app-current"),
            revision("app-recent-drain"),
            revision("app-older-drain"),
        ]
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        # Multiple older generations may still hold admitted requests. Neither
        # a zero minimum instance count nor aggregate SQL peaks prove drainage.
        for environment in ("uat", "production"):
            for configured in profile["environments"][environment]["services"].values():
                with self.subTest(environment=environment, container=configured["container"]):
                    settings = {**SETTINGS, "count_retained_revisions": configured.get("count_retained_revisions")}
                    rows = budget.service_budget("app", settings, service, revisions, CONNECTION)
                    self.assertEqual(
                        {row["name"] for row in rows}, {r["metadata"]["name"] for r in revisions}
                    )
                    self.assertEqual(sum(row["connections"] for row in rows), 210)
        # Negative control: the legacy policy reserves only one unreferenced revision.
        legacy = budget.service_budget("app", SETTINGS, service, revisions, CONNECTION)
        self.assertEqual(sum(row["connections"] for row in legacy), 140)

    def test_post_release_checks_retained_capacity_without_next_candidate(self) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        inventory = fixtures.retained_production_inventory(profile, revision)
        revisions = inventory["services"]["consent-protocol"]["revisions"]
        # The deployed candidate is already among the three retained revisions.
        # Default admission still reserves another backend and optional worker.
        next_release = budget.evaluate(profile, "production", inventory)
        self.assertEqual(next_release["phase"], "pre-deploy")
        self.assertEqual(next_release["projected_connections"], 372)
        self.assertFalse(next_release["admitted"])
        bootstrap = budget.evaluate(
            profile, "production", inventory,
            additional_candidate_services=("consent-protocol",),
        )
        self.assertEqual(bootstrap["projected_connections"], 452)
        self.assertEqual(
            next(row["connections"] for row in bootstrap["services"]
                 if row["name"] == "consent-protocol:additional-candidate"),
            80,
        )
        self.assertFalse(bootstrap["admitted"])
        for invalid in ("uat", "post-release"):
            with self.subTest(extra_candidate_refusal=invalid):
                with self.assertRaises(budget.BudgetError):
                    budget.evaluate(
                        profile, invalid if invalid == "uat" else "production", inventory,
                        phase=invalid if invalid == "post-release" else "pre-deploy",
                        additional_candidate_services=("consent-protocol",),
                    )
        with self.assertRaisesRegex(
            budget.BudgetError, "additional candidates cannot use inherited capacity"
        ):
            budget.evaluate(
                profile, "production", inventory,
                inherited_candidate_services=frozenset({"consent-protocol"}),
                additional_candidate_services=("consent-protocol",),
            )
        bridge = budget.evaluate(profile, "production", inventory, maintenance_profile="serving_backend_clone_v1")
        self.assertEqual(bridge["projected_connections"], 300)
        self.assertTrue(bridge["admitted"])
        self.assertEqual(next(row["connections"] for row in bridge["services"] if row["name"] == "consent-protocol:new-candidate"), 8)
        self.assertEqual(next(row["connections"] for row in bridge["services"] if row["name"] == "consent-protocol-drive-worker:new-candidate"), 6)
        recovering = copy.deepcopy(inventory)
        failed = copy.deepcopy(revisions[0])
        failed["metadata"]["name"] = "consent-protocol-failed-bridge"
        failed["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "1"
        failed["spec"]["containers"][0]["env"][0]["value"] = "2"
        failed["spec"]["containers"][0]["env"][1]["value"] = "2"
        recovering["services"]["consent-protocol"]["revisions"].append(failed)
        recovery = budget.evaluate(profile, "production", recovering, maintenance_profile="serving_backend_clone_v2")
        self.assertEqual(recovery["projected_connections"], 300)
        self.assertTrue(recovery["admitted"])
        self.assertEqual(next(row["connections"] for row in recovery["services"] if row["name"] == "consent-protocol:new-candidate"), 6)
        self.assertFalse(any(row["name"] == "consent-protocol-drive-worker:new-candidate" for row in recovery["services"]))
        self.assertEqual(budget.evaluate(profile, "production", recovering)["projected_connections"], 380)
        with self.assertRaises(budget.BudgetError):
            budget.evaluate(profile, "production", recovering, maintenance_profile="serving_backend_clone_v2", candidate_services=frozenset())
        with self.assertRaises(budget.BudgetError):
            budget.evaluate(profile, "production", inventory, maintenance_profile="serving_backend_clone_v1", candidate_services=frozenset({"consent-protocol"}))
        altered = copy.deepcopy(profile)
        altered["environments"]["production"]["maintenance_candidates"]["serving_backend_clone_v1"]["candidate"]["max_instances"] = 2
        with self.assertRaises(budget.BudgetError):
            budget.evaluate(altered, "production", inventory, maintenance_profile="serving_backend_clone_v1")
        current = budget.evaluate(
            profile, "production", inventory, phase="post-release"
        )
        self.assertEqual(current["projected_connections"], 3 * 80 + 16 + 30)
        self.assertEqual(len(current["services"]), 3)
        self.assertTrue(current["admitted"])
        frontend_only = budget.evaluate(
            profile,
            "production",
            inventory,
            candidate_services=frozenset(),
        )
        self.assertEqual(frontend_only["projected_connections"], current["projected_connections"])
        self.assertTrue(frontend_only["admitted"])
        with self.assertRaisesRegex(budget.BudgetError, "candidate service"):
            budget.evaluate(
                profile,
                "production",
                inventory,
                candidate_services=frozenset({"unprofiled-service"}),
            )
        with self.assertRaisesRegex(budget.BudgetError, "unsupported capacity phase"):
            budget.evaluate(profile, "production", inventory, phase="unknown")

        def cli(phase_args: list[str]) -> tuple[int, dict]:
            output = io.StringIO()
            argv = [str(MODULE_PATH), "--environment", "production", "--output", "json"]
            with (
                mock.patch.object(budget, "collect", return_value=inventory),
                mock.patch.object(budget.sys, "argv", argv + phase_args),
                redirect_stdout(output),
            ):
                code = budget.main()
            return code, json.loads(output.getvalue())

        self.assertEqual(cli([])[0], 1)
        self.assertEqual(cli(["--phase", "post-release"])[0], 0)
        self.assertEqual(cli(["--no-candidates"])[0], 0)
        # A larger pool on a draining revision remains a real capacity violation.
        revisions[-1]["spec"]["containers"][0]["env"][2]["value"] = "2"
        code, excess = cli(["--phase", "post-release"])
        self.assertEqual(excess["projected_connections"], 306)
        self.assertFalse(excess["admitted"])
        self.assertEqual(code, 1)
        overflow = revisions[-1]["spec"]["containers"][0]["env"].pop()
        with self.assertRaisesRegex(budget.BudgetError, "DB_SQLALCHEMY_MAX_OVERFLOW"):
            budget.evaluate(profile, "production", inventory, phase="post-release")
        revisions[-1]["spec"]["containers"][0]["env"].append(overflow)
        for section, name, error in (
            ("services", "consent-protocol", "service inventory differs"),
            ("jobs", "consent-protocol-genai-readiness", "job inventory drift"),
        ):
            incomplete = copy.deepcopy(inventory)
            del incomplete[section][name]
            with self.subTest(section=section), self.assertRaisesRegex(
                budget.BudgetError, error
            ):
                budget.evaluate(profile, "production", incomplete, phase="post-release")

    def test_tagged_zero_traffic_and_rollback_are_counted_once(self) -> None:
        service = {
            "status": {
                "traffic": [
                    {"revisionName": "app-serving", "percent": 100},
                    {"revisionName": "app-tagged", "tag": "candidate"},
                ],
                "latestReadyRevisionName": "app-serving",
            }
        }
        revisions = [
            revision("app-serving"),
            revision("app-tagged", overflow=2),
            revision("app-rollback", created="2026-09-30"),
        ]
        rows = budget.service_budget("app", SETTINGS, service, revisions, CONNECTION)
        self.assertEqual(
            {row["name"] for row in rows}, {"app-serving", "app-tagged", "app-rollback"}
        )
        self.assertEqual(sum(row["connections"] for row in rows), 70 + 90 + 70)
        self.assertEqual(
            budget.candidate_connections("app", SETTINGS)["connections"], 70
        )

    def test_inherited_candidate_reserves_live_template_and_serving_ceiling(self) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        config = profile["environments"]["uat"]
        config["services"] = {"consent-protocol": config["services"]["consent-protocol"]}
        config["jobs"] = {}
        serving = revision("consent-protocol-current")
        template = {
            "metadata": {
                "annotations": copy.deepcopy(serving["metadata"]["annotations"])
            },
            "spec": copy.deepcopy(serving["spec"]),
        }
        inventory = {
            "database_max_connections": 1000,
            "services": {
                "consent-protocol": {
                    "service": {
                        "spec": {"template": template},
                        "status": {
                            "traffic": [
                                {"revisionName": "consent-protocol-current", "percent": 100}
                            ]
                        },
                    },
                    "revisions": [serving],
                }
            },
            "jobs": {},
        }

        def evaluate_inherited() -> dict:
            return budget.evaluate(
                profile,
                "uat",
                inventory,
                candidate_services=frozenset({"consent-protocol"}),
                inherited_candidate_services=frozenset({"consent-protocol"}),
            )

        self.assertEqual(evaluate_inherited()["projected_connections"], 240)
        template["spec"]["containers"][0]["env"][1]["value"] = "4"
        result = evaluate_inherited()
        self.assertEqual(result["services"][-1]["connections"], 80)
        self.assertEqual(result["projected_connections"], 250)
        serving["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "6"
        result = evaluate_inherited()
        self.assertEqual(result["services"][-1]["connections"], 84)
        self.assertEqual(result["projected_connections"], 268)
        config["services"]["consent-protocol"]["candidate"]["max_instances"] = 7
        self.assertEqual(evaluate_inherited()["services"][-1]["connections"], 98)

        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            profile_path = Path(temporary) / "profile.json"
            profile_path.write_text(json.dumps(profile))
            argv = [
                str(MODULE_PATH), "--environment", "uat", "--output", "json",
                "--profile", str(profile_path),
                "--inherit-candidate-service", "consent-protocol",
            ]
            with (
                mock.patch.object(budget, "collect", return_value=inventory),
                mock.patch.object(budget.sys, "argv", argv),
                redirect_stdout(output),
            ):
                self.assertEqual(budget.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["services"][-1]["connections"], 98)

        del template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"]
        with self.assertRaisesRegex(budget.BudgetError, "revision max instances"):
            evaluate_inherited()
        template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "5"
        traffic = inventory["services"]["consent-protocol"]["service"]["status"]["traffic"]
        traffic[0]["percent"] = 50
        with self.assertRaisesRegex(budget.BudgetError, "one 100% serving revision"):
            evaluate_inherited()
        traffic[0]["percent"] = 100
        template["spec"]["containers"][0]["env"].pop()
        with self.assertRaisesRegex(budget.BudgetError, "DB_SQLALCHEMY_MAX_OVERFLOW"):
            evaluate_inherited()
        with self.assertRaisesRegex(budget.BudgetError, "reserved candidate service"):
            budget.evaluate(
                profile,
                "uat",
                inventory,
                candidate_services=frozenset(),
                inherited_candidate_services=frozenset({"consent-protocol"}),
            )

    def test_missing_revision_max_or_pool_fails_closed(self) -> None:
        source = revision("app-serving")
        del source["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"]
        with self.assertRaisesRegex(budget.BudgetError, "revision max instances"):
            budget.revision_connections(source, "app", SETTINGS, CONNECTION)
        source = revision("app-serving")
        source["spec"]["containers"][0]["env"].pop()
        with self.assertRaisesRegex(budget.BudgetError, "DB_SQLALCHEMY_MAX_OVERFLOW"):
            budget.revision_connections(source, "app", SETTINGS, CONNECTION)

    def test_job_parallelism_and_overlap_are_conservative(self) -> None:
        job = {
            "metadata": {"name": "db-job"},
            "spec": {
                "template": {
                    "metadata": {
                        "annotations": {
                            "run.googleapis.com/cloudsql-instances": CONNECTION
                        }
                    },
                    "spec": {
                        "taskCount": 4,
                        "parallelism": 3,
                        "template": {
                            "spec": {
                                "containers": [
                                    {
                                        "env": [
                                            {"name": "DB_POOL_MAX_SIZE", "value": "5"},
                                            {
                                                "name": "DB_SQLALCHEMY_POOL_SIZE",
                                                "value": "4",
                                            },
                                            {
                                                "name": "DB_SQLALCHEMY_MAX_OVERFLOW",
                                                "value": "1",
                                            },
                                        ]
                                    }
                                ]
                            }
                        },
                    },
                }
            },
        }
        row = budget.job_budget(
            job, {"connections_per_task": 8, "concurrent_executions": 2}, CONNECTION
        )
        self.assertEqual(row["connections"], 3 * 2 * 10)

    def test_budget_fails_when_cloud_sql_limit_has_not_been_verified(self) -> None:
        profile = {
            "schema_version": 1,
            "region": "us-central1",
            "database_max_connections": 1000,
            "admission_limit": 800,
            "administrative_reserve": 100,
            "environments": {
                "uat": {
                    "project": "hushh-pda-uat",
                    "database_instance": "hushh-uat-pg",
                    "services": {},
                    "jobs": {},
                }
            },
        }
        for phase in budget.CAPACITY_PHASES:
            with self.subTest(phase=phase), self.assertRaisesRegex(
                budget.BudgetError, "max_connections is 100"
            ):
                budget.evaluate(
                    profile,
                    "uat",
                    {"database_max_connections": 100, "services": {}, "jobs": {}},
                    phase=phase,
                )

    def test_optional_service_still_reserves_candidate_and_enforces_limit(self) -> None:
        optional = {
            "container": "drive-worker",
            "workers_per_instance": 1,
            "optional_existing": True,
            "candidate": {
                "max_instances": 2,
                "workers_per_instance": 1,
                "asyncpg_pool_max": 2,
                "sqlalchemy_pool_size": 1,
                "sqlalchemy_max_overflow": 0,
            },
        }
        profile = {
            "schema_version": 1,
            "region": "us-central1",
            "database_max_connections": 1000,
            "admission_limit": 800,
            "administrative_reserve": 100,
            "environments": {
                "production": {
                    "project": "hushh-pda",
                    "database_instance": "hushh-vault-db",
                    "services": {"drive-worker": optional},
                    "jobs": {},
                }
            },
        }
        inventory = {"database_max_connections": 1000, "services": {}, "jobs": {}}
        report = budget.evaluate(profile, "production", inventory)
        self.assertEqual(report["projected_connections"], 106)
        self.assertTrue(report["admitted"])
        profile["administrative_reserve"] = 795
        self.assertFalse(budget.evaluate(profile, "production", inventory)["admitted"])


if __name__ == "__main__":
    unittest.main()
