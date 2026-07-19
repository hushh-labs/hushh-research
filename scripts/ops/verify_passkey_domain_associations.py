#!/usr/bin/env python3
"""Verify the public native-passkey domain associations without logging secrets."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


@dataclass(frozen=True)
class _HttpResponse:
    status: int
    content_type: str
    body: bytes


def _secret(project: str, name: str) -> str:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            name,
            "--project",
            project,
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Could not load required passkey association secret: {name}")
    value = result.stdout.decode("utf-8").strip()
    if not value:
        raise RuntimeError(f"Required passkey association secret is empty: {name}")
    return value


def _origin(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError(f"Passkey association origin must be a clean HTTPS origin: {value}")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _fetch(url: str, timeout_seconds: int) -> _HttpResponse:
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            return _HttpResponse(
                status=response.status,
                content_type=response.headers.get_content_type(),
                body=response.read(),
            )
    except urllib.error.HTTPError as error:
        return _HttpResponse(
            status=error.code,
            content_type=error.headers.get_content_type(),
            body=error.read(),
        )


def _json(response: _HttpResponse, label: str) -> Any:
    if response.status != 200:
        raise RuntimeError(f"{label} returned HTTP {response.status}; expected 200")
    if response.content_type != "application/json":
        raise RuntimeError(
            f"{label} returned {response.content_type!r}; expected application/json"
        )
    try:
        return json.loads(response.body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{label} returned invalid JSON") from error


def _verify_aasa(payload: Any, expected_app_id: str) -> None:
    if not isinstance(payload, dict):
        raise RuntimeError("AASA payload must be an object")
    webcredentials = payload.get("webcredentials")
    if not isinstance(webcredentials, dict):
        raise RuntimeError("AASA payload is missing webcredentials")
    apps = webcredentials.get("apps")
    if not isinstance(apps, list) or expected_app_id not in apps:
        raise RuntimeError("AASA webcredentials does not authorize the configured iOS app")


def _verify_asset_links(
    payload: Any,
    *,
    expected_package: str,
    expected_fingerprints: set[str],
) -> None:
    if not isinstance(payload, list):
        raise RuntimeError("Digital Asset Links payload must be an array")
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        relations = entry.get("relation")
        target = entry.get("target")
        if (
            not isinstance(relations, list)
            or "delegate_permission/common.get_login_creds" not in relations
            or not isinstance(target, dict)
            or target.get("namespace") != "android_app"
            or target.get("package_name") != expected_package
        ):
            continue
        fingerprints = target.get("sha256_cert_fingerprints")
        if not isinstance(fingerprints, list):
            continue
        actual = {str(item).strip().upper() for item in fingerprints if str(item).strip()}
        if actual == expected_fingerprints:
            return
    raise RuntimeError("Digital Asset Links does not authorize the configured Android app")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify public Apple/Android passkey domain associations."
    )
    parser.add_argument("--project", required=True, help="GCP project holding association secrets")
    parser.add_argument(
        "--origin",
        action="append",
        required=True,
        help="HTTPS app origin to verify; pass once per domain",
    )
    parser.add_argument("--timeout-seconds", type=int, default=15)
    args = parser.parse_args()

    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be greater than zero")

    try:
        expected_ios_app_id = f"{_secret(args.project, 'APPLE_TEAM_ID')}.{_secret(args.project, 'NEXT_PUBLIC_IOS_BUNDLE_ID')}"
        expected_android_package = _secret(args.project, "NEXT_PUBLIC_ANDROID_APP_ID")
        expected_fingerprints = {
            item.strip().upper()
            for item in _secret(args.project, "ANDROID_SHA256_CERT_FINGERPRINTS").split(",")
            if item.strip()
        }
        if not expected_fingerprints:
            raise RuntimeError("Configured Android certificate fingerprint list is empty")

        for raw_origin in args.origin:
            origin = _origin(raw_origin)
            aasa = _json(
                _fetch(f"{origin}/.well-known/apple-app-site-association", args.timeout_seconds),
                f"{origin} AASA",
            )
            asset_links = _json(
                _fetch(f"{origin}/.well-known/assetlinks.json", args.timeout_seconds),
                f"{origin} Digital Asset Links",
            )
            _verify_aasa(aasa, expected_ios_app_id)
            _verify_asset_links(
                asset_links,
                expected_package=expected_android_package,
                expected_fingerprints=expected_fingerprints,
            )
            print(f"Passkey associations verified for {origin}.")
    except (RuntimeError, ValueError) as error:
        print(f"Passkey association verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
