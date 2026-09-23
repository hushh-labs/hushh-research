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


UNIVERSAL_LINK_PATHS = (
    "/one/kai/plaid/oauth/return",
    "/one/profile/google/oauth/return",
    "/one/profile/gmail/oauth/return",
    "/kai/plaid/oauth/return",
    "/profile/google/oauth/return",
    "/profile/gmail/oauth/return",
)


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
    except urllib.error.URLError as error:
        reason = str(error.reason).strip() or "network error"
        raise RuntimeError(f"Could not fetch {url}: {reason}") from error


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


def _verify_aasa(
    payload: Any, expected_app_id: str, *, require_app_links: bool = True
) -> None:
    if not isinstance(payload, dict):
        raise RuntimeError("AASA payload must be an object")
    if require_app_links:
        applinks = payload.get("applinks")
        if not isinstance(applinks, dict):
            raise RuntimeError("AASA payload is missing applinks")
        details = applinks.get("details")
        if not isinstance(details, list):
            raise RuntimeError("AASA applinks is missing details")
        matching_details = [
            entry
            for entry in details
            if isinstance(entry, dict)
            and isinstance(entry.get("appIDs"), list)
            and expected_app_id in entry["appIDs"]
        ]
        if not matching_details:
            raise RuntimeError("AASA applinks does not authorize the configured iOS app")
        claimed_paths = {
            component.get("/")
            for entry in matching_details
            for component in entry.get("components", [])
            if isinstance(component, dict) and isinstance(component.get("/"), str)
        }
        missing_paths = [path for path in UNIVERSAL_LINK_PATHS if path not in claimed_paths]
        if missing_paths:
            raise RuntimeError(
                "AASA applinks is missing OAuth return paths: " + ", ".join(missing_paths)
            )
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
    require_app_links: bool = True,
) -> None:
    if not isinstance(payload, list):
        raise RuntimeError("Digital Asset Links payload must be an array")
    required_relations = {"delegate_permission/common.get_login_creds"}
    if require_app_links:
        required_relations.add("delegate_permission/common.handle_all_urls")
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        relations = entry.get("relation")
        target = entry.get("target")
        if (
            not isinstance(relations, list)
            or not required_relations.issubset(relations)
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
    parser.add_argument(
        "--credentials-only-origin", action="append", default=[],
        help="Additional shared RP origin: verify credentials without app-link routes",
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

        origins = [(value, True) for value in args.origin]
        origins.extend((value, False) for value in args.credentials_only_origin)
        for raw_origin, require_app_links in origins:
            origin = _origin(raw_origin)
            aasa = _json(
                _fetch(f"{origin}/.well-known/apple-app-site-association", args.timeout_seconds),
                f"{origin} AASA",
            )
            asset_links = _json(
                _fetch(f"{origin}/.well-known/assetlinks.json", args.timeout_seconds),
                f"{origin} Digital Asset Links",
            )
            _verify_aasa(aasa, expected_ios_app_id, require_app_links=require_app_links)
            _verify_asset_links(
                asset_links,
                expected_package=expected_android_package,
                expected_fingerprints=expected_fingerprints,
                require_app_links=require_app_links,
            )
            print(f"Passkey associations verified for {origin}.")
    except (RuntimeError, ValueError) as error:
        print(f"Passkey association verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
