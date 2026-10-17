#!/usr/bin/env python3
"""Fail a distribution archive before upload if signed APNs configuration drifted."""

import argparse
import plistlib
import subprocess
from pathlib import Path


def verify(signed: dict, profile: dict) -> None:
    if signed.get("aps-environment") != "production":
        raise ValueError("Signed distribution app must use production APNs")
    if profile.get("Entitlements", {}).get("aps-environment") != "production":
        raise ValueError("Distribution profile must authorize production APNs")
    if signed.get("get-task-allow", False):
        raise ValueError("Distribution app must not allow debugging")


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
    verify(plistlib.loads(signed), plistlib.loads(profile))
    print("Signed app and distribution profile use production APNs.")


if __name__ == "__main__":
    main()
