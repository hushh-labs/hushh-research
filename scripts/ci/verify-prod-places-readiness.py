#!/usr/bin/env python3
"""Fail closed before production enables the Places directory.

The backend key stays in Secret Manager and in this process's memory. Neither
the key nor the provider response is written to CI logs.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

REQUIRED_SERVICES = frozenset({"places.googleapis.com", "maps-backend.googleapis.com"})
PLACES_TEXT_URL = "https://places.googleapis.com/v1/places:searchText"


class ReadinessError(Exception):
    """A production prerequisite is missing or cannot be proven."""


def _gcloud(*args: str) -> str:
    result = subprocess.run(
        ["gcloud", *args], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise ReadinessError("Google Cloud prerequisite check failed")
    return result.stdout


def verify_enabled_services(project: str) -> None:
    enabled = set(
        _gcloud(
            "services",
            "list",
            f"--project={project}",
            "--enabled",
            "--format=value(config.name)",
        ).splitlines()
    )
    missing = REQUIRED_SERVICES - enabled
    if missing:
        raise ReadinessError(
            "Production Maps APIs are disabled: " + ", ".join(sorted(missing))
        )


def verify_backend_key(project: str) -> None:
    key = _gcloud(
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret=GOOGLE_MAPS_API_KEY",
        f"--project={project}",
    ).strip()
    # curl reads the key from stdin rather than argv. Restrict its syntax so a
    # malformed Secret Manager value cannot inject another curl config entry.
    if not re.fullmatch(r"[A-Za-z0-9_-]+", key):
        raise ReadinessError("Production backend Maps key is missing or malformed")

    probe = subprocess.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--max-time",
            "12",
            "--connect-timeout",
            "5",
            "--config",
            "-",
            "--request",
            "POST",
            "--url",
            PLACES_TEXT_URL,
            "--header",
            "Content-Type: application/json",
            "--header",
            "X-Goog-FieldMask: places.id",
            "--data",
            json.dumps({"textQuery": "San Francisco, California", "maxResultCount": 1}),
            "--write-out",
            "\n%{http_code}",
        ],
        input=f'header = "X-Goog-Api-Key: {key}"\n',
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise ReadinessError("Production backend Maps key probe transport failed")
    response_body, separator, status = probe.stdout.rpartition("\n")
    if not separator or not status.isdigit():
        raise ReadinessError(
            "Production backend Maps key probe returned no HTTP status"
        )
    if status != "200":
        raise ReadinessError(
            f"Production backend Maps key probe returned HTTP {status}"
        )
    try:
        payload = json.loads(response_body)
    except ValueError:
        raise ReadinessError(
            "Production backend Maps key probe returned invalid JSON"
        ) from None

    places = payload.get("places") if isinstance(payload, dict) else None
    if not isinstance(places, list) or not any(
        isinstance(place, dict) and isinstance(place.get("id"), str) and place["id"]
        for place in places
    ):
        raise ReadinessError("Production backend Maps key probe returned no place ID")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    args = parser.parse_args(argv)
    try:
        verify_enabled_services(args.project)
        verify_backend_key(args.project)
    except ReadinessError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    print("Production Places APIs and backend key probe passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
