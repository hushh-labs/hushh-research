#!/usr/bin/env python3
"""Resolve the next iOS TestFlight build number (CFBundleVersion).

The one-click TestFlight pipeline needs a build number that is strictly greater
than all three:

  * the highest build already known to App Store Connect for this marketing
    version train (so TestFlight accepts the upload -- it rejects duplicate or
    lower CFBundleVersion values within a CFBundleShortVersionString), and
  * the highest retained ``buildUploads`` record, including failed or awaiting
    uploads that no longer appear in the normal ``builds`` collection, and
  * the ``CURRENT_PROJECT_VERSION`` committed in ``project.pbxproj`` (which is
    frequently stale relative to what has actually shipped to TestFlight).

It authenticates to the App Store Connect API with an ES256 JWT minted from a
downloaded ``.p8`` key (App Manager role), reads the builds for the app, and
prints ``max(asc_latest, pbxproj_current) + 1`` to stdout. All diagnostics go to
stderr so the caller can capture the number cleanly:

    NEXT_BUILD="$(python3 scripts/ci/resolve-ios-build-number.py \
        --p8-path "$RUNNER_TEMP/asc.p8" \
        --key-id "$ASC_KEY_ID" --issuer-id "$ASC_ISSUER_ID")"

Only PyJWT + cryptography are required beyond the standard library; both are
pip-installed in the workflow job.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ASC_API_ROOT = "https://api.appstoreconnect.apple.com"
ASC_AUDIENCE = "appstoreconnect-v1"
DEFAULT_BUNDLE_ID = "com.hushh.app"
DEFAULT_PBXPROJ = os.path.join(
    "hushh-webapp", "ios", "App", "App.xcodeproj", "project.pbxproj"
)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def die(message: str) -> "NoReturn":  # type: ignore[name-defined]
    log(f"resolve-ios-build-number: {message}")
    raise SystemExit(1)


def read_pbxproj_values(pbxproj_path: str) -> tuple[int, str | None]:
    """Return (max CURRENT_PROJECT_VERSION, first MARKETING_VERSION) from pbxproj."""
    try:
        with open(pbxproj_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        die(f"cannot read {pbxproj_path}: {exc}")

    current_versions = [
        int(match)
        for match in re.findall(r"CURRENT_PROJECT_VERSION\s*=\s*([0-9]+)\s*;", text)
    ]
    pbx_current = max(current_versions) if current_versions else 0

    marketing_match = re.search(
        r"MARKETING_VERSION\s*=\s*([0-9][0-9A-Za-z.\-]*)\s*;", text
    )
    marketing = marketing_match.group(1) if marketing_match else None
    return pbx_current, marketing


def mint_jwt(p8_path: str, key_id: str, issuer_id: str) -> str:
    try:
        import jwt  # PyJWT
    except ImportError:
        die("PyJWT is required (pip install pyjwt cryptography)")

    try:
        with open(p8_path, "r", encoding="utf-8") as handle:
            private_key = handle.read()
    except OSError as exc:
        die(f"cannot read App Store Connect key at {p8_path}: {exc}")

    now = int(time.time())
    payload = {
        "iss": issuer_id,
        "iat": now,
        # ASC rejects tokens with a lifetime > 20 minutes.
        "exp": now + 19 * 60,
        "aud": ASC_AUDIENCE,
    }
    try:
        token = jwt.encode(
            payload,
            private_key,
            algorithm="ES256",
            headers={"kid": key_id, "typ": "JWT"},
        )
    except Exception as exc:  # cryptography / key parsing errors
        die(f"failed to sign App Store Connect JWT: {exc}")
    # PyJWT>=2 returns str already; be defensive for older versions.
    return token if isinstance(token, str) else token.decode("utf-8")


def asc_get(url: str, token: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        die(f"App Store Connect API {exc.code} for {url}: {body}")
    except urllib.error.URLError as exc:
        die(f"App Store Connect API request failed for {url}: {exc}")


def resolve_app_id(token: str, bundle_id: str) -> str:
    query = urllib.parse.urlencode(
        {"filter[bundleId]": bundle_id, "limit": "1"}
    )
    payload = asc_get(f"{ASC_API_ROOT}/v1/apps?{query}", token)
    data = payload.get("data") or []
    if not data:
        die(f"no App Store Connect app found for bundle id {bundle_id}")
    return data[0]["id"]


def latest_build_number(token: str, app_id: str, marketing_version: str | None = None) -> int:
    """Highest CFBundleVersion known to ASC across ALL marketing version trains."""
    query = urllib.parse.urlencode(
        {
            "filter[app]": app_id,
            "limit": "200",
            "sort": "-version",
        }
    )
    url = f"{ASC_API_ROOT}/v1/builds?{query}"
    highest = 0
    seen = 0
    while url:
        payload = asc_get(url, token)
        for build in payload.get("data", []):
            seen += 1
            raw = (build.get("attributes") or {}).get("version")
            try:
                highest = max(highest, int(str(raw).strip()))
            except (TypeError, ValueError):
                # Non-numeric build strings are not valid CFBundleVersion values
                # for uploads; ignore rather than crash.
                continue
        url = (payload.get("links") or {}).get("next")
    log(
        f"App Store Connect: inspected {seen} total build(s) across all trains; "
        f"global highest CFBundleVersion = {highest}"
    )
    return highest


def latest_upload_number(token: str, app_id: str) -> int:
    """Highest iOS CFBundleVersion retained in ASC build-upload history.

    Rejected uploads can disappear from ``/v1/builds`` while their upload
    records remain addressable. Reusing that number makes the release verifier
    match stale state, so allocate above both resource families.
    """
    query = urllib.parse.urlencode(
        {
            "filter[platform]": "IOS",
            "fields[buildUploads]": "cfBundleVersion",
            "limit": "200",
        }
    )
    url = f"{ASC_API_ROOT}/v1/apps/{app_id}/buildUploads?{query}"
    highest = 0
    seen = 0
    while url:
        payload = asc_get(url, token)
        for upload in payload.get("data", []):
            seen += 1
            raw = (upload.get("attributes") or {}).get("cfBundleVersion")
            try:
                highest = max(highest, int(str(raw).strip()))
            except (TypeError, ValueError):
                continue
        url = (payload.get("links") or {}).get("next")
    log(
        f"App Store Connect: inspected {seen} retained iOS upload(s); "
        f"highest CFBundleVersion = {highest}"
    )
    return highest


def resolve_next_build_number(
    pbx_current: int, asc_build_latest: int, asc_upload_latest: int
) -> int:
    return max(pbx_current, asc_build_latest, asc_upload_latest) + 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--p8-path",
        default=os.environ.get("APPSTORE_CONNECT_API_KEY_PATH"),
        help="Path to the App Store Connect .p8 private key.",
    )
    parser.add_argument(
        "--key-id",
        default=os.environ.get("APPSTORE_CONNECT_KEY_ID")
        or os.environ.get("ASC_KEY_ID"),
        help="App Store Connect API Key ID.",
    )
    parser.add_argument(
        "--issuer-id",
        default=os.environ.get("APPSTORE_CONNECT_ISSUER_ID")
        or os.environ.get("ASC_ISSUER_ID"),
        help="App Store Connect API Issuer ID.",
    )
    parser.add_argument(
        "--bundle-id",
        default=os.environ.get("IOS_BUNDLE_ID", DEFAULT_BUNDLE_ID),
        help=f"App bundle identifier (default: {DEFAULT_BUNDLE_ID}).",
    )
    parser.add_argument(
        "--pbxproj",
        default=os.environ.get("IOS_PBXPROJ_PATH", DEFAULT_PBXPROJ),
        help="Path to project.pbxproj (for the fallback/floor version).",
    )
    parser.add_argument(
        "--marketing-version",
        default=os.environ.get("IOS_MARKETING_VERSION"),
        help="Marketing version train to query (default: read from pbxproj).",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    missing = [
        name
        for name, value in (
            ("--p8-path", args.p8_path),
            ("--key-id", args.key_id),
            ("--issuer-id", args.issuer_id),
        )
        if not value
    ]
    if missing:
        die(f"missing required argument(s): {', '.join(missing)}")

    pbx_current, pbx_marketing = read_pbxproj_values(args.pbxproj)
    marketing_version = args.marketing_version or pbx_marketing
    if not marketing_version:
        die("could not determine marketing version (pass --marketing-version)")

    token = mint_jwt(args.p8_path, args.key_id, args.issuer_id)
    app_id = resolve_app_id(token, args.bundle_id)
    asc_build_latest = latest_build_number(token, app_id, marketing_version)
    asc_upload_latest = latest_upload_number(token, app_id)
    next_build = resolve_next_build_number(
        pbx_current, asc_build_latest, asc_upload_latest
    )
    log(
        f"pbxproj CURRENT_PROJECT_VERSION = {pbx_current}; "
        f"ASC build latest = {asc_build_latest}; "
        f"ASC upload latest = {asc_upload_latest}; next build = {next_build}"
    )
    print(next_build)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
