#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Check the release configuration boundary without building a simulator app."""

import json
import importlib.util
import plistlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class UatPasskeyConfigurationTests(unittest.TestCase):
    def exercise_distribution_export(self, *, dry_run=False, invalid_apns=False):
        path = ROOT / "scripts/ci/export-ios-distribution.py"
        spec = importlib.util.spec_from_file_location("distribution_export", path)
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        events = []
        signing_options = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def run(command, *, check):
                self.assertTrue(check)
                if command[0] == "xcodebuild":
                    options = plistlib.loads(
                        Path(
                            command[command.index("-exportOptionsPlist") + 1]
                        ).read_bytes()
                    )
                    events.append(options["destination"])
                    signing_options.append(
                        {k: v for k, v in options.items() if k != "destination"}
                    )
                    if options["destination"] == "export":
                        export_path = Path(command[command.index("-exportPath") + 1])
                        export_path.mkdir()
                        (export_path / "App.ipa").touch()
                elif command[0] == "ditto":
                    (Path(command[-1]) / "Payload/App.app").mkdir(parents=True)
                else:
                    self.assertEqual(
                        Path(command[1]).name, "verify-ios-push-entitlements.py"
                    )
                    self.assertTrue(Path(command[-1]).is_dir())
                    events.append("verify")
                    if invalid_apns:
                        raise subprocess.CalledProcessError(1, command)

            with patch.object(exporter.subprocess, "run", side_effect=run):
                try:
                    exporter.export_distribution(
                        root / "App.xcarchive",
                        root / "export",
                        ROOT / "hushh-webapp/ios/ExportOptions/AppStoreConnect.plist",
                        root / "asc.p8",
                        "test-key",
                        "test-issuer",
                        dry_run,
                    )
                except subprocess.CalledProcessError:
                    self.assertEqual(events, ["export", "verify"])
                    raise
        return events, signing_options

    def test_distribution_export_is_verified_before_existing_xcode_upload(self):
        events, options = self.exercise_distribution_export()
        self.assertEqual(events, ["export", "verify", "upload"])
        self.assertEqual(options[0], options[1])

    def test_distribution_guard_failure_prevents_upload(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.exercise_distribution_export(invalid_apns=True)

    def test_dry_run_verifies_distribution_without_upload(self):
        events, _ = self.exercise_distribution_export(dry_run=True)
        self.assertEqual(events, ["export", "verify"])

    def test_release_archives_keep_target_owned_automatic_signing(self):
        for name in ("ship-ios-testflight.yml", "release-ios-appstore.yml"):
            workflow = (ROOT / ".github/workflows" / name).read_text()
            self.assertNotIn('CODE_SIGN_IDENTITY="Apple Distribution"', workflow)
            self.assertNotIn("HUSSH_APP_ENTITLEMENTS=", workflow)
            self.assertIn("python3 scripts/ci/export-ios-distribution.py", workflow)

    def test_distribution_push_guard_rejects_development_or_missing_apns(self):
        path = ROOT / "scripts/ci/verify-ios-push-entitlements.py"
        spec = importlib.util.spec_from_file_location("push_guard", path)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        production = {"aps-environment": "production"}
        guard.verify(production, {"Entitlements": production})
        for signed, profile in [
            ({}, production),
            ({"aps-environment": "development"}, production),
            (production, {}),
            (production, {"aps-environment": "development"}),
            ({**production, "get-task-allow": True}, production),
            (production, {**production, "get-task-allow": True}),
        ]:
            with self.assertRaises(ValueError):
                guard.verify(signed, {"Entitlements": profile})

    def test_exported_chat_extension_requires_matching_signed_preview_custody(self):
        path = ROOT / "scripts/ci/verify-ios-push-entitlements.py"
        spec = importlib.util.spec_from_file_location("push_guard", path)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        group = "TEAM.com.hussh.app.chatnotifications"
        app_info = {
            "CFBundleIdentifier": "com.hushh.app",
            "NotificationKeychainGroup": group,
        }
        signed = {"keychain-access-groups": [group]}
        extension = {
            "CFBundleIdentifier": "com.hushh.app.ChatNotificationService",
            "NotificationKeychainGroup": group,
            "NSExtension": {
                "NSExtensionPointIdentifier": "com.apple.usernotifications.service",
                "NSExtensionPrincipalClass": "ChatNotificationService.NotificationService",
            },
        }
        profile = {"Entitlements": {"keychain-access-groups": ["TEAM.*"]}}
        guard.verify_chat_extension(app_info, signed, extension, signed, profile)
        for bad_info, bad_app, bad_ext, bad_profile in [
            (
                {
                    **extension,
                    "NotificationKeychainGroup": "OTHER.com.hussh.app.chatnotifications",
                },
                signed,
                signed,
                profile,
            ),
            (extension, {}, signed, profile),
            (extension, signed, {}, profile),
            (
                extension,
                signed,
                signed,
                {"Entitlements": {"keychain-access-groups": ["OTHER.*"]}},
            ),
            ({**extension, "NSExtension": {}}, signed, signed, profile),
            (extension, signed, {**signed, "get-task-allow": True}, profile),
        ]:
            with self.assertRaises(ValueError):
                guard.verify_chat_extension(
                    app_info, bad_app, bad_info, bad_ext, bad_profile
                )

    def test_ci_rp_reaches_native_preparation_and_has_an_entitlement(self):
        script = (ROOT / "scripts/ci/materialize-ios-uat-build-contract.sh").read_text()
        assignments = [
            line
            for line in script.splitlines()
            if line.startswith("put_env NEXT_PUBLIC_PASSKEY_RP_ID ")
        ]
        self.assertEqual(len(assignments), 1)
        rp = assignments[0].split('"')[1]
        self.assertEqual(rp, "uat.one.hushh.ai")
        output = subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                'import {buildIosUatRuntimeEnv} from "./hushh-webapp/scripts/native/prepare-ios-uat-archive.mjs";'
                'console.log(JSON.stringify(buildIosUatRuntimeEnv({processEnv:{NEXT_PUBLIC_PASSKEY_RP_ID:process.argv[1]},uatValues:{NEXT_PUBLIC_PASSKEY_RP_ID:"one.hushh.ai"},localValues:{}})));',
                rp,
            ],
            cwd=ROOT,
            text=True,
        )
        self.assertEqual(json.loads(output)["NEXT_PUBLIC_PASSKEY_RP_ID"], rp)
        for name in ("App.entitlements", "AppRelease.entitlements"):
            entitlements = (ROOT / "hushh-webapp/ios/App/App" / name).read_text()
            self.assertIn("webcredentials:" + rp, entitlements)
            self.assertIn("webcredentials:one.hushh.ai", entitlements)


if __name__ == "__main__":
    unittest.main()
