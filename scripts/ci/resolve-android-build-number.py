#!/usr/bin/env python3
"""Resolve the next Android build number (versionCode).

The Google Play production pipeline needs a versionCode that is strictly greater
than both:

  * the highest versionCode already known to Google Play Console for
    com.hussh.app across current bundles, APKs, and active track releases, and
  * the ``versionCode`` committed in ``hushh-webapp/android/app/build.gradle``.

This script reads the local ``build.gradle`` versionCode, mints a Google OAuth2
access token from a service account JSON file (if provided) and queries the
Google Play Developer API for the highest versionCode across current binary
artifacts and active tracks, then prints ``max(play_latest, gradle_current) + 1``
to stdout. All diagnostics go to stderr so callers can capture the number cleanly:

    NEXT_VERSION_CODE="$(python3 scripts/ci/resolve-android-build-number.py \
        --service-account-json "$RUNNER_TEMP/google-play-key.json")"

    # Or to automatically update build.gradle in-place:
    python3 scripts/ci/resolve-android-build-number.py --update-gradle

Only PyJWT + cryptography are required beyond the standard library for the
Play Developer API query; both are pip-installed in the workflow job. The
production workflow always supplies ``--service-account-json`` and fails closed
if Play cannot be queried. Omitting it remains an explicit local-only fallback
to ``gradle_current + 1``.
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
from typing import NoReturn

DEFAULT_PACKAGE_NAME = "com.hussh.app"
DEFAULT_GRADLE_PATH = os.path.join(
    "hushh-webapp", "android", "app", "build.gradle"
)
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
PLAY_API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3"
PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def die(message: str) -> NoReturn:
    log(f"resolve-android-build-number: {message}")
    raise SystemExit(1)


def read_gradle_values(gradle_path: str) -> tuple[int, str | None]:
    """Return (versionCode, versionName) from build.gradle."""
    try:
        with open(gradle_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        die(f"cannot read {gradle_path}: {exc}")

    code_match = re.search(r"versionCode\s+([0-9]+)", text)
    gradle_code = int(code_match.group(1)) if code_match else 1

    name_match = re.search(r'versionName\s+"([^"]+)"', text)
    version_name = name_match.group(1) if name_match else None

    return gradle_code, version_name


def update_gradle_version_code(gradle_path: str, new_code: int) -> None:
    """Update versionCode in build.gradle in-place."""
    try:
        with open(gradle_path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        die(f"cannot read {gradle_path}: {exc}")

    updated, count = re.subn(r"(versionCode\s+)[0-9]+", f"\\g<1>{new_code}", text)
    if count == 0:
        die(f"could not find 'versionCode <num>' in {gradle_path}")

    with open(gradle_path, "w", encoding="utf-8") as handle:
        handle.write(updated)

    log(f"Updated {gradle_path} versionCode to {new_code}")


def mint_play_access_token(service_account_json_path: str) -> str:
    try:
        import jwt  # PyJWT
    except ImportError:
        die("PyJWT is required (pip install pyjwt cryptography)")

    try:
        with open(service_account_json_path, "r", encoding="utf-8") as handle:
            account = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"cannot read service account JSON at {service_account_json_path}: {exc}")

    client_email = account.get("client_email")
    private_key = account.get("private_key")
    if not client_email or not private_key:
        die(
            f"service account JSON at {service_account_json_path} is missing "
            "client_email/private_key"
        )

    now = int(time.time())
    payload = {
        "iss": client_email,
        "scope": PLAY_SCOPE,
        "aud": GOOGLE_TOKEN_URL,
        "iat": now,
        "exp": now + 3600,
    }
    try:
        assertion = jwt.encode(payload, private_key, algorithm="RS256")
    except Exception as exc:  # cryptography / key parsing errors
        die(f"failed to sign Google service account JWT: {exc}")
    if not isinstance(assertion, str):
        assertion = assertion.decode("utf-8")

    body = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            token_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", "replace")
        die(f"Google token exchange failed ({exc.code}): {body_text}")
    except urllib.error.URLError as exc:
        die(f"Google token exchange request failed: {exc}")

    access_token = token_payload.get("access_token")
    if not access_token:
        die(f"Google token exchange response missing access_token: {token_payload}")
    return access_token


def play_request(url: str, token: str, method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return exc  # caller inspects .code / .read() for graceful handling
    except urllib.error.URLError as exc:
        die(f"Google Play Developer API request failed for {url}: {exc}")


def highest_play_version_code(token: str, package_name: str) -> int:
    """Highest versionCode known to Play, or 0 for a genuinely empty app.

    Authorization and package lookup failures are never equivalent to an empty
    release history: silently treating 403/404 as zero can reuse an already
    uploaded versionCode for an established app.
    """
    edit_result = play_request(
        f"{PLAY_API_ROOT}/applications/{package_name}/edits", token, method="POST", body={}
    )
    if isinstance(edit_result, urllib.error.HTTPError):
        detail = edit_result.read().decode("utf-8", "replace")
        die(f"Google Play Developer API {edit_result.code} creating edit: {detail}")

    edit_id = edit_result.get("id")
    if not edit_id:
        die(f"Google Play edit response missing id: {edit_result}")

    base_url = f"{PLAY_API_ROOT}/applications/{package_name}/edits/{edit_id}"
    results: dict[str, dict] = {}
    for resource in ("tracks", "bundles", "apks"):
        result = play_request(f"{base_url}/{resource}", token)
        if isinstance(result, urllib.error.HTTPError):
            detail = result.read().decode("utf-8", "replace")
            die(
                f"Google Play Developer API {result.code} listing {resource}: {detail}"
            )
        results[resource] = result

    highest = 0
    track_count = 0
    release_code_count = 0
    for track in results["tracks"].get("tracks", []):
        track_count += 1
        for release in track.get("releases", []):
            for code in release.get("versionCodes", []):
                try:
                    highest = max(highest, int(code))
                    release_code_count += 1
                except (TypeError, ValueError):
                    continue

    artifact_count = 0
    for resource, field in (("bundles", "bundles"), ("apks", "apks")):
        for artifact in results[resource].get(field, []):
            try:
                highest = max(highest, int(artifact.get("versionCode")))
                artifact_count += 1
            except (TypeError, ValueError):
                continue

    log(
        f"Google Play: inspected {track_count} track(s), {release_code_count} active "
        f"release code(s), and {artifact_count} current binary artifact(s) for {package_name}; "
        f"highest known versionCode = {highest}"
    )
    return highest


def resolve_next_version_code(gradle_code: int, play_latest: int) -> int:
    """Return the next versionCode above both authoritative floors."""
    if gradle_code < 1:
        raise ValueError("Gradle versionCode must be positive")
    if play_latest < 0:
        raise ValueError("Google Play versionCode floor cannot be negative")
    return max(play_latest, gradle_code) + 1


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Resolve next Google Play versionCode for com.hussh.app."
    )
    parser.add_argument(
        "--package-name",
        default=DEFAULT_PACKAGE_NAME,
        help=f"Android package name (default: {DEFAULT_PACKAGE_NAME})",
    )
    parser.add_argument(
        "--gradle-path",
        default=DEFAULT_GRADLE_PATH,
        help=f"Path to app/build.gradle (default: {DEFAULT_GRADLE_PATH})",
    )
    parser.add_argument(
        "--service-account-json",
        help="Path to Google Play Developer API Service Account JSON file",
    )
    parser.add_argument(
        "--update-gradle",
        action="store_true",
        help="Update build.gradle in-place with the new versionCode",
    )
    args = parser.parse_args()

    gradle_code, version_name = read_gradle_values(args.gradle_path)
    log(f"Local build.gradle versionCode: {gradle_code} (versionName: {version_name})")

    play_latest = 0
    if args.service_account_json:
        token = mint_play_access_token(args.service_account_json)
        play_latest = highest_play_version_code(token, args.package_name)

    next_version_code = resolve_next_version_code(gradle_code, play_latest)
    log(
        f"gradle_current = {gradle_code}; play_latest = {play_latest}; "
        f"next versionCode = {next_version_code}"
    )

    if args.update_gradle:
        update_gradle_version_code(args.gradle_path, next_version_code)

    print(next_version_code)


if __name__ == "__main__":
    main()
