"""Fixed isolated namespace routing and explicit candidate capacity admission."""

from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from dataclasses import asdict, replace
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

revision = fixtures.revision


class IsolatedDevCapacityCollectionTest(unittest.TestCase):
    def isolated_fixture(self):
        return fixtures.isolated_dev_inventory(
            json.loads(budget.DEFAULT_PROFILE.read_text())
        )

    def test_fixed_dev_keeps_all_verified_foreign_workloads_as_zero_rows(self):
        profile, config, _rows, read = self.isolated_fixture()
        with mock.patch.object(budget, "gcloud_json", side_effect=read):
            observed = budget.collect(profile, "dev")
        self.assertEqual(
            set(observed["services"]), set(config["non_database_services"])
        )
        self.assertEqual(set(observed["jobs"]), set(config["non_target_jobs"]))
        report = budget.evaluate(
            profile,
            "dev",
            observed,
            candidate_services=frozenset({"consent-protocol-plg-qual"}),
        )
        self.assertEqual(report["projected_connections"], 15)
        self.assertEqual(len(report["services"]), 8)
        self.assertEqual(len(report["jobs"]), 5)
        for row in report["services"] + report["jobs"]:
            if row["name"].endswith(":new-candidate"):
                self.assertEqual(row["connections"], 5)
            else:
                self.assertEqual(row["connections"], 0)
                self.assertEqual(row["capacity_classification"], "not-target-instance")
        proof = observed["non_target_workloads"]
        observed["non_target_workloads"] = json.loads(json.dumps(proof._asdict()))
        with self.assertRaisesRegex(budget.BudgetError, "collector-owned"):
            budget.evaluate(profile, "dev", observed)
        for environment in ("uat", "production"):
            with (
                self.subTest(environment=environment),
                self.assertRaises(budget.BudgetError),
            ):
                inventory.isolated_dev_scope(config, "us-central1", environment)

    def test_fixed_dev_refuses_retained_active_unknown_and_opaque_routes(self):
        for defect in ("retained", "active", "unknown-job", "secret", "volume"):
            with self.subTest(defect=defect):
                profile, _config, rows, read = self.isolated_fixture()
                if defect == "retained":
                    row = rows[("run", "revisions", "list", "--service=guard-writer")][
                        1
                    ]
                    row["metadata"]["annotations"][
                        "run.googleapis.com/cloudsql-instances"
                    ] = inventory.ISOLATED_DEV_CONNECTION
                elif defect == "active":
                    row = rows[
                        (
                            "run",
                            "jobs",
                            "executions",
                            "describe",
                            "guard-observer-active",
                        )
                    ]
                    row["spec"]["containers"][0]["env"][0]["value"] = (
                        "/cloudsql/" + inventory.ISOLATED_DEV_CONNECTION
                    )
                elif defect == "unknown-job":
                    rows[("run", "jobs", "list")].append(
                        {"metadata": {"name": "unexpected-job"}}
                    )
                    rows[("run", "jobs", "describe", "unexpected-job")] = {}
                else:
                    row = rows[("run", "jobs", "describe", "guard-observer")]["spec"][
                        "template"
                    ]["spec"]
                    if defect == "secret":
                        row["containers"][0]["env"] = [
                            {
                                "name": "DB_HOST",
                                "valueFrom": {
                                    "secretKeyRef": {"name": "route", "key": "1"}
                                },
                            }
                        ]
                    else:
                        row["volumes"] = [{"name": "opaque-config"}]
                with (
                    mock.patch.object(budget, "gcloud_json", side_effect=read),
                    self.assertRaises(budget.BudgetError),
                ):
                    budget.collect(profile, "dev")

    def test_fixed_dev_route_secret_requires_actual_bound_version_and_stable_recheck(
        self,
    ):
        profile, _config, rows, read = self.isolated_fixture()
        row = rows[("run", "jobs", "describe", "guard-observer")]["spec"]["template"]
        row["metadata"]["annotations"]["run.googleapis.com/secrets"] = (
            "route-alias:projects/123456789012/secrets/synthetic-route"
        )
        row["spec"]["containers"][0]["env"] = [
            {
                "name": "BACKEND_RUNTIME_CONFIG_JSON",
                "valueFrom": {"secretKeyRef": {"name": "route-alias", "key": "latest"}},
            }
        ]
        version = "projects/123456789012/secrets/synthetic-route/versions/1"
        calls = []

        def resolve(_workload, entry, project):
            self.assertEqual(project, "hushh-pda-dev")
            self.assertEqual(
                entry["valueFrom"]["secretKeyRef"]["name"], "synthetic-route"
            )
            calls.append(entry)
            return inventory.ResolvedRouteSecret(
                version,
                '{"db_unix_socket":"/cloudsql/hushh-pda-dev:us-central1:hushh-dev-pg"}',
            )

        with mock.patch.object(budget, "gcloud_json", side_effect=read):
            result = budget.collect(profile, "dev", resolve_secret=resolve)
        self.assertEqual(len(calls), 2)
        job = next(
            row
            for row in result["non_target_workloads"].jobs
            if row["name"] == "guard-observer"
        )
        self.assertEqual(job["resolved_secret_versions"], [version])
        for failure in ("json", "other-project", "other-secret", "target", "changed"):
            calls.clear()

            def invalid(workload, entry, project):
                value = resolve(workload, entry, project)
                if failure == "json":
                    return asdict(value)
                if failure == "other-project":
                    return replace(
                        value,
                        resource_name=version.replace("123456789012", "other-project"),
                    )
                if failure == "other-secret":
                    return replace(
                        value,
                        resource_name=version.replace(
                            "synthetic-route", "different-route"
                        ),
                    )
                if failure == "target":
                    return replace(value, payload='{"db_host":"192.0.2.10"}')
                return (
                    replace(value, resource_name=version[:-1] + "2")
                    if len(calls) == 2
                    else value
                )

            with (
                self.subTest(failure=failure),
                mock.patch.object(budget, "gcloud_json", side_effect=read),
                self.assertRaises(budget.BudgetError),
            ):
                budget.collect(profile, "dev", resolve_secret=invalid)

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

    def test_qualification_candidate_is_explicit_but_all_retained_revisions_still_count(
        self,
    ) -> None:
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        config = profile["environments"]["uat"]
        name = "consent-protocol-plg-qual"
        ordinary = copy.deepcopy(config)
        settings = ordinary["services"].pop(name)
        default, rows = budget.candidate_reservations(
            config, "uat", "pre-deploy", (), None, frozenset(), None
        )
        self.assertEqual(default, frozenset(ordinary["services"]))
        self.assertEqual(rows, [])
        # Only reduce this synthetic fixture, never the live collector partition.
        config["services"] = {name: settings}
        config["jobs"] = {}
        observed = {"database_max_connections": 1000, "services": {}, "jobs": {}}
        self.assertEqual(
            budget.evaluate(profile, "uat", observed)["projected_connections"], 100
        )
        self.assertEqual(
            budget.evaluate(
                profile, "uat", observed, candidate_services=frozenset({name})
            )["projected_connections"],
            105,
        )
        retained = [
            revision(name + suffix, max_instances=1) for suffix in ("-current", "-old")
        ]
        for row in retained:
            row["spec"]["containers"][0]["env"][1]["value"] = "1"
        observed["services"][name] = {
            "service": {
                "status": {
                    "traffic": [{"revisionName": name + "-current", "percent": 100}]
                }
            },
            "revisions": retained,
        }
        for phase in budget.CAPACITY_PHASES:
            report = budget.evaluate(profile, "uat", observed, phase=phase)
            self.assertEqual(report["projected_connections"], 110)
            self.assertEqual(
                {row["name"] for row in report["services"]},
                {name + "-current", name + "-old"},
            )
        self.assertEqual(
            budget.evaluate(
                profile, "uat", observed, candidate_services=frozenset({name})
            )["projected_connections"],
            115,
        )
        for environment in ("production", "unknown"):
            with (
                self.subTest(environment=environment),
                self.assertRaises(budget.BudgetError),
            ):
                budget.candidate_reservations(
                    config, environment, "pre-deploy", (), None, frozenset(), None
                )


class IsolatedRouteBoundaryTest(unittest.TestCase):
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

    def test_real_csv_aliases_preserve_identity_and_reject_malformed_or_unresolved_maps(
        self,
    ):
        scope = inventory._scope
        aliases = {"hushh-pda-dev", "123456789012"}
        reference = {"name": "route-alias", "key": "latest"}
        resource = "projects/123456789012/secrets/synthetic-route"

        def document(encoded):
            return {
                "metadata": {"annotations": {"run.googleapis.com/secrets": encoded}}
            }

        valid = document(
            "unrelated:projects/hushh-pda-dev/secrets/other,route-alias:" + resource
        )
        self.assertEqual(
            scope.route_secret_reference(valid, reference, aliases),
            {"name": "synthetic-route", "key": "latest"},
        )
        for encoded in (
            "",
            None,
            {"route-alias": resource},
            json.dumps({"route-alias": resource}),
            "route-alias",
            "route-alias:",
            ":" + resource,
            "route-alias:" + resource + ",",
            "route-alias:" + resource + ",route-alias:" + resource,
            "route-alias:projects/other-project/secrets/synthetic-route",
            "unrelated:" + resource,
        ):
            with self.subTest(encoded=encoded), self.assertRaises(budget.BudgetError):
                scope.route_secret_reference(document(encoded), reference, aliases)
        conflicting = document("route-alias:" + resource)
        conflicting["spec"] = {
            "template": document("route-alias:projects/hushh-pda-dev/secrets/different")
        }
        with self.assertRaisesRegex(budget.BudgetError, "ambiguous"):
            scope.route_secret_reference(conflicting, reference, aliases)

    def test_service_root_mapping_cannot_fall_back_to_an_innocent_same_name_secret(
        self,
    ):
        profile, _config, rows, read = (
            IsolatedDevCapacityCollectionTest().isolated_fixture()
        )
        service = rows[("run", "services", "describe", "guard-api")]
        service["metadata"] = {
            "annotations": {
                "run.googleapis.com/secrets": "innocent:projects/123456789012/secrets/actual-route"
            }
        }
        service["spec"]["template"]["spec"]["containers"][0]["env"] = [
            {
                "name": "PGHOSTADDR",
                "valueFrom": {"secretKeyRef": {"name": "innocent", "key": "1"}},
            }
        ]
        calls = []

        def resolve(_workload, entry, _project):
            name = entry["valueFrom"]["secretKeyRef"]["name"]
            calls.append(name)
            return inventory.ResolvedRouteSecret(
                "projects/123456789012/secrets/" + name + "/versions/1",
                "192.0.2.10" if name == "actual-route" else "192.0.2.20",
            )

        for target in ("actual-route", "innocent"):
            calls.clear()
            if target == "innocent":
                retained = rows[("run", "revisions", "list", "--service=guard-api")][1]
                retained["spec"]["containers"][0]["env"] = copy.deepcopy(
                    service["spec"]["template"]["spec"]["containers"][0]["env"]
                )

            def scoped_resolve(workload, entry, project):
                value = resolve(workload, entry, project)
                name = entry["valueFrom"]["secretKeyRef"]["name"]
                return replace(
                    value, payload="192.0.2.10" if name == target else "192.0.2.20"
                )

            with (
                self.subTest(target=target),
                mock.patch.object(budget, "gcloud_json", side_effect=read),
                self.assertRaisesRegex(budget.BudgetError, "references isolated"),
            ):
                budget.collect(profile, "dev", resolve_secret=scoped_resolve)
            self.assertEqual(
                calls,
                ["actual-route"]
                if target == "actual-route"
                else ["actual-route", "innocent"],
            )

    def test_route_secrets_and_nested_config_never_hide_target_or_interpolation(self):
        scope = inventory._scope
        version = "projects/123456789012/secrets/route/versions/1"
        for name in ("PGHOSTADDR", "INSTANCE_CONNECTION_NAME", "BACKEND_CONFIG_JSON"):
            for defect in ("target", "unresolved", "reader-refusal"):
                with self.subTest(name=name, defect=defect):
                    entry = {
                        "name": name,
                        "valueFrom": {"secretKeyRef": {"name": "route", "key": "1"}},
                    }
                    payload = "192.0.2.10" if defect == "target" else "${ROUTE_HOST}"
                    if name.endswith("JSON"):
                        payload = json.dumps({"database": {"host": payload}})

                    def resolve(*_args):
                        if defect == "reader-refusal":
                            raise ValueError("unsupported routing input")
                        return inventory.ResolvedRouteSecret(version, payload)

                    with self.assertRaises(budget.BudgetError):
                        scope.non_target_routing(
                            {"env": [entry]},
                            {"192.0.2.10"},
                            {"123456789012"},
                            resolve,
                            [],
                        )


if __name__ == "__main__":
    unittest.main()
