"""Bounded cloud inventory collection without weaker capacity admission."""

from __future__ import annotations

import copy
import base64
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from dataclasses import asdict, replace
from contextlib import redirect_stderr, redirect_stdout

MODULE_PATH = Path(__file__).with_name("runtime-capacity-budget.py")
SPEC = importlib.util.spec_from_file_location("runtime_capacity_budget", MODULE_PATH)
assert SPEC and SPEC.loader
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
inventory = budget._inventory
CONNECTION = "hushh-pda-uat:us-central1:hushh-uat-pg"
DEV_OLD_CONNECTION = "hushh-pda-dev:us-central1:hushh-dev-pg"


class IsolatedDevCapacityCollectionTest(unittest.TestCase):
    @staticmethod
    def workload(name):
        route = {"name": "DB_UNIX_SOCKET", "value": "/cloudsql/" + DEV_OLD_CONNECTION}
        return {
            "metadata": {
                "name": name,
                "annotations": {
                    "run.googleapis.com/cloudsql-instances": DEV_OLD_CONNECTION
                },
            },
            "spec": {"containers": [{"env": [route]}]},
        }

    def isolated_fixture(self):
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        config = profile["environments"]["dev"]

        rows = {
            ("projects", "describe", config["project"]): {
                "projectId": config["project"],
                "projectNumber": "123456789012",
            },
            ("sql", "instances", "describe", config["database_instance"]): {
                "state": "RUNNABLE",
                "name": config["database_instance"],
                "project": config["project"],
                "region": "us-central1",
                "connectionName": inventory.ISOLATED_DEV_CONNECTION,
                "ipAddresses": [{"ipAddress": "192.0.2.10"}],
                "settings": {
                    "settingsVersion": "1",
                    "databaseFlags": [
                        {"name": "cloudsql.iam_authentication", "value": "on"},
                        {"name": "max_connections", "value": "100"},
                    ],
                },
            },
            ("run", "services", "list"): [
                {"metadata": {"name": name}} for name in config["non_database_services"]
            ],
            ("run", "jobs", "list"): [
                {"metadata": {"name": name}} for name in config["non_target_jobs"]
            ],
        }
        for name in config["non_database_services"]:
            current, retained = (
                self.workload(name + "-current"),
                self.workload(name + "-retained"),
            )
            rows[("run", "services", "describe", name)] = {
                "spec": {"template": copy.deepcopy(current)},
                "status": {
                    "traffic": [
                        {"revisionName": current["metadata"]["name"], "percent": 100}
                    ],
                    "latestReadyRevisionName": current["metadata"]["name"],
                },
            }
            rows[("run", "revisions", "list", "--service=" + name)] = [
                current,
                retained,
            ]
        for name in config["non_target_jobs"]:
            rows[("run", "jobs", "describe", name)] = {
                "metadata": {"name": name},
                "spec": {"template": self.workload(name + "-template")},
            }
            rows[("run", "jobs", "executions", "list", "--job=" + name)] = []
        active = "guard-observer-active"
        rows[("run", "jobs", "executions", "list", "--job=guard-observer")] = [
            {"metadata": {"name": active}}
        ]
        observed = self.workload(active)
        observed["metadata"]["labels"] = {"run.googleapis.com/job": "guard-observer"}
        rows[("run", "jobs", "executions", "describe", active)] = observed

        def read(*args):
            key = tuple(
                arg for arg in args if not arg.startswith(("--project=", "--region="))
            )
            return copy.deepcopy(rows[key])

        return profile, config, rows, read

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


class IsolatedRouteBoundaryTest(unittest.TestCase):
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


class NormalDevSecretPortTest(unittest.TestCase):
    def setUp(self):
        _profile, _config, rows, self.read = (
            IsolatedDevCapacityCollectionTest().isolated_fixture()
        )
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
        self.route_reference = row["spec"]["containers"][0]["env"][0]["valueFrom"][
            "secretKeyRef"
        ]
        self.marker = "synthetic-sensitive-secret-payload"
        self.token = "synthetic-sensitive-access-token"

    def command(self, argv, **kwargs):
        self.commands.append(argv)
        self.assertEqual(
            kwargs, dict(check=True, capture_output=True, text=True, timeout=20)
        )
        if argv == ["gcloud", "projects", "describe", "hushh-pda-dev", "--format=json"]:
            value = {"projectId": "hushh-pda-dev", "projectNumber": "123456789012"}
            if self.defect == "identity":
                value["projectId"] = "other-project"
            return subprocess.CompletedProcess(argv, 0, json.dumps(value), self.marker)
        self.assertEqual(argv, ["gcloud", "auth", "print-access-token"])
        return subprocess.CompletedProcess(argv, 0, self.token, self.marker)

    def open_response(self, request, *, timeout):
        self.assertEqual(timeout, 12)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + self.token)
        self.assertTrue(
            request.full_url.startswith("https://secretmanager.googleapis.com/v1/")
        )
        resource = request.full_url.split("/v1/", 1)[1]
        self.requests.append(resource)
        version = "projects/123456789012/secrets/synthetic-route/versions/1"
        if self.defect == "provider-exception":
            raise RuntimeError(self.marker + self.token)
        if not resource.endswith(":access"):
            self.latest_reads += 1
            if (
                self.defect == "changed" and self.latest_reads == 2
            ) or self.defect == "mounted-version":
                version = version[:-1] + "2"
            if self.defect == "out-of-project":
                version = version.replace("123456789012", "other-project")
            if self.defect == "other-secret":
                version = version.replace("synthetic-route", "different-route")
            value = {
                "name": version,
                "state": "DISABLED" if self.defect == "disabled" else "ENABLED",
            }
        else:
            self.assertRegex(
                resource,
                r"^projects/123456789012/secrets/synthetic-route/versions/[12]:access$",
            )
            version = resource.removesuffix(":access")
            payload = json.dumps(
                {
                    "db_unix_socket": "/cloudsql/" + DEV_OLD_CONNECTION,
                    "label": self.marker,
                }
            ).encode()
            if self.defect == "oversized-payload":
                prefix, suffix = b'{"padding":"', b'"}'
                payload = prefix + b"x" * (65_537 - len(prefix + suffix)) + suffix
            if self.defect == "invalid-utf8":
                payload = b'{"label":"\xff"}'
            value = {
                "name": version,
                "payload": {"data": base64.b64encode(payload).decode()},
            }
            if self.defect == "access-version":
                value["name"] = version[:-1] + "9"
            if self.defect == "invalid-base64":
                value["payload"]["data"] += "!"
        raw = json.dumps(value).encode()
        if self.defect == "oversized-response":
            raw += b" " * (131_073 - len(raw))
        return io.BytesIO(raw)

    def exercise(self, defect=None):
        self.defect, self.latest_reads = defect, 0
        self.requests, self.commands = [], []
        self.route_reference["key"] = (
            "1" if defect in {"numeric", "mounted-version"} else "latest"
        )
        opener = mock.Mock()
        opener.open.side_effect = self.open_response
        output, errors = io.StringIO(), io.StringIO()
        argv = [
            str(MODULE_PATH),
            "--environment",
            "dev",
            "--candidate-service",
            "consent-protocol-plg-qual",
            "--output",
            "json",
        ]
        with (
            mock.patch.object(budget, "gcloud_json", side_effect=self.read),
            mock.patch.object(budget._cli.subprocess, "run", side_effect=self.command),
            mock.patch.object(
                budget._cli.urllib.request, "build_opener", return_value=opener
            ) as build,
            mock.patch.object(budget.sys, "argv", argv),
            redirect_stdout(output),
            redirect_stderr(errors),
        ):
            code = budget.main()
        if build.called:
            handler = build.call_args.args[0]
            self.assertIsNone(
                handler.redirect_request(
                    None, None, 302, None, None, "https://other.invalid/"
                )
            )
        self.assertNotIn(self.marker, output.getvalue() + errors.getvalue())
        self.assertNotIn(self.token, output.getvalue() + errors.getvalue())
        self.assertNotIn(
            self.token, " ".join(part for argv in self.commands for part in argv)
        )
        return code, output.getvalue(), errors.getvalue(), self.requests

    def test_normal_dev_cli_reads_enabled_numeric_version_with_exact_factory_type(self):
        for mount in (None, "numeric"):
            with self.subTest(mount=mount):
                code, output, errors, requests = self.exercise(mount)
                self.assertEqual(code, 0, errors)
                self.assertEqual(json.loads(output)["projected_connections"], 15)
                self.assertEqual(len(requests), 2 if mount else 4)
                self.assertEqual(
                    requests[0],
                    "projects/hushh-pda-dev/secrets/synthetic-route/versions/"
                    + ("1" if mount else "latest"),
                )
                self.assertEqual(
                    requests[1],
                    "projects/123456789012/secrets/synthetic-route/versions/1:access",
                )
                if not mount:
                    self.assertEqual(requests[:2], requests[2:])

    def test_normal_dev_cli_refuses_unbound_disabled_rotated_or_oversized_secrets(self):
        for defect in (
            "identity",
            "changed",
            "disabled",
            "out-of-project",
            "other-secret",
            "mounted-version",
            "access-version",
            "oversized-payload",
            "oversized-response",
            "invalid-base64",
            "invalid-utf8",
            "provider-exception",
        ):
            with self.subTest(defect=defect):
                code, output, errors, requests = self.exercise(defect)
                self.assertEqual(code, 2)
                self.assertEqual(output, "")
                self.assertIn("capacity budget blocked", errors)
                if defect in {
                    "identity",
                    "disabled",
                    "out-of-project",
                    "other-secret",
                    "mounted-version",
                }:
                    self.assertFalse(any(path.endswith(":access") for path in requests))

    def test_ordinary_environments_never_obtain_secret_reader_authority(self):
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        with mock.patch.object(budget._cli.subprocess, "run") as command:
            for environment in ("uat", "production"):
                self.assertIsNone(
                    budget._cli.dev_route_secret_reader(profile, environment, inventory)
                )
            profile["environments"]["dev"]["project"] = "other-project"
            with self.assertRaises(budget.BudgetError):
                budget._cli.dev_route_secret_reader(profile, "dev", inventory)
        command.assert_not_called()

    def test_reader_itself_enforces_payload_and_transport_bounds_before_collector(self):
        profile = json.loads(budget.DEFAULT_PROFILE.read_text())
        entry = {
            "valueFrom": {"secretKeyRef": {"name": "synthetic-route", "key": "latest"}}
        }
        for defect in (
            None,
            "oversized-payload",
            "oversized-response",
            "invalid-base64",
            "invalid-utf8",
        ):
            self.defect, self.latest_reads = defect, 0
            self.requests, self.commands = [], []
            opener = mock.Mock()
            opener.open.side_effect = self.open_response
            with (
                self.subTest(defect=defect),
                mock.patch.object(
                    budget._cli.subprocess, "run", side_effect=self.command
                ),
                mock.patch.object(
                    budget._cli.urllib.request, "build_opener", return_value=opener
                ),
            ):
                reader = budget._cli.dev_route_secret_reader(profile, "dev", inventory)
                if defect:
                    with self.assertRaisesRegex(
                        budget.BudgetError, "secret is unavailable"
                    ) as caught:
                        reader({}, entry, "hushh-pda-dev")
                    self.assertNotIn(self.marker, str(caught.exception))
                    self.assertNotIn(self.token, str(caught.exception))
                else:
                    observed = reader({}, entry, "hushh-pda-dev")
                    self.assertIs(type(observed), inventory.ResolvedRouteSecret)
                    self.assertNotIn(self.marker, repr(observed))


class RuntimeCapacityCollectionTest(unittest.TestCase):
    def test_route_reader_failure_never_exposes_provider_payload(self):
        def refused(*_args):
            raise ValueError("synthetic-sensitive-provider-payload")

        with self.assertRaisesRegex(
            budget.BudgetError, "secret is unavailable"
        ) as caught:
            inventory._scope.observe_route_secret(refused, {}, {}, "hushh-pda-dev")
        self.assertNotIn("synthetic-sensitive-provider-payload", str(caught.exception))

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


if __name__ == "__main__":
    unittest.main()
