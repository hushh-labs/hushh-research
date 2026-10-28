"""Read fixed frontend Secret Manager version metadata, without secret payloads.

This module does not authorize builds or deployments. A snapshot is not atomic;
the future hosted caller must bind it to a locked attempt, protect/reconcile
concurrent changes and authenticate build consumption before any acceptance.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

import frontend_secret_pins as pins

require = pins.release.require
Refused = pins.release.Refused


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class MetadataClient:
    """Fixed Google metadata GETs using the current identity; never fetch values."""

    def __init__(self, environment, *, fixture_backend=False):
        require(
            environment in pins.release.TARGETS, "Frontend metadata environment invalid"
        )
        self.project = pins.release.TARGETS[environment]
        require(type(fixture_backend) is bool, "Frontend metadata fixture mode invalid")
        self.environment = environment
        self.fixture_backend = fixture_backend
        token = os.environ.get("CLOUDSDK_AUTH_ACCESS_TOKEN", "").strip()
        if not token:
            executable = shutil.which("gcloud")
            require(executable is not None, "Frontend metadata identity unavailable")
            try:
                result = subprocess.run(  # noqa: S603 -- fixed arguments and resolved executable.
                    [
                        executable,
                        "auth",
                        "print-access-token",
                        "--project=" + self.project,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                raise Refused("Frontend metadata identity unavailable") from None
            require(
                result.returncode == 0 and len(result.stdout) <= 8192,
                "Frontend metadata identity unavailable",
            )
            token = result.stdout.strip()
        require(
            bool(token)
            and len(token) <= 8192
            and "\n" not in token
            and "\r" not in token,
            "Frontend metadata identity unavailable",
        )
        self._token = token
        project = self._get("cloudresourcemanager", "projects/" + self.project)
        number = str(project.get("projectNumber", ""))
        require(
            project.get("projectId") == self.project
            and re.fullmatch(r"[1-9][0-9]*", number),
            "Frontend metadata project invalid",
        )
        self.project_number = number

    def _get(self, api, path, *, missing=False):
        require(
            api in {"cloudresourcemanager", "secretmanager"},
            "Frontend metadata endpoint invalid",
        )
        require(
            path == "projects/" + self.project
            if api == "cloudresourcemanager"
            else re.fullmatch(
                r"projects/[a-z0-9-]+/secrets/[A-Z0-9_]+/versions/latest", path
            )
            is not None
            and path.startswith("projects/" + self.project + "/"),
            "Frontend metadata path invalid",
        )
        request = Request(
            f"https://{api}.googleapis.com/v1/{path}",
            headers={
                "Authorization": "Bearer " + self._token,
                "x-goog-user-project": self.project,
            },
            method="GET",
        )
        try:
            with build_opener(_NoRedirect()).open(request, timeout=30) as response:
                raw = response.read(1_048_577)
        except HTTPError as error:
            try:
                if missing and error.code == 404:
                    return None
            finally:
                error.close()
            raise Refused("Frontend metadata request refused") from None
        except (OSError, URLError, TimeoutError):
            raise Refused("Frontend metadata request unavailable") from None
        require(len(raw) <= 1_048_576, "Frontend metadata response oversized")
        try:
            value = json.loads(
                raw, object_pairs_hook=pins.release.source.backend._json_pairs
            )
        except (TypeError, ValueError, UnicodeError):
            raise Refused("Frontend metadata response invalid") from None
        require(isinstance(value, dict), "Frontend metadata response invalid")
        return value

    def latest(self, name, *, optional):
        required, optional_names = pins.catalog(
            self.environment, fixture_backend=self.fixture_backend
        )
        require(
            name in required | optional_names and optional == (name in optional_names),
            "Frontend metadata name invalid",
        )
        path = f"projects/{self.project}/secrets/{name}/versions/latest"
        value = self._get("secretmanager", path, missing=optional)
        if value is None:
            return None
        resource = value.get("name")
        pattern = rf"projects/(?:{re.escape(self.project)}|{self.project_number})/secrets/{re.escape(name)}/versions/([1-9][0-9]*)"
        match = re.fullmatch(pattern, resource) if isinstance(resource, str) else None
        require(
            match is not None and value.get("state") == "ENABLED",
            "Frontend metadata version invalid",
        )
        return {
            "name": f"projects/{self.project}/secrets/{name}/versions/{match.group(1)}",
            "state": "ENABLED",
        }


def snapshot(environment, *, client=None, fixture_backend=False):
    """Read all fixed names twice; return metadata only, never release authority."""
    deadline = time.monotonic() + 120
    required, optional = pins.catalog(environment, fixture_backend=fixture_backend)
    client = client or MetadataClient(environment, fixture_backend=fixture_backend)
    require(
        client.project == pins.release.TARGETS[environment]
        and client.environment == environment
        and client.fixture_backend is fixture_backend,
        "Frontend metadata project invalid",
    )

    def read():
        result = {}
        for name in sorted(required | optional):
            require(time.monotonic() < deadline, "Frontend metadata deadline exceeded")
            result[name] = client.latest(name, optional=name in optional)
        return result

    first = read()
    pins.validate_inventory(environment, first, fixture_backend=fixture_backend)
    require(read() == first, "Frontend metadata changed during snapshot")
    return {
        "environment": environment,
        "project": client.project,
        "inventory": first,
        "fixtureBackend": fixture_backend,
        "optionalLatestUnresolved": sorted(
            name for name in optional if first[name] is None
        ),
        "snapshotAtomic": False,
        "buildConsumptionVerified": False,
        "environmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
