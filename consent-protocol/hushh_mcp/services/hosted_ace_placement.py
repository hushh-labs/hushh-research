# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Fail-closed contract validator for Hussh-Hosted ACE Pooled Personal Sandboxes (#9744)."""

from __future__ import annotations

import hashlib
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.dev_simulation_guard import deploy_lane

_ALLOWED_LANES = frozenset({"dev", "uat"})
_OWNER_CLOUD_COLUMNS = (
    "user_cloud_project",
    "user_cloud_region",
    "user_cloud_bootstrap_sa",
    "user_cloud_authorized_at",
    "user_cloud_tenant_id",
    "user_cloud_subscription_id",
    "user_cloud_resource_group",
)


@dataclass(frozen=True)
class HostedAcePlacement:
    """Verified registry placement for an owner's Pooled Personal Sandbox."""

    environment: str
    owner_id: str
    owner_hash: str
    hushh_id: str
    url: str
    ingress: str
    endpoint_version: int


def _owner_sha256(owner_id: str) -> str:
    return "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _valid_pooled_edge_url(raw: Any, hushh_id: str) -> str | None:
    if not isinstance(raw, str) or not hushh_id:
        return None
    text = raw.strip().rstrip("/")
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError:
        return None
    expected_path = f"/u/{urllib.parse.quote(hushh_id, safe='')}"
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != expected_path
    ):
        return None
    return text


def has_hosted_ace_evidence(row: Any) -> bool:
    """Return True if a registry row carries any ACE pooled-sandbox placement marker."""
    if not isinstance(row, Mapping):
        return False
    meta = row.get("backend_metadata") if isinstance(row.get("backend_metadata"), Mapping) else {}
    return (
        row.get("deployment_target") == "ace"
        or row.get("backend") == "ace"
        or isinstance(meta.get("hostedAceAdmission"), Mapping)
    )


def retained_hosted_ace_placement(row: Any) -> HostedAcePlacement | None:
    """Validate and return the retained ACE pooled-sandbox placement, or None fail-closed."""
    if not isinstance(row, Mapping):
        return None
    lane = deploy_lane()
    if lane not in _ALLOWED_LANES:
        return None
    if row.get("deployment_target") != "ace" or row.get("backend") != "ace":
        return None
    if any(row.get(col) is not None for col in _OWNER_CLOUD_COLUMNS):
        return None

    owner_id = str(row.get("user_id") or "").strip()
    hushh_id = str(row.get("hushh_id") or "").strip()
    meta = row.get("backend_metadata") if isinstance(row.get("backend_metadata"), Mapping) else None
    if not owner_id or not hushh_id or meta is None:
        return None
    if meta.get("tenancy") != "hussh-hosted":
        return None

    url = _valid_pooled_edge_url(meta.get("url"), hushh_id)
    if url is None:
        return None
    a2a_route = str(row.get("a2a_route") or "").strip().rstrip("/")
    if a2a_route and a2a_route != url:
        return None

    admission = meta.get("hostedAceAdmission")
    if not isinstance(admission, Mapping):
        return None
    expected_hash = _owner_sha256(owner_id)
    if (
        admission.get("version") != 1
        or admission.get("environment") != lane
        or admission.get("ownerId") != owner_id
        or admission.get("ownerHash") != expected_hash
        or admission.get("hushhId") != hushh_id
        or str(admission.get("url") or "").strip().rstrip("/") != url
    ):
        return None

    raw_ver = meta.get("endpointVersion")
    endpoint_version = raw_ver if isinstance(raw_ver, int) and raw_ver >= 1 else 1
    ingress = str(meta.get("ingress") or "direct").strip() or "direct"
    return HostedAcePlacement(
        environment=lane,
        owner_id=owner_id,
        owner_hash=expected_hash,
        hushh_id=hushh_id,
        url=url,
        ingress=ingress,
        endpoint_version=endpoint_version,
    )


def direct_ace_admission_snapshot(row: Any) -> dict[str, Any] | None:
    """Return direct-ingress admission metadata when this row is a valid ACE placement."""
    placement = retained_hosted_ace_placement(row)
    if placement is None:
        return None
    return {
        "deploymentTarget": "ace",
        "environment": placement.environment,
        "ownerId": placement.owner_id,
        "ownerHash": placement.owner_hash,
        "hushhId": placement.hushh_id,
        "url": placement.url,
        "ingress": placement.ingress,
        "endpointVersion": placement.endpoint_version,
    }


__all__ = [
    "HostedAcePlacement",
    "direct_ace_admission_snapshot",
    "has_hosted_ace_evidence",
    "retained_hosted_ace_placement",
]
