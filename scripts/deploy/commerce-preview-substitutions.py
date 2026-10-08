#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Apply one fixed preview target to the existing Cloud Build substitutions."""

import argparse
import sys
from pathlib import Path
from runpy import run_path

TARGET = run_path(str(Path(__file__).with_name("commerce-preview-target.py")))
PREFIX = TARGET["PREFIX"]


def substitutions(value: str, kind: str) -> str:
    delimiter = "##" if kind == "backend" else ","
    rows = value.removeprefix("^##^").split(delimiter)
    pairs = dict(row.split("=", 1) for row in rows if row)
    if kind == "backend":
        pairs |= {
            "_BACKEND_SERVICE": TARGET["BACKEND"],
            "_SECRET_PREFIX": PREFIX,
            "_RUNTIME_SERVICE_ACCOUNT": TARGET["RUNTIME_SA"],
            "_CLOUDSQL_INSTANCES": "hushh-pda-dev:us-central1:hushh-dev-pg",
            "_BUILD_POD_IMAGE": "false",
            "_CLOUD_RUN_MAX_INSTANCES": "1",
            "_CLOUD_RUN_MIN_INSTANCES": "1",
            "_GENAI_PROJECT_ID": TARGET["PROJECT"],
            "_DRIVE_WORK_DRAIN_ENABLED": "false",
            "_DRIVE_REQUEST_PAYMENTS_ENABLED": "false",
        }
        for key in tuple(pairs):
            if key.startswith(("_PLAID_", "_GMAIL_", "_ONE_EMAIL_")):
                pairs[key] = ""
        # Keep machine routes authenticated but unconfigured and unscheduled.
        pairs |= {
            "_ONE_EMAIL_WEBHOOK_AUTH_ENABLED": "true",
            "_ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED": "true",
        }
    else:
        pairs |= {
            "_SECRET_PREFIX": PREFIX,
            "_APP_ENV": "dev",
            "_DEPLOY_ENV": "dev",
            "_OBSERVABILITY_ENABLED": "false",
        }
        if kind == "frontend":
            pairs |= {
                "_FRONTEND_SERVICE": TARGET["FRONTEND"],
                "_FRONTEND_RUNTIME_SERVICE_ACCOUNT": TARGET["RUNTIME_SA"],
            }
    config_name = (
        "backend"
        if kind == "backend"
        else "frontend-image"
        if kind == "frontend-image"
        else "frontend"
    )
    import yaml

    config = yaml.safe_load(
        (
            Path(__file__).resolve().parents[2]
            / f"deploy/{config_name}.cloudbuild.yaml"
        ).read_text()
    )
    if not set(pairs) <= set(config.get("substitutions", {})):
        raise ValueError("preview_candidate_interface_missing")
    return delimiter.join(f"{key}={val}" for key, val in pairs.items())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--kind", choices=("backend", "frontend", "frontend-image"), required=True
    )
    args = parser.parse_args()
    try:
        print(substitutions(sys.stdin.read().strip(), args.kind))
    except (OSError, ValueError, KeyError):
        raise SystemExit("preview_candidate_interface_missing") from None
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
