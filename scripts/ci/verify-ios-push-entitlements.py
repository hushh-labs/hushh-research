#!/usr/bin/env python3
"""Fail a distribution-exported app before upload if signed APNs drifted."""

import argparse
from fnmatch import fnmatchcase
import plistlib
import subprocess
from pathlib import Path


def verify(signed: dict, profile: dict) -> None:
    if signed.get("aps-environment") != "production":
        raise ValueError("Signed distribution app must use production APNs")
    if profile.get("Entitlements", {}).get("aps-environment") != "production":
        raise ValueError("Distribution profile must authorize production APNs")
    if signed.get("get-task-allow", False) or profile.get("Entitlements", {}).get(
        "get-task-allow", False
    ):
        raise ValueError("Distribution app must not allow debugging")


def verify_chat_extension(
    app_info: dict,
    app_signed: dict,
    extension_info: dict,
    extension_signed: dict,
    extension_profile: dict,
) -> None:
    """Verify the exported binary's preview custody, not source build settings."""
    group = app_info.get("NotificationKeychainGroup", "")
    if (
        not group
        or "$" in group
        or "*" in group
        or not group.endswith(".com.hussh.app.chatnotifications")
    ):
        raise ValueError("App notification Keychain group must be resolved")
    if extension_info.get("NotificationKeychainGroup") != group:
        raise ValueError("App and notification extension must share preview custody")
    for signed in (app_signed, extension_signed):
        if group not in signed.get("keychain-access-groups", []):
            raise ValueError(
                "Signed app and extension must authorize the preview Keychain group"
            )
    entitlements = extension_profile.get("Entitlements", {})
    if not any(
        fnmatchcase(group, pattern)
        for pattern in entitlements.get("keychain-access-groups", [])
    ):
        raise ValueError("Extension profile must authorize preview custody")
    if extension_signed.get("get-task-allow") or entitlements.get("get-task-allow"):
        raise ValueError("Distribution notification extension must not allow debugging")
    if (
        extension_info.get("CFBundleIdentifier")
        != f"{app_info.get('CFBundleIdentifier')}.ChatNotificationService"
    ):
        raise ValueError("Unexpected notification extension identity")
    extension = extension_info.get("NSExtension", {})
    if extension.get(
        "NSExtensionPointIdentifier"
    ) != "com.apple.usernotifications.service" or not str(
        extension.get("NSExtensionPrincipalClass", "")
    ).endswith(".NotificationService"):
        raise ValueError("Exported chat notification service is not configured")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-bundle", required=True, type=Path)
    args = parser.parse_args()
    signed = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(args.app_bundle)],
        check=True,
        capture_output=True,
    ).stdout
    profile = subprocess.run(
        [
            "security",
            "cms",
            "-D",
            "-i",
            str(args.app_bundle / "embedded.mobileprovision"),
        ],
        check=True,
        capture_output=True,
    ).stdout
    app_signed = plistlib.loads(signed)
    verify(app_signed, plistlib.loads(profile))
    extension = args.app_bundle / "PlugIns" / "ChatNotificationService.appex"
    if not extension.is_dir():
        raise ValueError("Exported app is missing ChatNotificationService.appex")
    extension_signed = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(extension)],
        check=True,
        capture_output=True,
    ).stdout
    extension_profile = subprocess.run(
        ["security", "cms", "-D", "-i", str(extension / "embedded.mobileprovision")],
        check=True,
        capture_output=True,
    ).stdout
    verify_chat_extension(
        plistlib.loads((args.app_bundle / "Info.plist").read_bytes()),
        app_signed,
        plistlib.loads((extension / "Info.plist").read_bytes()),
        plistlib.loads(extension_signed),
        plistlib.loads(extension_profile),
    )
    print("Distribution APNs and exported chat notification Keychain custody verified.")


if __name__ == "__main__":
    main()
