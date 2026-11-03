"""UAT capacity admits the auth-health job that UAT's installer creates."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

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

ROOT = Path(__file__).resolve().parents[2]
JOB = "protected-configuration-health"
INSTALLER = ROOT / "deploy/observability/auth_health_uat_job_install.py"


def installed_job() -> dict:
    """The job's shape as the UAT installer creates it: one task, no Cloud SQL."""
    return {
        "metadata": {"name": JOB},
        "spec": {
            "template": {
                "metadata": {"annotations": {}},
                "spec": {
                    "taskCount": 1,
                    "parallelism": 1,
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "env": [
                                        {"name": "AUTH_HEALTH_PROJECT", "value": "hushh-pda-uat"},
                                        {"name": "AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "value": "true"},
                                    ]
                                }
                            ]
                        }
                    },
                },
            }
        },
    }


class UatAuthHealthJobCapacityTest(unittest.TestCase):
    def test_uat_admits_the_installed_auth_health_job_at_its_ceiling(self) -> None:
        # 2026-10-30: the installer created this job in UAT without a profile entry.
        # Every UAT deploy then waited 300 s on job inventory drift and deferred.
        installer = INSTALLER.read_text()
        for flag in ("--tasks=1", "--parallelism=1"):
            self.assertIn(flag, installer)
        self.assertNotIn("cloudsql", installer)

        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        config = profile["environments"]["uat"]
        config["services"] = {"consent-protocol": config["services"]["consent-protocol"]}
        config["jobs"] = {JOB: config["jobs"][JOB]}
        serving = fixtures.revision("consent-protocol-current")
        inventory = {
            "database_max_connections": 1000,
            "services": {
                "consent-protocol": {
                    "service": {
                        "status": {
                            "traffic": [
                                {"revisionName": "consent-protocol-current", "percent": 100}
                            ]
                        }
                    },
                    "revisions": [serving],
                }
            },
            "jobs": {JOB: installed_job()},
        }

        report = budget.evaluate(profile, "uat", inventory, candidate_services=frozenset())
        self.assertEqual([(row["name"], row["connections"]) for row in report["jobs"]], [(JOB, 1)])
        self.assertTrue(report["admitted"])

        # The profile names this one job; any other unreviewed job still blocks.
        inventory["jobs"]["unreviewed-job"] = installed_job()
        with self.assertRaisesRegex(budget.BudgetError, r"unprofiled=\['unreviewed-job'\]"):
            budget.evaluate(profile, "uat", inventory, candidate_services=frozenset())


if __name__ == "__main__":
    unittest.main()
