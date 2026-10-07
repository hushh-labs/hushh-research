#!/usr/bin/env python3
"""Fail an opted-in Instagram launch if its Cloud Run candidate lacks secrets.

This reads revision metadata only. It never retrieves or prints secret values.
The active registry row is checked separately by the pinned reconciler while
the deployment's attested database connection is open.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REQUIRED_SECRET_REFS = {
    "INSTAGRAM_APP_ID": "INSTAGRAM_APP_ID",
    "INSTAGRAM_APP_SECRET": "INSTAGRAM_APP_SECRET",
    "EXTERNAL_CONNECTOR_CREDENTIAL_KEY": "EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
}


def missing_bindings(revision: dict[str, Any], environment: str) -> list[str]:
    """Return only safe variable names; never include environment values."""
    required = dict(REQUIRED_SECRET_REFS)
    if environment == "uat":
        # Public oEmbed fails closed unless its shared Redis limiter is bound.
        required["RATE_LIMIT_STORAGE_URI"] = "RATE_LIMIT_STORAGE_URI"
    containers = (revision.get("spec") or {}).get("containers") or []
    if len(containers) != 1 or not isinstance(containers[0], dict):
        return list(required)
    entries = containers[0].get("env") or []
    env = {
        item.get("name"): item
        for item in entries
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    missing = []
    for name, secret_name in required.items():
        item = env.get(name) or {}
        ref = (item.get("valueFrom") or {}).get("secretKeyRef") or {}
        if (
            "value" in item
            or ref.get("name") != secret_name
            or ref.get("key") != "latest"
        ):
            missing.append(name)
    return missing


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision-json", required=True, type=Path)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--environment", required=True, choices=("uat", "production"))
    args = parser.parse_args(argv)
    try:
        revision = json.loads(args.revision_json.read_text(encoding="utf-8"))
        if not isinstance(revision, dict):
            raise ValueError("revision_json_invalid")
        if (revision.get("metadata") or {}).get("name") != args.expected_revision:
            raise ValueError("revision_identity_mismatch")
        missing = missing_bindings(revision, args.environment)
    except (OSError, ValueError, TypeError, AttributeError):
        # The diagnostic is intentionally fixed; gcloud revision payloads can
        # contain environment literals unrelated to Instagram.
        print(
            json.dumps({"status": "error", "code": "instagram_candidate_invalid"}),
            file=sys.stderr,
        )
        return 1
    if missing:
        print(
            json.dumps(
                {
                    "status": "error",
                    "code": "instagram_secret_binding_missing",
                    "variables": missing,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps({"status": "ready", "revision": args.expected_revision}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
