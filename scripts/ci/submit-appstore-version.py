#!/usr/bin/env python3
"""Prepare (and, only when explicitly asked, submit) an App Store version.

This is the *App Store release* layer that sits on top of the shared
archive/export/upload used by the TestFlight pipeline. Uploading an ``.ipa`` with
``destination=upload`` puts the build into App Store Connect where it is usable
by **both** TestFlight and a public App Store release; the difference between the
two is entirely at this version/submission layer, not in the binary.

Two modes:

* **default (prepare-only, fully automatable, safe)** -- resolve the app for the
  bundle id, ensure an editable App Store version exists for the marketing
  version with ``releaseType = MANUAL`` (so an approved app never auto-releases
  to the public without a human pressing "Release"), wait for the uploaded build
  to finish processing, and attach that build to the version. This performs every
  automatable step *up to but not including* the irreversible "submit for review"
  action, then stops.

* ``--submit`` (opt-in, gated, IRREVERSIBLE) -- additionally create a review
  submission, add the version to it, and mark it submitted. This is the action
  that sends the build to Apple's App Review for **public release** and cannot be
  cleanly undone. It is never taken unless ``--submit`` is passed explicitly, and
  the production workflow keeps it behind a default-off ``submit_for_review``
  input plus a publish-blocker acknowledgement.

Authentication mirrors ``resolve-ios-build-number.py``: an ES256 JWT minted from
a downloaded ``.p8`` (App Manager role). Only PyJWT + cryptography are needed
beyond the standard library; both are pip-installed in the workflow job.

Diagnostics go to stderr; the resolved version id is printed to stdout so callers
can capture it cleanly. ``--self-test`` exercises JWT minting + argument parsing
entirely offline (no network, no real key) for CI smoke coverage.
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
DEFAULT_PLATFORM = "IOS"
DEFAULT_PBXPROJ = os.path.join(
    "hushh-webapp", "ios", "App", "App.xcodeproj", "project.pbxproj"
)
# App Store version states that are still editable / not yet through review.
EDITABLE_VERSION_STATES = {
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
}
# Build processing states reported by ASC.
BUILD_STATE_VALID = "VALID"
BUILD_STATE_PROCESSING = "PROCESSING"
BUILD_TERMINAL_BAD = {"FAILED", "INVALID"}


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def die(message: str) -> "NoReturn":  # type: ignore[name-defined]
    log(f"submit-appstore-version: {message}")
    raise SystemExit(1)


# --------------------------------------------------------------------------- #
# pbxproj helpers (shared shape with resolve-ios-build-number.py)
# --------------------------------------------------------------------------- #
def read_pbxproj_values(pbxproj_path: str) -> tuple[int, str | None]:
    """Return (max CURRENT_PROJECT_VERSION, first MARKETING_VERSION)."""
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


# --------------------------------------------------------------------------- #
# App Store Connect auth + HTTP
# --------------------------------------------------------------------------- #
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
    return token if isinstance(token, str) else token.decode("utf-8")


def _request(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        die(f"App Store Connect API {exc.code} for {method} {url}: {detail}")
    except urllib.error.URLError as exc:
        die(f"App Store Connect API request failed for {method} {url}: {exc}")


def asc_get(url: str, token: str) -> dict:
    return _request("GET", url, token)


def asc_post(url: str, token: str, body: dict) -> dict:
    return _request("POST", url, token, body)


def asc_patch(url: str, token: str, body: dict) -> dict:
    return _request("PATCH", url, token, body)


# --------------------------------------------------------------------------- #
# ASC resource resolution
# --------------------------------------------------------------------------- #
def resolve_app_id(token: str, bundle_id: str) -> str:
    query = urllib.parse.urlencode({"filter[bundleId]": bundle_id, "limit": "1"})
    payload = asc_get(f"{ASC_API_ROOT}/v1/apps?{query}", token)
    data = payload.get("data") or []
    if not data:
        die(f"no App Store Connect app found for bundle id {bundle_id}")
    app_id = data[0]["id"]
    log(f"App Store Connect app id for {bundle_id} = {app_id}")
    return app_id


def find_app_store_version(
    token: str, app_id: str, marketing_version: str, platform: str
) -> dict | None:
    query = urllib.parse.urlencode(
        {
            "filter[versionString]": marketing_version,
            "filter[platform]": platform,
            "limit": "1",
        }
    )
    url = f"{ASC_API_ROOT}/v1/apps/{app_id}/appStoreVersions?{query}"
    data = asc_get(url, token).get("data") or []
    return data[0] if data else None


def ensure_app_store_version(
    token: str,
    app_id: str,
    marketing_version: str,
    platform: str,
    release_type: str,
) -> dict:
    """Return an editable App Store version, creating it (MANUAL) if absent."""
    existing = find_app_store_version(token, app_id, marketing_version, platform)
    if existing is not None:
        version_id = existing["id"]
        attrs = existing.get("attributes") or {}
        state = attrs.get("appStoreState") or attrs.get("appVersionState")
        current_release = attrs.get("releaseType")
        log(
            f"App Store version {marketing_version} exists (id={version_id}, "
            f"state={state}, releaseType={current_release})"
        )
        if state not in EDITABLE_VERSION_STATES:
            die(
                f"App Store version {marketing_version} is in state '{state}', "
                "which is not editable; refusing to mutate a version that is "
                "already submitted, in review, or live. Bump MARKETING_VERSION "
                "for a new release train."
            )
        if current_release != release_type:
            log(
                f"patching releaseType {current_release} -> {release_type} "
                f"for version {version_id}"
            )
            asc_patch(
                f"{ASC_API_ROOT}/v1/appStoreVersions/{version_id}",
                token,
                {
                    "data": {
                        "type": "appStoreVersions",
                        "id": version_id,
                        "attributes": {"releaseType": release_type},
                    }
                },
            )
        return existing

    log(
        f"creating App Store version {marketing_version} "
        f"(platform={platform}, releaseType={release_type})"
    )
    created = asc_post(
        f"{ASC_API_ROOT}/v1/appStoreVersions",
        token,
        {
            "data": {
                "type": "appStoreVersions",
                "attributes": {
                    "platform": platform,
                    "versionString": marketing_version,
                    "releaseType": release_type,
                },
                "relationships": {
                    "app": {"data": {"type": "apps", "id": app_id}}
                },
            }
        },
    )
    version = created.get("data")
    if not version:
        die("App Store version creation returned no data")
    log(f"created App Store version id = {version['id']}")
    return version


def find_build(
    token: str,
    app_id: str,
    marketing_version: str,
    build_number: str,
) -> dict | None:
    query = urllib.parse.urlencode(
        {
            "filter[app]": app_id,
            "filter[preReleaseVersion.version]": marketing_version,
            "filter[version]": str(build_number),
            "limit": "1",
        }
    )
    url = f"{ASC_API_ROOT}/v1/builds?{query}"
    data = asc_get(url, token).get("data") or []
    return data[0] if data else None


def wait_for_build(
    token: str,
    app_id: str,
    marketing_version: str,
    build_number: str,
    timeout_s: int,
    poll_s: int,
) -> dict:
    """Poll until the uploaded build reaches VALID processing state."""
    deadline = time.time() + timeout_s
    attempt = 0
    while True:
        attempt += 1
        build = find_build(token, app_id, marketing_version, build_number)
        if build is not None:
            state = (build.get("attributes") or {}).get("processingState")
            log(
                f"build {marketing_version} ({build_number}) processingState="
                f"{state} (attempt {attempt})"
            )
            if state == BUILD_STATE_VALID:
                return build
            if state in BUILD_TERMINAL_BAD:
                die(
                    f"build {marketing_version} ({build_number}) processing "
                    f"terminated in state '{state}'"
                )
        else:
            log(
                f"build {marketing_version} ({build_number}) not yet visible to "
                f"App Store Connect (attempt {attempt})"
            )
        if time.time() >= deadline:
            die(
                f"timed out after {timeout_s}s waiting for build "
                f"{marketing_version} ({build_number}) to finish processing"
            )
        time.sleep(poll_s)


def attach_build(token: str, version_id: str, build_id: str) -> None:
    log(f"attaching build {build_id} to App Store version {version_id}")
    asc_patch(
        f"{ASC_API_ROOT}/v1/appStoreVersions/{version_id}/relationships/build",
        token,
        {"data": {"type": "builds", "id": build_id}},
    )
    log("build attached to App Store version")


# --------------------------------------------------------------------------- #
# Gated public submission (IRREVERSIBLE)
# --------------------------------------------------------------------------- #
def submit_for_review(
    token: str, app_id: str, version_id: str, platform: str
) -> str:
    """Create + submit a review submission. IRREVERSIBLE public-release action."""
    log("creating review submission (IRREVERSIBLE public App Store submission)")
    submission = asc_post(
        f"{ASC_API_ROOT}/v1/reviewSubmissions",
        token,
        {
            "data": {
                "type": "reviewSubmissions",
                "attributes": {"platform": platform},
                "relationships": {
                    "app": {"data": {"type": "apps", "id": app_id}}
                },
            }
        },
    ).get("data")
    if not submission:
        die("review submission creation returned no data")
    submission_id = submission["id"]
    log(f"review submission id = {submission_id}")

    log("adding App Store version to review submission")
    asc_post(
        f"{ASC_API_ROOT}/v1/reviewSubmissionItems",
        token,
        {
            "data": {
                "type": "reviewSubmissionItems",
                "relationships": {
                    "reviewSubmission": {
                        "data": {
                            "type": "reviewSubmissions",
                            "id": submission_id,
                        }
                    },
                    "appStoreVersion": {
                        "data": {
                            "type": "appStoreVersions",
                            "id": version_id,
                        }
                    },
                },
            }
        },
    )

    log("marking review submission as submitted")
    asc_patch(
        f"{ASC_API_ROOT}/v1/reviewSubmissions/{submission_id}",
        token,
        {
            "data": {
                "type": "reviewSubmissions",
                "id": submission_id,
                "attributes": {"submitted": True},
            }
        },
    )
    log("review submission submitted to Apple App Review")
    return submission_id


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--p8-path", default=os.environ.get("APPSTORE_CONNECT_API_KEY_PATH"))
    parser.add_argument(
        "--key-id",
        default=os.environ.get("APPSTORE_CONNECT_KEY_ID") or os.environ.get("ASC_KEY_ID"),
    )
    parser.add_argument(
        "--issuer-id",
        default=os.environ.get("APPSTORE_CONNECT_ISSUER_ID") or os.environ.get("ASC_ISSUER_ID"),
    )
    parser.add_argument(
        "--bundle-id",
        default=os.environ.get("IOS_BUNDLE_ID", DEFAULT_BUNDLE_ID),
    )
    parser.add_argument(
        "--platform",
        default=os.environ.get("IOS_ASC_PLATFORM", DEFAULT_PLATFORM),
    )
    parser.add_argument(
        "--pbxproj",
        default=os.environ.get("IOS_PBXPROJ_PATH", DEFAULT_PBXPROJ),
    )
    parser.add_argument(
        "--marketing-version",
        default=os.environ.get("IOS_MARKETING_VERSION"),
        help="Marketing version train (default: read from pbxproj).",
    )
    parser.add_argument(
        "--build-number",
        default=os.environ.get("IOS_BUILD_NUMBER"),
        help="CFBundleVersion of the uploaded build to attach.",
    )
    parser.add_argument(
        "--release-type",
        default=os.environ.get("IOS_ASC_RELEASE_TYPE", "MANUAL"),
        choices=["MANUAL", "AFTER_APPROVAL", "SCHEDULED"],
        help="App Store release type (default MANUAL: never auto-release).",
    )
    parser.add_argument(
        "--wait-timeout",
        type=int,
        default=int(os.environ.get("IOS_BUILD_WAIT_TIMEOUT", "1800")),
        help="Seconds to wait for build processing (default 1800).",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=int(os.environ.get("IOS_BUILD_POLL_INTERVAL", "30")),
        help="Seconds between build-processing polls (default 30).",
    )
    parser.add_argument(
        "--submit",
        action="store_true",
        help=(
            "IRREVERSIBLE: after attaching the build, create and submit a review "
            "submission for public App Store release. Omit to stop before the "
            "final Apple review action."
        ),
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Offline validation of JWT mint + arg parsing; no network, no real key.",
    )
    return parser.parse_args(argv)


def run_self_test() -> int:
    """Mint + verify a JWT against an ephemeral EC key; no network access."""
    import tempfile

    try:
        import jwt  # PyJWT
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError as exc:
        die(f"self-test needs PyJWT + cryptography: {exc}")

    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    with tempfile.NamedTemporaryFile("w", suffix=".p8", delete=False) as handle:
        handle.write(pem)
        p8_path = handle.name
    try:
        token = mint_jwt(p8_path, key_id="TESTKEYID01", issuer_id="test-issuer")
        header = jwt.get_unverified_header(token)
        assert header.get("alg") == "ES256", "expected ES256 header"
        assert header.get("kid") == "TESTKEYID01", "kid not propagated"
        decoded = jwt.decode(
            token,
            key.public_key(),
            algorithms=["ES256"],
            audience=ASC_AUDIENCE,
        )
        assert decoded["iss"] == "test-issuer", "issuer not propagated"
        assert decoded["exp"] - decoded["iat"] <= 20 * 60, "token lifetime too long"
    finally:
        os.unlink(p8_path)

    # Argument parsing must accept the documented shape without a real key.
    parse_args(
        [
            "--p8-path", "/dev/null",
            "--key-id", "K",
            "--issuer-id", "I",
            "--marketing-version", "1.3.5",
            "--build-number", "57",
        ]
    )
    log("self-test OK: JWT mint/verify + arg parsing succeeded (offline)")
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if args.self_test:
        return run_self_test()

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
    if not args.build_number:
        die("--build-number is required (CFBundleVersion of the uploaded build)")

    token = mint_jwt(args.p8_path, args.key_id, args.issuer_id)
    app_id = resolve_app_id(token, args.bundle_id)

    version = ensure_app_store_version(
        token, app_id, marketing_version, args.platform, args.release_type
    )
    version_id = version["id"]

    build = wait_for_build(
        token,
        app_id,
        marketing_version,
        args.build_number,
        timeout_s=args.wait_timeout,
        poll_s=args.poll_interval,
    )
    attach_build(token, version_id, build["id"])

    if args.submit:
        submit_for_review(token, app_id, version_id, args.platform)
        log(
            f"DONE: version {marketing_version} ({args.build_number}) submitted for "
            "public App Store review."
        )
    else:
        log(
            f"DONE (prepare-only): version {marketing_version} ({args.build_number}) "
            "is prepared with the build attached and releaseType="
            f"{args.release_type}. The final 'submit for review' action was NOT "
            "taken (pass --submit to perform it)."
        )

    print(version_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
