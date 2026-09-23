#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Focused policy and workflow contracts for signed native build retention."""

from __future__ import annotations

import base64
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
            "role": "roles/storage.objectCreator",
            "members": ["serviceAccount:ci@example.test"],
        }
    ]
}


class PolicyTests(unittest.TestCase):
    def test_gcloud_disables_composite_uploads_for_provider_md5(self) -> None:
        with mock.patch.object(artifact.subprocess, "run") as process:
            process.return_value.stdout = "{}"
            artifact._run_gcloud("buckets", "describe", "gs://" + artifact.BUCKET)
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

    def test_rejects_public_and_project_viewer_iam(self) -> None:
        for member in (
            "allUsers",
            "allAuthenticatedUsers",
            "projectViewer:hushh-pda-uat",
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
            "metadata": {"sha256": "sha256-hex"},
        }
        expected = {
            "name": remote["name"],
            "size": 42,
            "sha256": "sha256-hex",
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
                {**remote, "metadata": {"sha256": "other"}}, **expected
            )
        with self.assertRaises(artifact.ArtifactPolicyError):
            artifact.validate_uploaded_object({**remote, "metadata": None}, **expected)

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
                "metadata": {"sha256": digest},
            }
            with mock.patch.object(
                artifact,
                "_gcloud_json",
                side_effect=[
                    BUCKET_CONFIG,
                    PRIVATE_IAM,
                    remote,
                    BUCKET_CONFIG,
                    PRIVATE_IAM,
                ],
            ) as describe:
                with mock.patch.object(
                    artifact, "_run_gcloud", return_value=""
                ) as command:
                    receipt = artifact.upload(path, SHA, "99", "1", "ios-testflight")
            self.assertEqual(describe.call_count, 5)
            self.assertEqual(command.call_count, 1)
            self.assertIn("--if-generation-match=0", command.call_args.args)
            self.assertIn(f"--content-md5={md5}", command.call_args.args)
            self.assertEqual(receipt["sha256"], digest)
            self.assertEqual(receipt["generation"], 101)

            with mock.patch.object(
                artifact,
                "_gcloud_json",
                side_effect=[{**BUCKET_CONFIG, "lifecycle_config": {}}, PRIVATE_IAM],
            ):
                with mock.patch.object(artifact, "_run_gcloud") as command:
                    with self.assertRaises(artifact.ArtifactPolicyError):
                        artifact.upload(path, SHA, "99", "1", "ios-testflight")
                    command.assert_not_called()

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
