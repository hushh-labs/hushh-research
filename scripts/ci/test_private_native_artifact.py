#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Focused policy and workflow contracts for signed native build retention."""

from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "private_native_artifact", ROOT / "scripts/ci/upload-private-native-artifact.py"
)
assert SPEC and SPEC.loader
artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifact)
SHA = "a" * 40
BUCKET_CONFIG = {
    "name": artifact.BUCKET,
    "public_access_prevention": "enforced",
    "uniform_bucket_level_access": True,
    "lifecycle_config": {
        "rule": [{"action": {"type": "Delete"}, "condition": {"age": 14}}]
    },
}
PRIVATE_IAM = {
    "bindings": [
        {
            "role": "roles/storage.admin",
            "members": ["serviceAccount:ci@hushh-pda-uat.iam.gserviceaccount.com"],
        }
    ]
}
PROJECT_IAM = {
    "bindings": [
        {
            "role": "roles/owner",
            "members": [
                "serviceAccount:claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com"
            ],
        }
    ]
}
RAW_BUCKET = {"name": artifact.BUCKET, "projectNumber": artifact.PROJECT_NUMBER}
DENY_SOURCE = json.loads(artifact.DENY_POLICY_FILE.read_text())
DENY_LIVE = {
    **DENY_SOURCE,
    "name": "policies/cloudresourcemanager.googleapis.com%2Fprojects%2F189326466264/denypolicies/native-uat-artifact-read",
}


class PolicyTests(unittest.TestCase):
    def test_gcloud_disables_composite_uploads_for_provider_md5(self) -> None:
        with mock.patch.object(artifact.subprocess, "run") as process:
            process.return_value.stdout = "{}"
            artifact._run_gcloud(
                "storage", "buckets", "describe", "gs://" + artifact.BUCKET
            )
        self.assertEqual(
            process.call_args.kwargs["env"][
                "CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED"
            ],
            "false",
        )

    def test_requires_private_bucket_and_exact_retention(self) -> None:
        artifact.validate_bucket(BUCKET_CONFIG, PRIVATE_IAM)
        for field, value in (
            ("public_access_prevention", "inherited"),
            ("uniform_bucket_level_access", False),
            ("lifecycle_config", {}),
        ):
            with self.subTest(field=field):
                with self.assertRaises(artifact.ArtifactPolicyError):
                    artifact.validate_bucket(
                        {**BUCKET_CONFIG, field: value}, PRIVATE_IAM
                    )

    def test_rejects_non_service_account_bucket_and_project_iam(self) -> None:
        for member in (
            "allUsers",
            "allAuthenticatedUsers",
            "projectViewer:hushh-native-uat",
            "projectEditor:hushh-native-uat",
            "projectOwner:hushh-native-uat",
            "group:developers@hushh.ai",
            "user:someone@example.test",
            "domain:hushh.ai",
        ):
            with self.subTest(member=member):
                with self.assertRaises(artifact.ArtifactPolicyError):
                    artifact.validate_bucket(
                        BUCKET_CONFIG,
                        {
                            "bindings": [
                                {
                                    "role": "roles/storage.legacyObjectReader",
                                    "members": [member],
                                }
                            ]
                        },
                    )
                with self.assertRaises(artifact.ArtifactPolicyError):
                    artifact.validate_project_iam(
                        {
                            "bindings": [
                                {
                                    "role": "roles/storage.objectAdmin",
                                    "members": [member],
                                }
                            ]
                        }
                    )
        artifact.validate_project_iam(PROJECT_IAM)

    def test_bucket_must_belong_to_dedicated_project(self) -> None:
        artifact.validate_bucket_project(RAW_BUCKET)
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_bucket_project(
                {**RAW_BUCKET, "projectNumber": "745506018753"}
            )

    def test_live_deny_policy_blocks_ancestor_reads_and_developer_mutations(
        self,
    ) -> None:
        artifact.validate_deny_policy(DENY_LIVE, DENY_SOURCE)
        cases = []
        broad_exception = copy.deepcopy(DENY_LIVE)
        broad_exception["rules"][0]["denyRule"]["exceptionPrincipals"].append(
            "principalSet://goog/group/developers@hushh.ai"
        )
        cases.append(broad_exception)
        weak_developer_rule = copy.deepcopy(DENY_LIVE)
        weak_developer_rule["rules"][1]["denyRule"]["deniedPermissions"] = [
            "storage.googleapis.com/objects.get"
        ]
        cases.append(weak_developer_rule)
        missing_operator_exception = copy.deepcopy(DENY_LIVE)
        missing_operator_exception["rules"][1]["denyRule"].pop(
            "exceptionPrincipals"
        )
        cases.append(missing_operator_exception)
        conditional_rule = copy.deepcopy(DENY_LIVE)
        conditional_rule["rules"][0]["denialCondition"] = {"expression": "false"}
        cases.append(conditional_rule)
        cases.append(
            {
                **DENY_LIVE,
                "name": DENY_LIVE["name"].replace("189326466264", "745506018753"),
            }
        )
        for candidate in cases:
            with self.assertRaises(artifact.ArtifactPolicyError):
                artifact.validate_deny_policy(candidate, DENY_SOURCE)
        tampered_source = copy.deepcopy(DENY_SOURCE)
        tampered_source["rules"][0]["denyRule"]["exceptionPrincipals"].append(
            "principal://goog/subject/unauthorized@example.test"
        )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_deny_policy(tampered_source, tampered_source)
        tampered_source = copy.deepcopy(DENY_SOURCE)
        tampered_source["rules"][1]["denyRule"]["exceptionPrincipals"] = []
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_deny_policy(tampered_source, tampered_source)

    def test_exact_sha_run_and_platform_bound_object_key(self) -> None:
        self.assertEqual(
            artifact.object_name(SHA, "123", "2", "ios-testflight"),
            f"native/{SHA}/run-123-attempt-2/ios-testflight/app.ipa",
        )
        for sha, run_id, attempt, platform in (
            ("short", "123", "1", "ios-testflight"),
            (SHA, "../../secrets", "1", "ios-testflight"),
            (SHA, "123", "0", "ios-testflight"),
            (SHA, "123", "1", "ios-appstore"),
        ):
            with self.assertRaises(artifact.ArtifactPolicyError):
                artifact.object_name(sha, run_id, attempt, platform)

    def test_binary_must_match_expected_archive_structure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            ios = directory / "signed.ipa"
            android = directory / "signed.aab"
            with zipfile.ZipFile(ios, "w") as archive:
                archive.writestr("Payload/App.app/Info.plist", "signed")
            with zipfile.ZipFile(android, "w") as archive:
                archive.writestr("BundleConfig.pb", "config")
                archive.writestr("base/manifest/AndroidManifest.xml", "manifest")
            artifact.validate_binary(ios, "ios-testflight")
            artifact.validate_binary(android, "android-playstore")
            with self.assertRaises(artifact.ArtifactPolicyError):
                artifact.validate_binary(android, "ios-testflight")
            fake = directory / "secrets.ipa"
            fake.write_text("not a build")
            with self.assertRaises(artifact.ArtifactPolicyError):
                artifact.validate_binary(fake, "ios-testflight")
            protected = directory / "protected.ipa"
            with zipfile.ZipFile(protected, "w") as archive:
                archive.writestr("Payload/App.app/Info.plist", "signed")
                archive.writestr("Payload/App.app/.env.native.ios.local", "private")
            with self.assertRaises(artifact.ArtifactPolicyError):
                artifact.validate_binary(protected, "ios-testflight")

    def test_remote_generation_hash_and_size_must_match(self) -> None:
        remote = {
            "name": "native/example/app.ipa",
            "bucket": artifact.BUCKET,
            "generation": "1001",
            "size": "42",
            "md5_hash": "md5-base64",
            # This is the shape returned by `gcloud storage objects describe
            # --format=json`, not the raw Cloud Storage REST representation.
            "custom_fields": {"sha256": "sha256-hex", "source_sha": SHA},
        }
        expected = {
            "name": remote["name"],
            "size": 42,
            "sha256": "sha256-hex",
            "source_sha": SHA,
            "md5_base64": "md5-base64",
        }
        self.assertEqual(artifact.validate_uploaded_object(remote, **expected), 1001)
        for field, value in (
            ("generation", "0"),
            ("size", "41"),
            ("md5_hash", "other"),
            ("bucket", "other"),
        ):
            with self.subTest(field=field):
                with self.assertRaises(artifact.ArtifactPolicyError):
                    artifact.validate_uploaded_object(
                        {**remote, field: value}, **expected
                    )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object(
                {**remote, "custom_fields": {"sha256": "other", "source_sha": SHA}},
                **expected,
            )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object(
                {**remote, "custom_fields": None}, **expected
            )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object(
                {
                    **remote,
                    "custom_fields": {"sha256": "sha256-hex", "source_sha": "other"},
                },
                **expected,
            )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object(
                {**remote, "custom_fields": {"sha256": "sha256-hex"}},
                **expected,
            )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object(
                {**remote, "custom_fields": {"source_sha": SHA}}, **expected
            )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object(
                {
                    "metadata": {"sha256": "sha256-hex", "source_sha": SHA},
                    **{
                        key: value
                        for key, value in remote.items()
                        if key != "custom_fields"
                    },
                },
                **expected,
            )

    def test_upload_checks_policy_before_copy_and_uses_create_only_precondition(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "app.ipa"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("Payload/App.app/Info.plist", "signed")
            payload = path.read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            md5 = base64.b64encode(
                hashlib.md5(payload, usedforsecurity=False).digest()
            ).decode()
            key = artifact.object_name(SHA, "99", "1", "ios-testflight")
            remote = {
                "name": key,
                "bucket": artifact.BUCKET,
                "generation": "101",
                "size": str(len(payload)),
                "md5_hash": md5,
                "custom_fields": {"sha256": digest, "source_sha": SHA},
            }
            with mock.patch.object(artifact, "validate_destination") as validate:
                with mock.patch.object(
                    artifact, "_gcloud_json", return_value=remote
                ) as describe:
                    with mock.patch.object(
                        artifact, "_run_gcloud", return_value=""
                    ) as command:
                        receipt = artifact.upload(
                            path, SHA, "99", "1", "ios-testflight"
                        )
            self.assertEqual(validate.call_count, 2)
            self.assertEqual(describe.call_count, 1)
            self.assertEqual(command.call_count, 1)
            self.assertIn("--if-generation-match=0", command.call_args.args)
            self.assertIn(f"--content-md5={md5}", command.call_args.args)
            self.assertIn(
                f"--custom-metadata=sha256={digest},source_sha={SHA}",
                command.call_args.args,
            )
            self.assertEqual(receipt["sha256"], digest)
            self.assertEqual(receipt["generation"], 101)

            with mock.patch.object(
                artifact,
                "validate_destination",
                side_effect=artifact.ArtifactPolicyError("unsafe"),
            ):
                with mock.patch.object(artifact, "_run_gcloud") as blocked_command:
                    with self.assertRaises(artifact.ArtifactPolicyError):
                        artifact.upload(path, SHA, "99", "1", "ios-testflight")
                    blocked_command.assert_not_called()

    def test_destination_preflight_reads_bucket_and_project_policy(self) -> None:
        with mock.patch.object(
            artifact,
            "_gcloud_json",
            side_effect=[
                PROJECT_IAM,
                BUCKET_CONFIG,
                PRIVATE_IAM,
                RAW_BUCKET,
                DENY_LIVE,
            ],
        ) as gcloud:
            artifact.validate_destination()
        self.assertEqual(gcloud.call_count, 5)

    def test_workflows_never_publish_signed_binaries_as_actions_artifacts(self) -> None:
        for filename in (
            "ship-ios-testflight.yml",
            "ship-android-playstore-v1.yml",
            "release-ios-appstore.yml",
        ):
            source = (ROOT / ".github/workflows" / filename).read_text()
            for step in source.split("      - name:"):
                if "uses: actions/upload-artifact" not in step:
                    continue
                with self.subTest(workflow=filename):
                    self.assertNotIn("*.ipa", step)
                    self.assertNotIn(".aab", step)
                    self.assertNotIn("export/**", step)
                    self.assertNotIn("dSYMs/**", step)
            if filename != "release-ios-appstore.yml":
                self.assertIn("upload-private-native-artifact.py", source)
                self.assertIn("id-token: write", source)
        lifecycle = json.loads(
            (ROOT / "deploy/storage/native-artifact-lifecycle-14d.json").read_text()
        )
        self.assertEqual(
            lifecycle,
            {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 14}}]},
        )


if __name__ == "__main__":
    unittest.main()
