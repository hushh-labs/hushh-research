"""Projected secret volumes remain bound and inspected in memory."""

from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("runtime-capacity-budget.py")
SPEC = importlib.util.spec_from_file_location("runtime_capacity_budget", MODULE_PATH)
assert SPEC and SPEC.loader
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
inventory = budget._inventory
FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "runtime_capacity_fixtures",
    Path(__file__).with_name("runtime_capacity_fixtures.py"),
)
assert FIXTURE_SPEC and FIXTURE_SPEC.loader
fixtures = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(fixtures)


class MountedLatestDriftTest(unittest.TestCase):
    def isolated_fixture(self):
        return fixtures.isolated_dev_inventory(
            json.loads(budget.DEFAULT_PROFILE.read_text())
        )

    def test_mounted_latest_version_drift_refuses_inventory(self):
        profile, _config, rows, read = self.isolated_fixture()
        spec = rows[("run", "jobs", "describe", "guard-observer")]["spec"]["template"][
            "spec"
        ]
        spec["volumes"] = [
            {
                "name": "config",
                "secret": {
                    "secretName": "route",
                    "items": [{"key": "latest", "path": "config.json"}],
                },
            }
        ]
        calls = []

        def changing(_workload, _entry, _project):
            calls.append(1)
            version = 1 if len(calls) == 1 else 2
            return inventory.ResolvedRouteSecret(
                f"projects/123456789012/secrets/route/versions/{version}",
                '{"enabled":true}',
            )

        with (
            mock.patch.object(budget, "gcloud_json", side_effect=read),
            self.assertRaisesRegex(budget.BudgetError, "changed during collection"),
        ):
            budget.collect(profile, "dev", resolve_secret=changing)


class ProjectedVolumeRouteTest(unittest.TestCase):
    def test_literal_config_path_must_be_same_container_projected_secret(self):
        scope = inventory._scope
        version = "projects/123456789012/secrets/config/versions/1"

        def resolve(*_args):
            return inventory.ResolvedRouteSecret(version, '{"enabled":true}')

        workload = {
            "spec": {
                "volumes": [
                    {
                        "name": "config",
                        "secret": {
                            "secretName": "config",
                            "items": [{"key": "1", "path": "config.json"}],
                        },
                    }
                ],
                "containers": [
                    {
                        "volumeMounts": [{"name": "config", "mountPath": "/secrets"}],
                        "env": [
                            {"name": "APP_CONFIG", "value": "/secrets/config.json"}
                        ],
                    }
                ],
            }
        }
        aliases = {"hushh-pda-dev", "123456789012"}
        assert scope.non_target_routing(
            workload, {"192.0.2.10"}, aliases, resolve, []
        ) == {version}
        for defect in ("unmounted", "other-container", "traversal"):
            broken = copy.deepcopy(workload)
            if defect == "unmounted":
                broken["spec"]["containers"][0]["env"][0]["value"] = (
                    "/elsewhere/config.json"
                )
            elif defect == "other-container":
                broken["spec"]["containers"].append(
                    {"env": [{"name": "APP_CONFIG", "value": "/secrets/config.json"}]}
                )
            else:
                broken["spec"]["volumes"][0]["secret"]["items"][0]["path"] = (
                    "../config.json"
                )
            with self.subTest(defect=defect), self.assertRaises(budget.BudgetError):
                scope.non_target_routing(broken, {"192.0.2.10"}, aliases, resolve, [])

    def test_secret_volume_json_is_bound_inspected_and_rechecked(self):
        scope = inventory._scope
        aliases = {"hushh-pda-dev", "123456789012"}
        version = "projects/123456789012/secrets/config/versions/1"
        workload = {
            "spec": {
                "volumes": [
                    {
                        "name": "config",
                        "secret": {
                            "secretName": "config",
                            "items": [{"key": "latest", "path": "config.json"}],
                        },
                    }
                ]
            }
        }
        pending = []

        def resolve(_workload, _node, _project):
            return inventory.ResolvedRouteSecret(
                version,
                '{"setting":{"enabled":true},"api_url":"https://example.invalid/v1"}',
            )

        versions = scope.non_target_routing(
            workload, {"192.0.2.10"}, aliases, resolve, pending
        )
        self.assertEqual(versions, {version})
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0][2], version)
        for payload in (
            "not-json",
            "[]",
            '{"db":{"host":"192.0.2.10"}}',
            '{"instances":{"192.0.2.\\u00310":{}}}',
            '{"db":"192.0.2.10","db":"safe"}',
            '{"db":"192%252e0%252e2%252e10"}',
            '{"db":"${DB_HOST}"}',
            '{"settings":"https://example.invalid/config"}',
            '{"include":"other.json"}',
            '{"encoded_config":"opaque"}',
            '{"settings":"{\\"db\\":\\"192.0.2.10\\"}"}',
        ):
            with self.subTest(payload=payload), self.assertRaises(budget.BudgetError):
                scope.non_target_routing(
                    workload,
                    {"192.0.2.10"},
                    aliases,
                    lambda *_: inventory.ResolvedRouteSecret(version, payload),
                    [],
                )
        for bad_version in (
            "projects/other/secrets/config/versions/1",
            "projects/123456789012/secrets/other/versions/1",
        ):
            with (
                self.subTest(version=bad_version),
                self.assertRaises(budget.BudgetError),
            ):
                scope.non_target_routing(
                    workload,
                    {"192.0.2.10"},
                    aliases,
                    lambda *_: inventory.ResolvedRouteSecret(bad_version, "{}"),
                    [],
                )
        malformed = copy.deepcopy(workload)
        malformed["spec"]["volumes"][0]["secret"]["items"][0]["path"] = "../config"
        with self.assertRaises(budget.BudgetError):
            scope.non_target_routing(malformed, {"192.0.2.10"}, aliases, resolve, [])


if __name__ == "__main__":
    unittest.main()
