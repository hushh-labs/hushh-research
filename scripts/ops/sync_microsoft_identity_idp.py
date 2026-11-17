#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Verify or synchronize Firebase Identity Platform Microsoft OAuth (`microsoft.com`) config.

Reads `MICROSOFT_FIREBASE_CLIENT_ID` and `MICROSOFT_FIREBASE_CLIENT_SECRET` directly
from GCP Secret Manager and compares or updates Firebase Identity Platform without ever
printing or logging secret values.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import urllib.request
from typing import Any, Callable
from uuid import UUID

CLIENT_ID_SECRET = "MICROSOFT_FIREBASE_CLIENT_ID"
CLIENT_SECRET_NAME = "MICROSOFT_FIREBASE_CLIENT_SECRET"  # noqa: S105 - secret name only
IDP_PROVIDER_ID = "microsoft.com"


def validate_client_id(value: str) -> str:
    """Ensure the Microsoft OAuth application client ID is a canonical UUID string."""
    cleaned = str(value or "").strip()
    try:
        canonical = str(UUID(cleaned))
    except ValueError as exc:
        raise ValueError("MICROSOFT_FIREBASE_CLIENT_ID must be a canonical GUID") from exc
    if cleaned.lower() != canonical:
        raise ValueError("MICROSOFT_FIREBASE_CLIENT_ID must be formatted as a lowercase GUID")
    return canonical


def _gcloud_access_token() -> str:
    return subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()


def _read_secret(project: str, secret: str) -> str:
    return subprocess.check_output(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={secret}",
            f"--project={project}",
        ],
        text=True,
    ).strip()


def _http_json(
    url: str,
    *,
    token: str,
    project: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "x-goog-user-project": project,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return dict(json.loads(raw)) if raw else {}


def reconcile_firebase_microsoft_idp(
    project: str,
    *,
    apply: bool = False,
    token_provider: Callable[[], str] = _gcloud_access_token,
    secret_reader: Callable[[str, str], str] = _read_secret,
    http_json: Callable[..., dict[str, Any]] = _http_json,
) -> dict[str, Any]:
    """Verify or apply Firebase `microsoft.com` OAuth settings using Secret Manager."""
    client_id = validate_client_id(secret_reader(project, CLIENT_ID_SECRET))
    client_secret = secret_reader(project, CLIENT_SECRET_NAME)
    if not client_secret:
        raise ValueError("MICROSOFT_FIREBASE_CLIENT_SECRET cannot be empty")

    token = token_provider()
    base_url = (
        f"https://identitytoolkit.googleapis.com/admin/v2/projects/{project}"
        f"/defaultSupportedIdpConfigs/{IDP_PROVIDER_ID}"
    )
    current = http_json(base_url, token=token, project=project, method="GET")
    current_client_id = str(current.get("clientId") or "").strip().lower()
    current_enabled = current.get("enabled") is True
    in_sync = current_enabled and current_client_id == client_id and bool(current.get("clientSecret"))

    if apply:
        updated = http_json(
            f"{base_url}?updateMask=clientId,clientSecret,enabled",
            token=token,
            project=project,
            method="PATCH",
            payload={
                "clientId": client_id,
                "clientSecret": client_secret,
                "enabled": True,
            },
        )
        return {
            "project": project,
            "mode": "apply",
            "enabled": updated.get("enabled") is True,
            "clientId": str(updated.get("clientId") or "").strip().lower(),
            "hasSecret": bool(updated.get("clientSecret")),
            "inSync": updated.get("enabled") is True
            and str(updated.get("clientId") or "").strip().lower() == client_id
            and bool(updated.get("clientSecret")),
        }

    return {
        "project": project,
        "mode": "verify",
        "enabled": current_enabled,
        "clientId": current_client_id,
        "expectedClientId": client_id,
        "hasSecret": bool(current.get("clientSecret")),
        "inSync": in_sync,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--verify-only", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    summary = reconcile_firebase_microsoft_idp(args.project, apply=bool(args.apply))
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary.get("inSync") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
