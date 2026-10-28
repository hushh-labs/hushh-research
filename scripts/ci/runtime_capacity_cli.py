# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Import-safe command-line options for the capacity admission entrypoint."""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import urllib.request
from pathlib import Path

_DEV_PROJECT = "hushh-pda-dev"
_VERSION = re.compile(
    r"projects/([^/]+)/secrets/([A-Za-z0-9_-]+)/versions/([1-9][0-9]*)"
)


def _normal_gcloud(*args: str) -> str:
    result = subprocess.run(
        ["gcloud", *args], check=True, capture_output=True, text=True, timeout=20
    )
    if len(result.stdout.encode()) > 16_384:
        raise ValueError("gcloud response bound")
    return result.stdout


class _NoSecretRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class _DevRouteSecretReader:
    """Normal current identity; fixed-project payloads stay in process memory."""

    def __init__(self, inventory):
        self._inventory = inventory
        try:
            project = json.loads(
                _normal_gcloud("projects", "describe", _DEV_PROJECT, "--format=json")
            )
            number = str(project.get("projectNumber", ""))
            if project.get("projectId") != _DEV_PROJECT or not number.isdigit():
                raise ValueError("project identity")
            self._aliases = {_DEV_PROJECT, number}
            self._token = _normal_gcloud("auth", "print-access-token").strip()
            if not self._token or any(char.isspace() for char in self._token):
                raise ValueError("token unavailable")
            self._opener = urllib.request.build_opener(_NoSecretRedirect())
        except Exception:
            raise inventory.BudgetError(
                "fixed DEV route secret reader is unavailable"
            ) from None

    def _get(self, resource: str) -> dict:
        request = urllib.request.Request(
            "https://secretmanager.googleapis.com/v1/" + resource,
            headers={"Authorization": "Bearer " + self._token},
        )
        with self._opener.open(request, timeout=12) as response:
            raw = response.read(131_073)
        if len(raw) > 131_072:
            raise ValueError("Secret Manager response bound")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("Secret Manager response shape")
        return result

    def __call__(self, _workload: dict, entry: dict, project: str):
        try:
            reference = entry["valueFrom"]["secretKeyRef"]
            name, key = reference["name"], reference["key"]
            if (
                project != _DEV_PROJECT
                or not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]+", name)
                or not isinstance(key, str)
                or not re.fullmatch(r"latest|[1-9][0-9]*", key)
            ):
                raise ValueError("fixed secret reference")
            metadata = self._get(
                f"projects/{_DEV_PROJECT}/secrets/{name}/versions/{key}"
            )
            resource = metadata.get("name", "")
            match = _VERSION.fullmatch(resource)
            if (
                metadata.get("state") != "ENABLED"
                or match is None
                or match[1] not in self._aliases
                or match[2] != name
                or (key != "latest" and match[3] != key)
            ):
                raise ValueError("enabled numeric secret version")
            accessed = self._get(resource + ":access")
            if accessed.get("name") != resource:
                raise ValueError("accessed version differs")
            encoded = accessed["payload"]["data"]
            if not isinstance(encoded, str) or len(encoded) > 87_384:
                raise ValueError("encoded payload bound")
            payload = base64.b64decode(encoded, validate=True)
            if len(payload) > 65_536:
                raise ValueError("decoded payload bound")
            return self._inventory.ResolvedRouteSecret(
                resource, payload.decode("utf-8")
            )
        except Exception:
            raise self._inventory.BudgetError(
                "fixed DEV route secret is unavailable"
            ) from None


def dev_route_secret_reader(profile: dict, environment: str, inventory):
    """Only the reviewed isolated DEV collector obtains an actual secret reader."""
    if environment != "dev":
        return None
    if not inventory.isolated_dev_scope(
        profile["environments"][environment], profile["region"], environment
    ):
        raise inventory.BudgetError("DEV route reader requires isolated qualification")
    return _DevRouteSecretReader(inventory)


def parse_args(
    description: str | None, phases: tuple[str, ...], default_profile: Path
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--environment", choices=("dev", "uat", "production"), required=True
    )
    parser.add_argument(
        "--phase",
        choices=phases,
        default="pre-deploy",
        help="Reserve the next deployment candidate, or check only retained capacity",
    )
    parser.add_argument("--profile", type=Path, default=default_profile)
    parser.add_argument(
        "--additional-candidate-service",
        action="append",
        default=[],
        help="Also reserve one independent production fallback revision of this service",
    )
    candidates = parser.add_mutually_exclusive_group()
    candidates.add_argument(
        "--candidate-service",
        action="append",
        help="Reserve a new revision of this service (repeat for each deployed service)",
    )
    candidates.add_argument(
        "--inherit-candidate-service",
        action="append",
        help="Reserve a candidate inheriting this live service's template (repeatable)",
    )
    candidates.add_argument(
        "--no-candidates",
        action="store_true",
        help="Audit the global database budget without reserving a new service revision",
    )
    candidates.add_argument(
        "--frontend-only",
        action="store_true",
        help="Verify UAT web service has zero incremental SQL demand without auditing unrelated jobs",
    )
    parser.add_argument(
        "--frontend-revision",
        help="Also verify this exact frontend candidate revision before traffic promotion",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Report an over-budget result without a nonzero exit",
    )
    parser.add_argument("--output", choices=("text", "json"), default="text")
    return parser.parse_args()
