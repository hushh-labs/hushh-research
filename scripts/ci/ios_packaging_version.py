# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Read-only iOS packaging selection over source, beta and public version history."""
from __future__ import annotations
import re
import urllib.parse


def parts(value: str, die) -> tuple[int, int, int]:
    if not isinstance(value, str) or not re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value
    ):
        die("automatic packaging requires a numeric x.y.z marketing version")
    return tuple(int(part) for part in value.split("."))

def historical_parts(value: str, die) -> tuple[int, int, int]:
    # Apple's appStoreVersions API documents legacy values such as "1.0".
    # Normalize history for ordering only; source/output versions stay x.y.z.
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]+){0,2}", value
    ):
        die("automatic packaging found an unsupported App Store history version")
    components = [int(part) for part in value.split(".")]
    components.extend([0] * (3 - len(components)))
    return components[0], components[1], components[2]


def prerelease_versions(token: str, app_id: str, platform: str, *, asc_get, die, api_root) -> list[str]:
    """Read the complete app/platform train floor, including manual uploads."""
    query = urllib.parse.urlencode(
        {"filter[app]": app_id, "filter[platform]": platform, "limit": "200"}
    )
    url = f"{api_root}/v1/preReleaseVersions?{query}"
    versions, visited = [], set()
    while url:
        if url in visited or len(visited) >= 100:
            die("automatic packaging cannot establish complete prerelease history")
        visited.add(url)
        payload = asc_get(url, token)
        for item in payload.get("data", []):
            attrs = item.get("attributes") or {}
            if attrs.get("platform") != platform:
                die("automatic packaging found a different prerelease platform")
            versions.append(attrs.get("version"))
        url = (payload.get("links") or {}).get("next")
    return versions


def resolve_packaging_version(
    token: str,
    app_id: str,
    source_version: str,
    platform: str,
    *,
    testflight: bool = False,
    defer_if_review: bool = False,
    asc_get, die, log, prerelease_versions, api_root, editable_states,
) -> str:
    """Read-only automatic train selection; never mutate a reviewed version."""

    minimum = parts(source_version, die)
    for version in prerelease_versions(token, app_id, platform):
        minimum = max(minimum, historical_parts(version, die))
    query = urllib.parse.urlencode({"filter[platform]": platform, "limit": "200"})
    url = f"{api_root}/v1/apps/{app_id}/appStoreVersions?{query}"
    versions = []
    while url:
        payload = asc_get(url, token)
        versions.extend(
            item.get("attributes") or {} for item in payload.get("data", [])
        )
        url = (payload.get("links") or {}).get("next")
    if not versions:
        return ".".join(map(str, minimum))
    ordered = [
        (historical_parts(attrs.get("versionString"), die), attrs) for attrs in versions
    ]
    version = max(key for key, _ in ordered)
    latest_candidates = [attrs for key, attrs in ordered if key == version]
    if len(latest_candidates) != 1:
        die("automatic packaging found ambiguous latest App Store version records")
    latest = latest_candidates[0]
    state = latest.get("appStoreState") or latest.get("appVersionState")
    if state in editable_states:
        selected = ".".join(map(str, max(minimum, version)))
        if max(minimum, version) == version and latest["versionString"] != selected:
            die(
                "automatic packaging cannot reuse a noncanonical editable version"
            )
        return selected
    pending = {
        "WAITING_FOR_REVIEW",
        "IN_REVIEW",
        "PENDING_DEVELOPER_RELEASE",
        "PENDING_APPLE_RELEASE",
        "PROCESSING_FOR_APP_STORE",
    }
    if state in pending:
        if testflight:
            return ".".join(
                map(str, max(minimum, (version[0], version[1], version[2] + 1)))
            )
        if defer_if_review:
            log(
                "Public version is awaiting Apple review or release; defer outside macOS."
            )
            raise SystemExit(75)
    if state not in {
        "READY_FOR_SALE",
        "READY_FOR_DISTRIBUTION",
        "REMOVED_FROM_SALE",
        "DEVELOPER_REMOVED_FROM_SALE",
    }:
        die(
            f"App Store version is {state}; finish its review/release before preparing its successor"
        )
    return ".".join(map(str, max(minimum, (version[0], version[1], version[2] + 1))))
