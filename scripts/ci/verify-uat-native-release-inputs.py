#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Check TestFlight signing inputs before any UAT signing configuration is loaded."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from typing import Any

APPROVAL_PATH = "scripts/ci/uat-native-release-input-review.json"
BUILD_INPUTS = (
    "consent-protocol/.github/actions/setup-python-uv",
    ".npmrc",
    "hushh-webapp/.npmrc",
    "hushh-webapp/package-lock.json",
    "hushh-webapp/vitest.config.ts",
    "hushh-webapp/__tests__/setup.ts",
    "hushh-webapp/scripts/native",
    "hushh-webapp/scripts/voice",
    "hushh-webapp/scripts/prepare-wallet-ocr.mjs",
    "hushh-webapp/scripts/testing/reviewer-test-identity.mjs",
    "hushh-webapp/scripts/testing/signed-in-ui-flows.mjs",
    "scripts/native",
    ":(glob)hushh-webapp/next.config.*",
    ":(glob)hushh-webapp/capacitor.config.*",
    "hushh-webapp/ios/App/App.xcodeproj/project.pbxproj",
    "hushh-webapp/ios/App/CapApp-SPM/Package.swift",
    "hushh-webapp/ios/ExportOptions",
    ":(glob)hushh-webapp/ios/**/Package.resolved",
    ":(glob)hushh-webapp/ios/**/*.sh",
    ":(glob)scripts/ci/*ios*",
    ":(glob)scripts/ci/*testflight*",
    ":(glob)scripts/ci/*appstore*",
)
INVOKED_SCRIPTS = frozenset(
    {
        "cap:build",
        "cap:sync:ios",
        "ios:prepare:uat",
        "ios:verify-archive-symbols",
        "verify:capability-graph",
        "verify:capacitor:plugins",
        "verify:capacitor:product-assets",
        "verify:capacitor:static",
        "verify:native:css",
        "verify:one-voice",
        "verify:route-orchestration-index",
        "verify:siri-action-contract",
        "verify:voice-gateway",
    }
)
LIFECYCLE_SCRIPTS = {"install", "prepare", "dependencies"}


def git(*args: str) -> bytes:
    return subprocess.check_output(
        ["git", *args], stderr=subprocess.DEVNULL, timeout=30
    )


def build_file_changes(main_sha: str, application_sha: str) -> bytes:
    # Raw records include the path, both blob IDs, and both file modes.
    return git(
        "-c",
        "diff.orderFile=/dev/null",
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        main_sha,
        application_sha,
        "--",
        *BUILD_INPUTS,
    )


def build_manifest(revision: str) -> dict[str, Any]:
    manifest = json.loads(git("show", f"{revision}:hushh-webapp/package.json"))
    manifest["scripts"] = {
        name: command
        for name, command in manifest.get("scripts", {}).items()
        if name in INVOKED_SCRIPTS
        or name in LIFECYCLE_SCRIPTS
        or name.startswith(("pre", "post"))
    }
    return manifest


def manifest_digest(manifest: dict[str, Any]) -> str:
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def review_record(
    file_changes: bytes,
    main_manifest: dict[str, Any],
    application_manifest: dict[str, Any],
) -> dict[str, str | int]:
    return {
        "schema_version": 1,
        "source_branch": "uat",
        "build_file_changes_sha256": hashlib.sha256(file_changes).hexdigest(),
        "main_build_manifest_sha256": manifest_digest(main_manifest),
        "uat_build_manifest_sha256": manifest_digest(application_manifest),
    }


def verify(main_sha: str, application_sha: str, source_branch: str) -> None:
    file_changes = build_file_changes(main_sha, application_sha)
    main_manifest = build_manifest(main_sha)
    application_manifest = build_manifest(application_sha)
    if not file_changes and main_manifest == application_manifest:
        print("TestFlight signing inputs match Main.")
        return

    if source_branch == "uat":
        # The record comes from the protected workflow commit. A candidate or a
        # workflow dispatch cannot supply its own signing-input approval, while
        # ordinary web/backend UAT commits that leave native signing inputs
        # unchanged stay eligible without re-pinning Main.
        try:
            approved = json.loads(git("show", f"{main_sha}:{APPROVAL_PATH}"))
        except subprocess.CalledProcessError:
            approved = None
        if approved == review_record(file_changes, main_manifest, application_manifest):
            print(
                f"TestFlight signing inputs match the Main-reviewed UAT release record for {application_sha}."
            )
            return

    raise ValueError(
        "UAT TestFlight signing inputs differ from Main and lack a matching Main review record."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-sha", required=True)
    parser.add_argument("--application-sha", required=True)
    parser.add_argument(
        "--source-branch", choices=("uat", "uat-isolated"), required=True
    )
    args = parser.parse_args()
    if any(
        re.fullmatch(r"[0-9a-f]{40}", sha) is None
        for sha in (args.main_sha, args.application_sha)
    ):
        parser.error("Main and application must be full immutable commit SHAs.")
    try:
        verify(args.main_sha, args.application_sha, args.source_branch)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    except (subprocess.SubprocessError, TypeError, AttributeError):
        raise SystemExit(
            "Unable to verify committed TestFlight signing inputs."
        ) from None


if __name__ == "__main__":
    main()
