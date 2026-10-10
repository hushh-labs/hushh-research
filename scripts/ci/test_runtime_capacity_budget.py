"""Capacity admission contracts for deployment overlap."""

from __future__ import annotations

import importlib.util
import copy
import json
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("runtime-capacity-budget.py")
SPEC = importlib.util.spec_from_file_location("runtime_capacity_budget", MODULE_PATH)
assert SPEC and SPEC.loader
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)

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


def revision(
    name: str, *, max_instances: int = 5, overflow: int = 0, created: str = "2026-10-01"
) -> dict:
    return {
        "metadata": {
            "name": name,
            "creationTimestamp": created,
            "annotations": {
                "autoscaling.knative.dev/maxScale": str(max_instances),
                "run.googleapis.com/cloudsql-instances": CONNECTION,
            },
        },
        "spec": {
            "containers": [
                {
                    "name": "backend",
                    "env": [
                        {"name": "DB_POOL_MAX_SIZE", "value": "4"},
                        {"name": "DB_SQLALCHEMY_POOL_SIZE", "value": "3"},
                        {"name": "DB_SQLALCHEMY_MAX_OVERFLOW", "value": str(overflow)},
                    ],
                }
            ]
        },
    }


class RuntimeCapacityBudgetTest(unittest.TestCase):
    def test_environment_policy_is_atomic_and_live_limit_stays_strict(self) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        self.assertEqual(budget.connection_policy(profile, "uat"), {
            "database_max_connections": 1000,
            "admission_limit": 800,
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
        settings = {**SETTINGS, "count_retained_revisions": True}
        rows = budget.service_budget("app", settings, service, revisions, CONNECTION)
        self.assertEqual(
            {row["name"] for row in rows}, {r["metadata"]["name"] for r in revisions}
        )
        self.assertEqual(sum(row["connections"] for row in rows), 210)
        # Negative control: the legacy policy reserves only one unreferenced revision.
        legacy = budget.service_budget("app", SETTINGS, service, revisions, CONNECTION)
        self.assertEqual(sum(row["connections"] for row in legacy), 140)

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
        with self.assertRaisesRegex(budget.BudgetError, "max_connections is 100"):
            budget.evaluate(
                profile,
                "uat",
                {"database_max_connections": 100, "services": {}, "jobs": {}},
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
