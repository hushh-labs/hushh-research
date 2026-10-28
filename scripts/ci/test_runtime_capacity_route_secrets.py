"""Normal-identity DEV route-secret reader boundaries without cloud authority."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
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

DEV_OLD_CONNECTION = fixtures.DEV_OLD_CONNECTION


class NormalDevSecretPortTest(unittest.TestCase):
    def setUp(self):
        _profile, _config, rows, self.read = fixtures.isolated_dev_inventory(
            json.loads(budget.DEFAULT_PROFILE.read_text())
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

    def test_route_reader_failure_never_exposes_provider_payload(self):
        def refused(*_args):
            raise ValueError("synthetic-sensitive-provider-payload")

        with self.assertRaisesRegex(
            budget.BudgetError, "secret is unavailable"
        ) as caught:
            inventory._scope.observe_route_secret(refused, {}, {}, "hushh-pda-dev")
        self.assertNotIn("synthetic-sensitive-provider-payload", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
