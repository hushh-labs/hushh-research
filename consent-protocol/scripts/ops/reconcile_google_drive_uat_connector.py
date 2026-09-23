#!/usr/bin/env python3
"""Verify or explicitly activate the fixed Google Drive UAT registry row.

This is intentionally not the generic external-MCP connector CLI. Google
Drive uses a fixed REST transport and accepts no caller-provided endpoint,
scope, redirect, policy, OAuth client, or secret. The default action is
read-only verification; ``--activate`` is required to insert or activate the
reviewed UAT row.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[2]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--activate",
        action="store_true",
        help="Explicitly create or activate the reviewed UAT Drive registry row.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        from hushh_mcp.services.drive_uat_registry_provisioning import (
            DriveUatRegistryProvisioner,
            assert_google_drive_uat_registry_target,
        )

        # Keep the UAT target check ahead of constructing a DB service.
        assert_google_drive_uat_registry_target()
        provisioner = DriveUatRegistryProvisioner()
        result = provisioner.activate() if args.activate else provisioner.verify()
    except Exception:
        # Target, DB driver and provider configuration exceptions can contain
        # environment or connection details. Keep every failure redacted.
        print(
            json.dumps({"status": "error", "code": "drive_registry_unavailable"}), file=sys.stderr
        )
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
