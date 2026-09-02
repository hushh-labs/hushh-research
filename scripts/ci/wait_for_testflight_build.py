#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Wait for an uploaded iOS build to become ready in TestFlight.

App Store Connect exposes two related resources with different lifecycles:

* ``buildUploads`` exists while Apple validates an upload and contains the
  actionable import errors that would otherwise arrive only by email.
* ``builds`` exists after import and reports TestFlight processing state.

The release gate must inspect both. Polling ``builds`` alone cannot distinguish
an upload that is still processing from one Apple has already rejected.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any, NoReturn

ASC_API_ROOT = "https://api.appstoreconnect.apple.com"
ASC_AUDIENCE = "appstoreconnect-v1"
DEFAULT_BUNDLE_ID = "com.hushh.app"
DEFAULT_PLATFORM = "IOS"
UPLOAD_COMPLETE = "COMPLETE"
UPLOAD_FAILED = "FAILED"
BUILD_VALID = "VALID"
BUILD_TERMINAL_BAD = {"FAILED", "INVALID"}


class BuildUploadFailed(RuntimeError):
    """Apple rejected the uploaded binary during import validation."""


class TestFlightBuildFailed(RuntimeError):
    """Apple imported the binary but TestFlight processing failed."""


class AscTransientError(RuntimeError):
    """A retryable App Store Connect transport or service failure."""


def log(message: str) -> None:
    print(message, flush=True)


def die(message: str) -> NoReturn:
    print(f"wait-for-testflight-build: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


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
    except Exception as exc:
        die(f"failed to sign App Store Connect JWT: {exc}")
    return token if isinstance(token, str) else token.decode("utf-8")


def asc_get(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_app_id(token: str, bundle_id: str) -> str:
    query = urllib.parse.urlencode({"filter[bundleId]": bundle_id, "limit": "1"})
    payload = asc_get(f"{ASC_API_ROOT}/v1/apps?{query}", token)
    data = payload.get("data") or []
    if not data:
        die(f"no App Store Connect app found for bundle id {bundle_id}")
    return str(data[0]["id"])


def build_upload_url(
    app_id: str,
    marketing_version: str,
    build_number: str,
    platform: str,
) -> str:
    query = urllib.parse.urlencode(
        {
            "filter[cfBundleShortVersionString]": marketing_version,
            "filter[cfBundleVersion]": build_number,
            "filter[platform]": platform,
            "fields[buildUploads]": (
                "cfBundleShortVersionString,cfBundleVersion,createdDate,"
                "state,platform,uploadedDate,build"
            ),
            "fields[builds]": (
                "version,uploadedDate,processingState,usesNonExemptEncryption"
            ),
            "include": "build",
            "limit": "10",
            "sort": "-uploadedDate",
        }
    )
    return f"{ASC_API_ROOT}/v1/apps/{app_id}/buildUploads?{query}"


def build_url(app_id: str, marketing_version: str, build_number: str) -> str:
    query = urllib.parse.urlencode(
        {
            "filter[app]": app_id,
            "filter[preReleaseVersion.version]": marketing_version,
            "filter[version]": build_number,
            "fields[builds]": (
                "version,uploadedDate,processingState,usesNonExemptEncryption"
            ),
            "limit": "1",
        }
    )
    return f"{ASC_API_ROOT}/v1/builds?{query}"


def upload_state(upload: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    raw = (upload.get("attributes") or {}).get("state")
    if isinstance(raw, str):
        return raw, []
    if not isinstance(raw, dict):
        return None, []
    details: list[dict[str, Any]] = []
    for key in ("errors", "warnings", "infos"):
        values = raw.get(key) or []
        if isinstance(values, list):
            details.extend(item for item in values if isinstance(item, dict))
    state = raw.get("state")
    return str(state) if state is not None else None, details


def matching_upload(
    payload: dict[str, Any], marketing_version: str, build_number: str
) -> dict[str, Any] | None:
    for upload in payload.get("data") or []:
        attrs = upload.get("attributes") or {}
        if (
            str(attrs.get("cfBundleShortVersionString")) == marketing_version
            and str(attrs.get("cfBundleVersion")) == build_number
        ):
            return upload
    return None


def matching_build(payload: dict[str, Any], build_number: str) -> dict[str, Any] | None:
    candidates = list(payload.get("included") or []) + list(payload.get("data") or [])
    for resource in candidates:
        if resource.get("type") != "builds":
            continue
        attrs = resource.get("attributes") or {}
        if str(attrs.get("version")) == build_number:
            return resource
    return None


def format_state_details(details: list[dict[str, Any]]) -> str:
    rendered: list[str] = []
    for detail in details:
        code = str(detail.get("code") or "UNKNOWN")
        description = " ".join(str(detail.get("description") or "").split())
        rendered.append(f"{code}: {description}" if description else code)
    return "; ".join(rendered) if rendered else "no error details returned"


def wait_for_testflight_build(
    *,
    app_id: str,
    marketing_version: str,
    build_number: str,
    platform: str,
    timeout_seconds: int,
    poll_interval_seconds: int,
    get_payload: Callable[[str], dict[str, Any]],
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    deadline = now() + timeout_seconds
    attempt = 0
    last_state = "not found"

    while now() < deadline:
        attempt += 1
        try:
            upload_payload = get_payload(
                build_upload_url(app_id, marketing_version, build_number, platform)
            )
        except AscTransientError as exc:
            last_state = f"transient API error: {exc}"
            log(f"Attempt {attempt}: {last_state}")
            remaining = deadline - now()
            if remaining <= 0:
                break
            sleep(min(float(poll_interval_seconds), remaining))
            continue
        upload = matching_upload(upload_payload, marketing_version, build_number)
        if upload is None:
            last_state = "upload not found"
            log(f"Attempt {attempt}: {last_state}")
        else:
            state, details = upload_state(upload)
            last_state = f"build upload {state or 'UNKNOWN'}"
            log(f"Attempt {attempt}: {last_state}")
            if state == UPLOAD_FAILED:
                raise BuildUploadFailed(format_state_details(details))

            if state == UPLOAD_COMPLETE:
                build = matching_build(upload_payload, build_number)
                if build is None:
                    try:
                        build_payload = get_payload(
                            build_url(app_id, marketing_version, build_number)
                        )
                    except AscTransientError as exc:
                        last_state = (
                            "build upload COMPLETE; transient build API error: "
                            f"{exc}"
                        )
                        log(f"Attempt {attempt}: {last_state}")
                    else:
                        build = matching_build(build_payload, build_number)
                if build is not None:
                    attrs = build.get("attributes") or {}
                    processing_state = attrs.get("processingState")
                    last_state = f"build upload COMPLETE; build {processing_state or 'UNKNOWN'}"
                    log(f"Attempt {attempt}: {last_state}")
                    if processing_state == BUILD_VALID:
                        return build
                    if processing_state in BUILD_TERMINAL_BAD:
                        raise TestFlightBuildFailed(
                            f"build processingState={processing_state}"
                        )

        remaining = deadline - now()
        if remaining <= 0:
            break
        sleep(min(float(poll_interval_seconds), remaining))

    raise TimeoutError(
        f"timed out after {timeout_seconds}s waiting for "
        f"{marketing_version} ({build_number}); last state: {last_state}"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--p8-path", default=os.environ.get("APPSTORE_CONNECT_API_KEY_PATH"))
    parser.add_argument(
        "--key-id",
        default=os.environ.get("APPSTORE_CONNECT_KEY_ID") or os.environ.get("ASC_KEY_ID"),
    )
    parser.add_argument(
        "--issuer-id",
        default=os.environ.get("APPSTORE_CONNECT_ISSUER_ID")
        or os.environ.get("ASC_ISSUER_ID"),
    )
    parser.add_argument(
        "--bundle-id", default=os.environ.get("IOS_BUNDLE_ID", DEFAULT_BUNDLE_ID)
    )
    parser.add_argument("--marketing-version", required=True)
    parser.add_argument("--build-number", required=True)
    parser.add_argument("--platform", default=DEFAULT_PLATFORM)
    parser.add_argument("--timeout-seconds", type=int, default=1200)
    parser.add_argument("--poll-interval-seconds", type=int, default=15)
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
    if args.timeout_seconds <= 0 or args.poll_interval_seconds <= 0:
        die("timeout and poll interval must be positive")

    def get_payload(url: str) -> dict[str, Any]:
        token = mint_jwt(args.p8_path, args.key_id, args.issuer_id)
        try:
            return asc_get(url, token)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            if exc.code == 429 or exc.code >= 500:
                raise AscTransientError(
                    f"HTTP {exc.code} while querying Apple"
                ) from exc
            raise RuntimeError(
                f"App Store Connect API {exc.code} for {url}: {detail}"
            ) from exc
        except urllib.error.URLError as exc:
            raise AscTransientError(f"request failed: {exc.reason}") from exc

    token = mint_jwt(args.p8_path, args.key_id, args.issuer_id)
    app_id = resolve_app_id(token, args.bundle_id)
    log(
        "Polling App Store Connect build upload and TestFlight processing for "
        f"{args.marketing_version} ({args.build_number})..."
    )
    try:
        build = wait_for_testflight_build(
            app_id=app_id,
            marketing_version=args.marketing_version,
            build_number=str(args.build_number),
            platform=args.platform,
            timeout_seconds=args.timeout_seconds,
            poll_interval_seconds=args.poll_interval_seconds,
            get_payload=get_payload,
        )
    except (BuildUploadFailed, TestFlightBuildFailed, TimeoutError, RuntimeError) as exc:
        die(str(exc))

    attrs = build.get("attributes") or {}
    log(
        f"Build {args.marketing_version} ({args.build_number}) is VALID and ready "
        f"for TestFlight testing (encryption exempt: "
        f"{attrs.get('usesNonExemptEncryption') is False})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
