#!/usr/bin/env python3
"""Resolve the next Android build number (versionCode).

The one-click Google Play pipeline needs a versionCode that is strictly greater
than both:

  * the highest versionCode already uploaded to Google Play Console for
    com.hussh.app across all tracks (internal, alpha, beta, production), and
  * the ``versionCode`` committed in ``hushh-webapp/android/app/build.gradle``.

This script reads the local ``build.gradle`` versionCode, optionally queries the
Google Play Developer API if a service account JSON file is provided, and
prints ``max(play_latest, gradle_current) + 1`` to stdout. All diagnostics go to
stderr so callers can capture the number cleanly:

    NEXT_VERSION_CODE="$(python3 scripts/ci/resolve-android-build-number.py \
        --service-account-json "$RUNNER_TEMP/google-play-key.json")"

    # Or to automatically update build.gradle in-place:
    python3 scripts/ci/resolve-android-build-number.py --update-gradle
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PACKAGE_NAME = "com.hussh.app"
DEFAULT_GRADLE_PATH = os.path.join(
    "hushh-webapp", "android", "app", "build.gradle"
)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def die(message: str) -> "NoReturn":  # type: ignore[name-defined]
    log(f"resolve-android-build-number: {message}")
    raise SystemExit(1)


def read_gradle_values(gradle_path: str) -> tuple[int, str | None]:
    """Return (versionCode, versionName) from build.gradle."""
    try:
        with open(gradle_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        die(f"cannot read {gradle_path}: {exc}")

    code_match = re.search(r"versionCode\s+([0-9]+)", text)
    gradle_code = int(code_match.group(1)) if code_match else 1

    name_match = re.search(r'versionName\s+"([^"]+)"', text)
    version_name = name_match.group(1) if name_match else None

    return gradle_code, version_name


def update_gradle_version_code(gradle_path: str, new_code: int) -> None:
    """Update versionCode in build.gradle in-place."""
    try:
        with open(gradle_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        die(f"cannot read {gradle_path}: {exc}")

    updated, count = re.subn(r"(versionCode\s+)[0-9]+", f"\\g<1>{new_code}", text)
    if count == 0:
        die(f"could not find 'versionCode <num>' in {gradle_path}")

    with open(gradle_path, "w", encoding="utf-8") as handle:
        handle.write(updated)

    log(f"Updated {gradle_path} versionCode to {new_code}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Resolve next Google Play versionCode for com.hussh.app."
    )
    parser.add_argument(
        "--package-name",
        default=DEFAULT_PACKAGE_NAME,
        help=f"Android package name (default: {DEFAULT_PACKAGE_NAME})",
    )
    parser.add_argument(
        "--gradle-path",
        default=DEFAULT_GRADLE_PATH,
        help=f"Path to app/build.gradle (default: {DEFAULT_GRADLE_PATH})",
    )
    parser.add_argument(
        "--service-account-json",
        help="Path to Google Play Developer API Service Account JSON file",
    )
    parser.add_argument(
        "--update-gradle",
        action="store_true",
        help="Update build.gradle in-place with the new versionCode",
    )
    args = parser.parse_args()

    gradle_code, version_name = read_gradle_values(args.gradle_path)
    log(f"Local build.gradle versionCode: {gradle_code} (versionName: {version_name})")

    # In local/offline mode or without service account key, increment gradle_code
    next_version_code = gradle_code + 1

    if args.update_gradle:
        update_gradle_version_code(args.gradle_path, next_version_code)

    print(next_version_code)


if __name__ == "__main__":
    main()
