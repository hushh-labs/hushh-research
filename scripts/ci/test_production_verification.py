"""Read-only Production verification binds health to the exact serving pair."""

from __future__ import annotations

import copy
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

SOURCE = Path(__file__).with_name("verify-current-production.py")
SPEC = importlib.util.spec_from_file_location("verify_current_production", SOURCE)
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
REPOSITORY = "hushh-labs/hushh-research"


def documents():
    result = {}
    for service in verify.SERVICES:
        revision = f"{service}-serving1"
        labels = {
            "serving.knative.dev/service": service,
            "deploy-env": "production",
            "deploy-source": "deploy-production",
            "deploy-sha": SHA,
        }
        env = [
            {"name": "HUSHH_DEPLOY_ENV", "value": labels["deploy-env"]},
            {"name": "HUSHH_DEPLOY_SOURCE", "value": labels["deploy-source"]},
            {"name": "HUSHH_DEPLOY_SHA", "value": SHA},
            {"name": "DB_PASSWORD", "value": "secret-fixture-value"},
        ]
        container = {
            "name": service,
            "resources": {"limits": {"cpu": "1", "memory": "1Gi"}},
            "ports": [{"containerPort": 8080}],
            "startupProbe": {"httpGet": {"path": "/health", "port": 8080}},
            "env": copy.deepcopy(env),
        }
        config = {
            "serviceAccountName": "runtime@example.invalid",
            "containerConcurrency": 40,
            "timeoutSeconds": 300,
            "containers": [copy.deepcopy(container)],
        }
        service_payload = {
            "metadata": {
                "name": service,
                "uid": f"service-{service}",
                "generation": 7,
            },
            "spec": {"template": {"spec": copy.deepcopy(config)}},
            "status": {
                "traffic": [
                    {"revisionName": revision, "percent": 100},
                    {"revisionName": f"{service}-candidate2", "percent": 0},
                ],
                "latestCreatedRevisionName": f"{service}-candidate2",
            },
        }
        revision_payload = {
            "metadata": {"name": revision, "uid": f"revision-{service}", "labels": labels},
            "spec": copy.deepcopy(config),
            "status": {
                "conditions": [{"type": "Ready", "status": "True"}],
                "imageDigest": f"gcr.io/hushh-pda/{service}@{DIGEST}",
            },
        }
        result[("services", service)] = service_payload
        result[("revisions", revision)] = revision_payload
    return result


def read_document(source, resource, name):
    return source[(resource, name)]


def verify_inputs(operation: str) -> dict[str, str]:
    return {
        "operation": operation,
        "sha": "" if operation == "verify_current" else SHA,
        "emergency_source_ref": "",
        "emergency_reason": "",
        "main_approval_sha": "",
        "restoration_validation_run": "",
        "restoration_activation_run_id": "",
        "restoration_activation_attempt": "",
        "scope": "auto",
        "run_predeploy_backup_job": "false",
        "enable_one_email_kyc": "false",
        "drive_live_mode": "preserve",
        "backend_image_source": "build-from-source",
        "phone_rollback_sha": "",
        "phone_phase": "standard",
        "phone_worker_stage_run_id": "",
        "phone_activation_run_id": "",
        "phone_schema_origin_run_id": "",
        "phone_schema_origin_attempt": "",
        "nearby_check_in_cohort": "all",
    }


def validate_dispatch(
    inputs,
    *,
    event_name="workflow_dispatch",
    ref="refs/heads/main",
    repository=REPOSITORY,
):
    return verify.validate_dispatch(
        inputs, event_name=event_name, ref=ref, repository=repository
    )


class ProductionVerificationTests(unittest.TestCase):
    def test_snapshot_binds_ready_100_percent_serving_revisions_and_redacts_env(self):
        source = documents()
        with mock.patch.object(
            verify, "_read_gcloud_json", side_effect=lambda resource, name: read_document(source, resource, name)
        ):
            snapshot = verify.capture_snapshot()

        self.assertEqual(
            [row["service"] for row in snapshot["services"]],
            ["consent-protocol", "hushh-webapp"],
        )
        for row in snapshot["services"]:
            with self.subTest(service=row["service"]):
                self.assertEqual(row["serving_revision"], f"{row['service']}-serving1")
                self.assertEqual(row["traffic_percent"], 100)
                self.assertTrue(row["ready"])
                self.assertEqual(row["image_digest"], DIGEST)
                self.assertEqual(row["app_source_sha"], SHA)
                self.assertEqual(
                    row["non_serving_candidate_revision"],
                    f"{row['service']}-candidate2",
                )
        self.assertNotIn("secret-fixture-value", json.dumps(snapshot))
        self.assertTrue(
            all(
                len(row["configuration_fingerprint"]) == 64
                for row in snapshot["services"]
            )
        )

    def test_cloud_run_reads_use_fixed_describe_commands_only(self):
        source = documents()
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            self.assertEqual(command[0:2], ["gcloud", "run"])
            resource, name = command[2], command[4]
            self.assertEqual(command[3], "describe")
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(source[(resource, name)]),
                stderr="",
            )

        with mock.patch.object(verify.subprocess, "run", side_effect=run):
            verify.capture_snapshot()

        self.assertEqual(len(calls), 4)
        for command, kwargs in calls:
            self.assertEqual(
                command[5:],
                [
                    "--project=hushh-pda",
                    "--region=us-central1",
                    "--format=json",
                    "--quiet",
                ],
            )
            self.assertEqual(
                kwargs,
                {"check": False, "capture_output": True, "text": True, "timeout": 30},
            )
            self.assertIn(command[2], {"services", "revisions"})

    def test_unqualified_traffic_readiness_provenance_or_digest_fails_closed(self):
        defects = (
            "multiple_traffic_targets",
            "revision_not_ready",
            "source_mismatch",
            "invalid_digest",
        )
        for defect in defects:
            with self.subTest(defect=defect):
                source = documents()
                service = "consent-protocol"
                service_payload = source[("services", service)]
                revision = "consent-protocol-serving1"
                revision_payload = source[("revisions", revision)]
                if defect == "multiple_traffic_targets":
                    service_payload["status"]["traffic"] = [
                        {"revisionName": revision, "percent": 50},
                        {"revisionName": "consent-protocol-other1", "percent": 50},
                    ]
                elif defect == "revision_not_ready":
                    revision_payload["status"]["conditions"][0]["status"] = "False"
                elif defect == "source_mismatch":
                    revision_payload["metadata"]["labels"]["deploy-sha"] = "c" * 40
                else:
                    revision_payload["status"]["imageDigest"] = "mutable:latest"
                with mock.patch.object(
                    verify,
                    "_read_gcloud_json",
                    side_effect=lambda resource, name: read_document(source, resource, name),
                ):
                    with self.assertRaises(verify.VerificationError):
                        verify.capture_snapshot()

    def test_failed_cloud_read_does_not_echo_provider_output(self):
        secret = "provider-output-must-not-escape"
        result = SimpleNamespace(returncode=1, stdout=secret, stderr=secret)
        with mock.patch.object(verify.subprocess, "run", return_value=result):
            with self.assertRaises(verify.VerificationError) as raised:
                verify._read_gcloud_json("services", "consent-protocol")
        self.assertNotIn(secret, str(raised.exception))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, summary = root / "snapshot.json", root / "summary.md"
            stdout, stderr = StringIO(), StringIO()
            with (
                mock.patch.object(verify.subprocess, "run", return_value=result),
                mock.patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": str(summary)}),
                redirect_stdout(stdout),
                redirect_stderr(stderr),
            ):
                self.assertEqual(
                    verify.main(["capture", "--output", str(output)]), 1
                )
            self.assertFalse(output.exists())
            rendered = stdout.getvalue() + stderr.getvalue() + summary.read_text()
            self.assertNotIn(secret, rendered)
            self.assertIn("cloud_run_read_failed", rendered)

    def test_dispatch_accepts_only_exact_default_verify_or_deploy_inputs(self):
        self.assertEqual(
            validate_dispatch(verify_inputs("verify_current")),
            "verify_current",
        )
        self.assertEqual(
            validate_dispatch(verify_inputs("deploy")), "deploy"
        )
        legacy = verify_inputs("deploy")
        del legacy["operation"]
        self.assertEqual(validate_dispatch(legacy), "deploy")

        mutations = {
            "emergency_source_ref": "incident/one",
            "emergency_reason": "incident",
            "main_approval_sha": SHA,
            "restoration_validation_run": "123",
            "restoration_activation_run_id": "123",
            "restoration_activation_attempt": "1",
            "scope": "all",
            "run_predeploy_backup_job": "true",
            "enable_one_email_kyc": "true",
            "drive_live_mode": "enable",
            "backend_image_source": "promote-from-uat",
            "phone_rollback_sha": SHA,
            "phone_phase": "worker",
            "phone_worker_stage_run_id": "123",
            "phone_activation_run_id": "123",
            "phone_schema_origin_run_id": "123",
            "phone_schema_origin_attempt": "1",
            "nearby_check_in_cohort": "account-1",
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                inputs = verify_inputs("verify_current")
                inputs[field] = value
                with self.assertRaises(verify.VerificationError):
                    validate_dispatch(inputs)

        invalid_contexts = (
            {"event_name": "push"},
            {"ref": "refs/heads/feature"},
            {"repository": "other/repository"},
        )
        for changes in invalid_contexts:
            with self.subTest(context=changes):
                with self.assertRaises(verify.VerificationError):
                    validate_dispatch(verify_inputs("verify_current"), **changes)

        for operation, sha in (("unknown", ""), ("verify_current", SHA), ("deploy", "bad")):
            with self.subTest(operation=operation, sha=sha):
                inputs = verify_inputs(operation)
                inputs["sha"] = sha
                with self.assertRaises(verify.VerificationError):
                    validate_dispatch(inputs)
        unknown = verify_inputs("verify_current") | {"unexpected": "true"}
        with self.assertRaises(verify.VerificationError):
            validate_dispatch(unknown)

    def test_compare_blocks_serving_drift_and_failed_public_health(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = documents()
            with mock.patch.object(
                verify,
                "_read_gcloud_json",
                side_effect=lambda resource, name: read_document(source, resource, name),
            ):
                before = verify.capture_snapshot()
            after = copy.deepcopy(before)
            before_path, after_path = root / "before.json", root / "after.json"
            before_path.write_text(json.dumps(before))
            after_path.write_text(json.dumps(after))
            summary = root / "summary.md"
            with mock.patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": str(summary)}):
                with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                    self.assertEqual(
                        verify.main([
                            "compare", "--before", str(before_path), "--after", str(after_path),
                            "--backend-health", "success", "--frontend-health", "success",
                        ]),
                        0,
                    )
                    after["services"][0]["serving_revision"] = "consent-protocol-newer1"
                    after_path.write_text(json.dumps(after))
                    self.assertEqual(
                        verify.main([
                            "compare", "--before", str(before_path), "--after", str(after_path),
                            "--backend-health", "success", "--frontend-health", "success",
                        ]),
                        1,
                    )
                    after_path.write_text(json.dumps(before))
                    self.assertEqual(
                        verify.main([
                            "compare", "--before", str(before_path), "--after", str(after_path),
                            "--backend-health", "failed", "--frontend-health", "success",
                        ]),
                        1,
                    )
            report = summary.read_text()
            self.assertIn("Verifier workflow SHA (not application SHA)", report)
            self.assertIn("Application source SHA", report)


if __name__ == "__main__":
    unittest.main()
