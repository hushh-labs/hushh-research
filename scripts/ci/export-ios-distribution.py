#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Verify a distribution export before the existing Xcode upload flow."""

import argparse
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path


def export_distribution(
    archive: Path,
    export_path: Path,
    options_path: Path,
    p8_path: Path,
    key_id: str,
    issuer_id: str,
    dry_run: bool,
) -> None:
    with options_path.open("rb") as handle:
        options = plistlib.load(handle)
    if options.get("method") != "app-store-connect":
        raise ValueError("Distribution export requires App Store Connect signing")
    if options.get("manageAppVersionAndBuildNumber") is not False:
        raise ValueError("Distribution export must preserve the resolved build number")

    common = [
        "xcodebuild",
        "-exportArchive",
        "-archivePath",
        str(archive),
        "-allowProvisioningUpdates",
        "-authenticationKeyPath",
        str(p8_path),
        "-authenticationKeyID",
        key_id,
        "-authenticationKeyIssuerID",
        issuer_id,
    ]
    with tempfile.TemporaryDirectory(prefix="ios-distribution-") as temporary:
        temporary_path = Path(temporary)
        export_options = temporary_path / "ExportOptions.plist"
        options["destination"] = "export"
        export_options.write_bytes(plistlib.dumps(options))
        subprocess.run(
            [
                *common,
                "-exportOptionsPlist",
                str(export_options),
                "-exportPath",
                str(export_path),
            ],
            check=True,
        )
        ipas = list(export_path.glob("*.ipa"))
        if len(ipas) != 1:
            raise ValueError("Expected exactly one distribution IPA")
        unpacked = temporary_path / "unpacked"
        subprocess.run(["ditto", "-x", "-k", str(ipas[0]), str(unpacked)], check=True)
        apps = list((unpacked / "Payload").glob("*.app"))
        if len(apps) != 1:
            raise ValueError("Expected exactly one distribution app in the IPA")
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("verify-ios-push-entitlements.py")),
                "--app-bundle",
                str(apps[0]),
            ],
            check=True,
        )
        print("Production APNs distribution export verified before upload.", flush=True)
        if dry_run:
            return
        # Keep Xcode as the upload owner. Its upload may repackage the same
        # immutable archive; this is not a claim of byte-identical IPA upload.
        options["destination"] = "upload"
        export_options.write_bytes(plistlib.dumps(options))
        subprocess.run(
            [
                *common,
                "-exportOptionsPlist",
                str(export_options),
                "-exportPath",
                str(export_path.parent / "upload"),
            ],
            check=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--export-path", required=True, type=Path)
    parser.add_argument("--options", required=True, type=Path)
    parser.add_argument("--p8-path", required=True, type=Path)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--issuer-id", required=True)
    parser.add_argument("--dry-run", required=True, choices=("true", "false"))
    args = parser.parse_args()
    export_distribution(
        args.archive,
        args.export_path,
        args.options,
        args.p8_path,
        args.key_id,
        args.issuer_id,
        args.dry_run == "true",
    )


if __name__ == "__main__":
    main()
