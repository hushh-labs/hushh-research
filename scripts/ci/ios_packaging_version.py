# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""iOS packaging selection and guarded preparation of the current public draft."""
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


def app_store_versions(token: str, app_id: str, platform: str, *, asc_get, die, api_root: str) -> list[dict]:
    query = urllib.parse.urlencode({"filter[platform]": platform, "limit": "200"})
    url = f"{api_root}/v1/apps/{app_id}/appStoreVersions?{query}"
    records, visited = [], set()
    while url:
        if url in visited or len(visited) >= 100:
            die("cannot establish complete App Store version history")
        visited.add(url)
        payload = asc_get(url, token)
        if not isinstance(payload.get("data"), list):
            die("App Store version history is unavailable")
        records.extend(payload["data"])
        url = (payload.get("links") or {}).get("next")
    return records


def advance_editable_version(token: str, app_id: str, target: str, platform: str, release_type: str, *,
                             asc_get, asc_patch, die, log, api_root: str, editable_states: set[str]) -> dict | None:
    """Advance the sole current draft; never create a second unreleased version."""
    records = app_store_versions(token, app_id, platform, asc_get=asc_get, die=die, api_root=api_root)
    if not records:
        return None
    ordered = [(historical_parts((item.get("attributes") or {}).get("versionString"), die), item)
               for item in records]
    latest = max(version for version, _ in ordered)
    candidates = [item for version, item in ordered if version == latest]
    if len(candidates) != 1 or parts(target, die) <= latest:
        die("App Store draft advancement requires one latest version and a strictly newer target")
    current = candidates[0]
    attrs = current.get("attributes") or {}
    state = attrs.get("appStoreState") or attrs.get("appVersionState")
    editable = [item for _, item in ordered if ((item.get("attributes") or {}).get("appStoreState")
                or (item.get("attributes") or {}).get("appVersionState")) in editable_states]
    if state not in editable_states:
        if not editable and state in {"READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"}:
            return None
        die("App Store current version is not an editable draft; creation blocked")
    if len(editable) != 1 or not isinstance(current.get("id"), str) or not current["id"] or attrs.get("platform") != platform:
        die("App Store editable draft identity is ambiguous")
    url = f"{api_root}/v1/appStoreVersions/{current['id']}"
    fresh = asc_get(url, token).get("data") or {}
    observed = fresh.get("attributes") or {}
    if (fresh.get("id") != current["id"] or any(observed.get(key) != attrs.get(key)
            for key in ("platform", "versionString", "releaseType"))
            or (observed.get("appStoreState") or observed.get("appVersionState")) not in editable_states):
        die("App Store editable draft changed before advancement")
    log(f"Advancing the current editable App Store draft to {target} ({release_type})")
    asc_patch(url, token, {"data": {"type": "appStoreVersions", "id": current["id"],
                                  "attributes": {"versionString": target, "releaseType": release_type}}})
    updated = asc_get(url, token).get("data") or {}
    observed = updated.get("attributes") or {}
    if (updated.get("id") != current["id"] or observed.get("platform") != platform
            or observed.get("versionString") != target or observed.get("releaseType") != release_type
            or (observed.get("appStoreState") or observed.get("appVersionState")) not in editable_states):
        die("App Store draft advancement readback mismatch; preparation blocked")
    return updated


def ensure_app_store_version(token: str, app_id: str, marketing_version: str, platform: str,
                             release_type: str, *, find_exact, asc_get, asc_post, asc_patch,
                             die, log, api_root: str, editable_states: set[str]) -> dict:
    """Ensure the requested editable public version without creating a second draft."""
    existing = find_exact(token, app_id, marketing_version, platform)
    if existing is not None:
        version_id = existing["id"]
        attrs = existing.get("attributes") or {}
        state = attrs.get("appStoreState") or attrs.get("appVersionState")
        current_release = attrs.get("releaseType")
        log(
            f"App Store version {marketing_version} exists (id={version_id}, "
            f"state={state}, releaseType={current_release})"
        )
        if state not in editable_states:
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
                f"{api_root}/v1/appStoreVersions/{version_id}",
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

    advanced = advance_editable_version(
        token, app_id, marketing_version, platform, release_type,
        asc_get=asc_get, asc_patch=asc_patch, die=die, log=log,
        api_root=api_root, editable_states=editable_states,
    )
    if advanced is not None:
        return advanced

    log(
        f"creating App Store version {marketing_version} "
        f"(platform={platform}, releaseType={release_type})"
    )
    created = asc_post(
        f"{api_root}/v1/appStoreVersions",
        token,
        {
            "data": {
                "type": "appStoreVersions",
                "attributes": {
                    "platform": platform,
                    "versionString": marketing_version,
                    "releaseType": release_type,
                },
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
            }
        },
    )
    version = created.get("data")
    if not version:
        die("App Store version creation returned no data")
    log(f"created App Store version id = {version['id']}")
    return version



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
    versions = [item.get("attributes") or {} for item in app_store_versions(
        token, app_id, platform, asc_get=asc_get, die=die, api_root=api_root)]
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
