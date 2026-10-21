"""The maintenance bridge never promotes traffic or repeats an uncertain create."""

from __future__ import annotations

import base64
import copy
import importlib
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

bridge = importlib.import_module("production-capacity-bridge")
IMAGE = bridge.FROZEN_IMAGE
SHA = "b" * 40


def source():
    return {
        "metadata": {
            "name": "consent-protocol-source",
            "namespace": "1234",
            "creationTimestamp": "2026-10-20T10:00:00Z",
            "labels": {"deploy-sha": SHA},
            "annotations": {
                "autoscaling.knative.dev/maxScale": "5",
                "autoscaling.knative.dev/minScale": "0",
                "run.googleapis.com/cloudsql-instances": "hushh-pda:us-central1:hushh-vault-db",
            },
        },
        "spec": {
            "serviceAccountName": "original-runtime@example.invalid",
            "timeoutSeconds": 3600,
            "containers": [
                {
                    "name": "consent-protocol",
                    "image": "mutable-original-tag",
                    "env": [
                        {
                            "name": "DB_PASSWORD",
                            "valueFrom": {
                                "secretKeyRef": {"name": "DB_PASSWORD", "key": "latest"}
                            },
                        },
                        {"name": "DB_POOL_MIN_SIZE", "value": "1"},
                        {"name": "DB_POOL_MAX_SIZE", "value": "4"},
                        {"name": "DB_SQLALCHEMY_POOL_SIZE", "value": "4"},
                        {"name": "DB_SQLALCHEMY_MAX_OVERFLOW", "value": "0"},
                        {"name": "WEB_CONCURRENCY", "value": "2"},
                    ],
                    "resources": {"limits": {"cpu": "2", "memory": "2Gi"}},
                    "startupProbe": {
                        "tcpSocket": {"port": 8080},
                        "timeoutSeconds": 240,
                    },
                }
            ],
        },
        "status": {"imageDigest": IMAGE},
    }


def pins():
    return {
        "DB_PASSWORD": {
            "version": "projects/1234/secrets/DB_PASSWORD/versions/7",
            "unchangedSinceSource": True,
        }
    }


def inventory():
    row = source()
    service = {
        "metadata": {
            "name": "consent-protocol",
            "namespace": "1234",
            "resourceVersion": "precondition",
            "annotations": {"run.googleapis.com/maxScale": "5"},
        },
        "spec": {
            "template": {"spec": row["spec"]},
            "traffic": [{"latestRevision": True, "percent": 100}],
        },
        "status": {
            "latestCreatedRevisionName": "consent-protocol-displaced",
            "latestReadyRevisionName": "consent-protocol-displaced",
            "traffic": [
                {
                    "revisionName": row["metadata"]["name"],
                    "percent": 100,
                    "tag": "healthy",
                }
            ],
        },
    }
    return {
        "services": {"consent-protocol": {"service": service, "revisions": [row]}},
        "jobs": {},
        "database_max_connections": 400,
    }


class BridgeTests(unittest.TestCase):
    def test_bootstrap_keeps_listener_headroom_and_overrides_the_real_frozen_launcher(
        self,
    ):
        template = bridge.clone_template(
            source(), pins(), "consent-protocol-displaced", bridge.PROFILE
        )
        container = template["spec"]["containers"][0]
        self.assertEqual(container["command"], ["gunicorn"])
        self.assertEqual(
            container["args"],
            [
                "server:app",
                "-w",
                "1",
                "-c",
                "gunicorn.conf.py",
                "-k",
                "uvicorn.workers.UvicornWorker",
                "--timeout",
                "120",
                "--graceful-timeout",
                "8",
                "-b",
                "0.0.0.0:8080",
            ],
        )
        env = {row["name"]: row.get("value") for row in container["env"]}
        # Both frozen consent/referral LISTEN loops retain a pool connection.
        # Keep two additional slots for mandatory startup and normal work.
        self.assertEqual(env["DB_POOL_MAX_SIZE"], "4")
        self.assertEqual(env["DB_SQLALCHEMY_POOL_SIZE"], "2")
        self.assertEqual(env["WEB_CONCURRENCY"], "1")
        profile = json.loads(bridge.budget.DEFAULT_PROFILE.read_text())
        bridge.verify_profile(template, profile, bridge.PROFILE)
        container["args"][2] = "2"
        with self.assertRaisesRegex(bridge.budget.BudgetError, "conflicting worker"):
            bridge.verify_profile(template, profile, bridge.PROFILE)
        changed = source()
        changed["status"]["imageDigest"] = IMAGE.replace("ae6f", "be6f")
        with self.assertRaisesRegex(
            bridge.retention.UnsafeState, "reviewed frozen image"
        ):
            bridge.clone_template(
                changed, pins(), "consent-protocol-displaced", bridge.PROFILE
            )

    def test_unhealthy_predecessor_is_preserved_and_only_the_observed_successor_is_reconciled(
        self,
    ):
        observed = inventory()
        original = observed["services"][bridge.SERVICE]["revisions"][0]
        service = observed["services"][bridge.SERVICE]["service"]
        old_traffic = bridge.traffic(service)
        controls = bridge.service_controls(service)
        legacy = bridge.clone_template(original, pins(), "consent-protocol-displaced")
        legacy["status"] = {
            "imageDigest": IMAGE,
            "conditions": [{"type": "Ready", "status": "False"}],
        }
        old_name = legacy["metadata"]["name"]
        observed["services"][bridge.SERVICE]["revisions"].append(legacy)
        service["status"].update(
            latestCreatedRevisionName=old_name,
            latestReadyRevisionName=original["metadata"]["name"],
        )
        service["status"]["traffic"].append(
            {
                "revisionName": old_name,
                "percent": 0,
                "tag": "capacity-" + old_name.rsplit("-", 1)[-1],
                "url": "https://predecessor-example.a.run.app",
            }
        )
        prior = {
            "version": 1,
            "project": bridge.PROJECT,
            "service": bridge.SERVICE,
            "sourceFingerprint": bridge.fingerprint(
                [original["metadata"]["name"], original["spec"], IMAGE]
            ),
            "serviceControlsFingerprint": controls,
            "sourceRevision": original["metadata"]["name"],
            "revision": old_name,
            "pins": pins(),
            "displacedLatestRevision": "consent-protocol-displaced",
            "traffic": old_traffic,
            "status": "intent",
            "requested": True,
        }
        release = {
            "sha": SHA,
            "final": {"backend_revision": original["metadata"]["name"]},
        }
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "completed.json"
            checkpoint.write_text(json.dumps({"capacity_bridge": prior}))

            def create(command, **_):
                saved = json.loads(checkpoint.read_text())["capacity_bridge"]
                self.assertEqual(saved["predecessor"]["status"], "intent")
                self.assertEqual(saved["predecessor"]["revision"], old_name)
                self.assertEqual(saved["profile"], bridge.PROFILE)
                body = json.loads(Path(command[4]).read_text())
                candidate = copy.deepcopy(body["spec"]["template"])
                candidate["status"] = {
                    "imageDigest": IMAGE,
                    "conditions": [{"type": "Ready", "status": "True"}],
                }
                observed["services"][bridge.SERVICE]["revisions"].append(candidate)
                service["spec"] = body["spec"]
                service["status"].update(
                    latestCreatedRevisionName=candidate["metadata"]["name"],
                    latestReadyRevisionName=candidate["metadata"]["name"],
                )
                service["status"]["traffic"] = copy.deepcopy(body["spec"]["traffic"])
                service["status"]["traffic"][-1]["url"] = (
                    "https://successor-example.a.run.app"
                )
                self.assertIn(
                    old_name, [row["revisionName"] for row in body["spec"]["traffic"]]
                )
                raise subprocess.TimeoutExpired(command, 150)

            with (
                mock.patch.dict(
                    bridge.os.environ,
                    {
                        "GITHUB_EVENT_NAME": "workflow_dispatch",
                        "GITHUB_REF_NAME": "main",
                    },
                ),
                mock.patch.object(
                    bridge.budget,
                    "collect",
                    side_effect=lambda *a: copy.deepcopy(observed),
                ),
                mock.patch.object(
                    bridge.budget, "evaluate", return_value={"admitted": True}
                ),
                mock.patch.object(bridge, "SecretMetadata") as secrets,
                mock.patch.object(
                    bridge.retention, "run_command", side_effect=create
                ) as mutate,
                mock.patch.object(
                    bridge.urllib.request,
                    "urlopen",
                    return_value=BytesIO(b'{"status":"healthy"}'),
                ),
            ):
                secrets.return_value.get.side_effect = lambda resource: {
                    "state": "ENABLED",
                    "name": resource,
                }
                # Absence of the exact predecessor is still an unknown provider
                # outcome. Explicit recovery cannot authorize blind creation.
                observed["services"][bridge.SERVICE]["revisions"].remove(legacy)
                with self.assertRaisesRegex(
                    bridge.retention.MutationUncertain, "supersession forbidden"
                ):
                    bridge.maintain(release, checkpoint, create=True)
                mutate.assert_not_called()
                observed["services"][bridge.SERVICE]["revisions"].append(legacy)
                # Only predecessor observation can accept this unready clone.
                # A candidate still needs both provider readiness and health.
                with self.assertRaisesRegex(
                    bridge.retention.MutationUncertain, "readiness"
                ):
                    bridge.verify_clone(
                        legacy,
                        bridge.clone_template(
                            original, pins(), "consent-protocol-displaced"
                        ),
                        service,
                        old_traffic,
                        json.loads(bridge.budget.DEFAULT_PROFILE.read_text()),
                        controls,
                    )
                with self.assertRaises(bridge.retention.MutationUncertain):
                    bridge.maintain(release, checkpoint, create=True)
                bridge.maintain(release, checkpoint, create=False)
                saved = bridge.receipt_state(
                    json.loads(checkpoint.read_text())["capacity_bridge"]
                )
                self.assertEqual(saved["status"], "verified")
                self.assertEqual(saved["predecessor"]["status"], "intent")
                self.assertEqual(
                    saved["predecessorObservation"], "provider_observed_unhealthy"
                )
                self.assertEqual(mutate.call_count, 1)
                saved["predecessor"]["revision"] = "consent-protocol-cap-" + "f" * 16
                with self.assertRaisesRegex(
                    bridge.retention.UnsafeState, "predecessor evidence"
                ):
                    bridge.receipt_state(saved)

    def test_changed_source_workers_fail_actual_capacity_admission_before_mutation(
        self,
    ):
        observed = inventory()
        env = observed["services"]["consent-protocol"]["revisions"][0]["spec"][
            "containers"
        ][0]["env"]
        next(row for row in env if row["name"] == "WEB_CONCURRENCY")["value"] = "3"
        release = {"sha": SHA, "final": {"backend_revision": "consent-protocol-source"}}
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "completed.json"
            checkpoint.write_text("{}")
            with (
                mock.patch.dict(
                    bridge.os.environ,
                    {
                        "GITHUB_EVENT_NAME": "workflow_dispatch",
                        "GITHUB_REF_NAME": "main",
                    },
                ),
                mock.patch.object(bridge.budget, "collect", return_value=observed),
                mock.patch.object(bridge, "SecretMetadata"),
                mock.patch.object(bridge, "secret_pins", return_value=pins()),
                mock.patch.object(bridge.retention, "run_command") as mutate,
            ):
                with self.assertRaisesRegex(
                    bridge.retention.UnsafeState, "source worker declaration"
                ):
                    bridge.maintain(release, checkpoint, create=True)
                mutate.assert_not_called()
                self.assertNotIn("capacity_bridge", json.loads(checkpoint.read_text()))

    def test_successful_clone_reconciles_without_recreation_after_normal_tag_retirement(
        self,
    ):
        release = {"sha": SHA, "final": {"backend_revision": "consent-protocol-source"}}
        observed = inventory()
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "completed.json"
            checkpoint.write_text("{}")

            def create(command, **_):
                body = json.loads(Path(command[4]).read_text())
                template = body["spec"]["template"]
                revision = copy.deepcopy(template)
                revision["status"] = {
                    "imageDigest": IMAGE,
                    "conditions": [{"type": "Ready", "status": "True"}],
                }
                observed["services"]["consent-protocol"]["revisions"].append(revision)
                service = observed["services"]["consent-protocol"]["service"]
                service["spec"] = body["spec"]
                service["status"].update(
                    latestCreatedRevisionName=template["metadata"]["name"],
                    latestReadyRevisionName=template["metadata"]["name"],
                )
                service["status"]["traffic"] = copy.deepcopy(body["spec"]["traffic"])
                service["status"]["traffic"][-1]["url"] = (
                    "https://capacity-example.a.run.app"
                )

            with (
                mock.patch.dict(
                    bridge.os.environ,
                    {
                        "GITHUB_EVENT_NAME": "workflow_dispatch",
                        "GITHUB_REF_NAME": "main",
                    },
                ),
                mock.patch.object(
                    bridge.budget,
                    "collect",
                    side_effect=lambda *a: copy.deepcopy(observed),
                ),
                mock.patch.object(
                    bridge.budget, "evaluate", return_value={"admitted": True}
                ),
                mock.patch.object(bridge, "SecretMetadata"),
                mock.patch.object(bridge, "secret_pins", return_value=pins()),
                mock.patch.object(
                    bridge.retention, "run_command", side_effect=create
                ) as mutate,
                mock.patch.object(
                    bridge.urllib.request,
                    "urlopen",
                    return_value=BytesIO(b'{"status":"healthy"}'),
                ) as health,
            ):
                bridge.maintain(release, checkpoint, create=True)
                receipt = json.loads(checkpoint.read_text())["capacity_bridge"]
                self.assertEqual(receipt["status"], "verified")
                self.assertEqual(mutate.call_count, 1)
                self.assertEqual(health.call_count, 1)
                # The ordinary retention helper removes the temporary zero-percent
                # tag. An explicit rerun must reconcile that completed operation.
                service = observed["services"]["consent-protocol"]["service"]
                service["status"]["traffic"] = [
                    row for row in service["status"]["traffic"] if row.get("percent")
                ]
                bridge.maintain(release, checkpoint, create=True)
                self.assertEqual(
                    json.loads(checkpoint.read_text())["capacity_bridge"]["status"],
                    "verified",
                )
                self.assertEqual(mutate.call_count, 1)
                self.assertEqual(health.call_count, 1)
                # A preserved service-level scaling change is never accepted as
                # an incidental part of the maintenance operation.
                service["metadata"]["annotations"]["run.googleapis.com/maxScale"] = "6"
                with self.assertRaisesRegex(
                    bridge.retention.UnsafeState, "service-level configuration"
                ):
                    bridge.maintain(release, checkpoint, create=True)

    def test_fixed_source_selector_is_checked_before_reading_secret_payloads(self):
        original = source()
        original["spec"]["containers"][0]["env"][0]["valueFrom"]["secretKeyRef"][
            "key"
        ] = "3"
        secrets = mock.Mock()
        with self.assertRaisesRegex(bridge.retention.UnsafeState, "latest-selector"):
            bridge.secret_pins(original, secrets)
        secrets.pin.assert_not_called()

    def test_clone_preserves_authority_and_frozen_image_with_only_fixed_pool_scaling_delta(
        self,
    ):
        original = source()
        frozen = copy.deepcopy(original)
        template = bridge.clone_template(original, pins(), "consent-protocol-displaced")
        self.assertEqual(original, frozen)
        self.assertEqual(
            template["spec"]["serviceAccountName"],
            original["spec"]["serviceAccountName"],
        )
        self.assertEqual(template["spec"]["timeoutSeconds"], 3600)
        self.assertEqual(template["spec"]["containers"][0]["image"], IMAGE)
        env = {row["name"]: row for row in template["spec"]["containers"][0]["env"]}
        self.assertEqual(env["DB_PASSWORD"]["valueFrom"]["secretKeyRef"]["key"], "7")
        self.assertEqual({key: env[key]["value"] for key in bridge.POOLS}, bridge.POOLS)
        self.assertEqual(
            template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"], "1"
        )
        self.assertEqual(
            template,
            bridge.clone_template(original, pins(), "consent-protocol-displaced"),
        )
        self.assertNotEqual(
            template["metadata"]["name"],
            bridge.clone_template(original, pins(), "consent-protocol-other")[
                "metadata"
            ]["name"],
        )

    def test_secret_versions_must_be_enabled_and_unchanged_for_the_entire_instance_start_history(
        self,
    ):
        reader = object.__new__(bridge.SecretMetadata)
        base = "projects/1234/secrets/key"
        older = {
            "name": base + "/versions/1",
            "state": "ENABLED",
            "createTime": "2026-10-19T00:00:00Z",
        }
        newer = {
            "name": base + "/versions/2",
            "state": "ENABLED",
            "createTime": "2026-10-21T00:00:00Z",
        }
        changed = [False]

        def read(resource):
            if resource.endswith("/latest"):
                return newer
            if "/versions?" in resource:
                return {"versions": [newer, older]}
            payload = (
                b"synthetic-different"
                if changed[0] and resource.endswith("2:access")
                else b"synthetic-same"
            )
            return {"payload": {"data": base64.b64encode(payload).decode()}}

        reader.get = read
        created = bridge.timestamp("2026-10-20T00:00:00Z")
        result = reader.pin(base, created)
        self.assertEqual(
            result, {"version": newer["name"], "unchangedSinceSource": True}
        )
        self.assertNotIn("synthetic", json.dumps(result))
        changed[0] = True
        with self.assertRaisesRegex(
            bridge.retention.UnsafeState, "secret values changed"
        ):
            reader.pin(base, created)
        changed[0] = False
        older["state"] = "DISABLED"
        with self.assertRaisesRegex(bridge.retention.UnsafeState, "unreadable"):
            reader.pin(base, created)

    def test_uncertain_create_has_durable_intent_and_is_never_automatically_repeated(
        self,
    ):
        release = {"sha": SHA, "final": {"backend_revision": "consent-protocol-source"}}
        observed = inventory()
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "completed.json"
            checkpoint.write_text(
                json.dumps({"schema_version": 1, "pass_status": "in_progress"})
            )

            def create(command, **_):
                receipt = json.loads(checkpoint.read_text())["capacity_bridge"]
                self.assertTrue(receipt["requested"])
                self.assertEqual(receipt["status"], "intent")
                body = json.loads(Path(command[4]).read_text())
                self.assertEqual(body["metadata"]["resourceVersion"], "precondition")
                self.assertEqual(
                    body["metadata"]["annotations"]["run.googleapis.com/maxScale"], "5"
                )
                self.assertFalse(
                    any(row.get("latestRevision") for row in body["spec"]["traffic"])
                )
                self.assertEqual(
                    [
                        (row["revisionName"], row["percent"])
                        for row in body["spec"]["traffic"]
                        if row["percent"]
                    ],
                    [("consent-protocol-source", 100)],
                )
                self.assertEqual(body["spec"]["traffic"][-1]["percent"], 0)
                raise subprocess.TimeoutExpired(command, 150)

            with (
                mock.patch.dict(
                    bridge.os.environ,
                    {
                        "GITHUB_EVENT_NAME": "workflow_dispatch",
                        "GITHUB_REF_NAME": "main",
                    },
                ),
                mock.patch.object(
                    bridge.budget,
                    "collect",
                    side_effect=lambda *a: copy.deepcopy(observed),
                ),
                mock.patch.object(
                    bridge.budget, "evaluate", return_value={"admitted": True}
                ),
                mock.patch.object(bridge, "SecretMetadata"),
                mock.patch.object(bridge, "secret_pins", return_value=pins()),
                mock.patch.object(
                    bridge.retention, "run_command", side_effect=create
                ) as called,
            ):
                with self.assertRaises(bridge.retention.MutationUncertain):
                    bridge.maintain(release, checkpoint, create=True)
                with self.assertRaisesRegex(
                    bridge.retention.MutationUncertain, "duplicate creation"
                ):
                    bridge.maintain(release, checkpoint, create=False)
                self.assertEqual(called.call_count, 1)
                self.assertEqual(
                    bridge.receipt_state(
                        json.loads(checkpoint.read_text())["capacity_bridge"]
                    )["status"],
                    "intent",
                )

    def test_source_generation_drift_and_scheduled_creation_fail_before_mutation(self):
        release = {"sha": SHA, "final": {"backend_revision": "consent-protocol-source"}}
        observed = inventory()
        drift = copy.deepcopy(observed)
        drift["services"]["consent-protocol"]["service"]["metadata"][
            "resourceVersion"
        ] = "changed"
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "completed.json"
            checkpoint.write_text("{}")
            with (
                mock.patch.dict(
                    bridge.os.environ,
                    {
                        "GITHUB_EVENT_NAME": "repository_dispatch",
                        "GITHUB_REF_NAME": "main",
                    },
                ),
                mock.patch.object(bridge.budget, "collect") as collect,
            ):
                with self.assertRaisesRegex(
                    bridge.retention.UnsafeState, "manual main"
                ):
                    bridge.maintain(release, checkpoint, create=True)
                collect.assert_not_called()
            with (
                mock.patch.dict(
                    bridge.os.environ,
                    {
                        "GITHUB_EVENT_NAME": "workflow_dispatch",
                        "GITHUB_REF_NAME": "main",
                    },
                ),
                mock.patch.object(
                    bridge.budget, "collect", side_effect=[observed, drift]
                ),
                mock.patch.object(bridge, "SecretMetadata"),
                mock.patch.object(bridge, "secret_pins", return_value=pins()),
                mock.patch.object(bridge.retention, "run_command") as mutate,
            ):
                with self.assertRaisesRegex(
                    bridge.retention.UnsafeState, "changed during preflight"
                ):
                    bridge.maintain(release, checkpoint, create=True)
                mutate.assert_not_called()
                self.assertNotIn("capacity_bridge", json.loads(checkpoint.read_text()))


if __name__ == "__main__":
    unittest.main()
