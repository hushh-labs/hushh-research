# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Retained Hussh-Hosted Azure Umbrella Cell placement classification.

Follows the exact fail-closed verification pattern of ``hosted_gcp_placement.py``
for ``deployment_target = "azure"`` rows hosted inside HushOne Inc. Umbrella Compute
Cells. This inspects a trusted registry row snapshot; it never infers permissions
from resource names alone and never allows owner-cloud columns on a hosted row.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.compute_backend import BACKEND_AZURE

_GUID_RE = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
_SHA256_PREF_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_SAFE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$")


@dataclass(frozen=True)
class HostedAzurePlacement:
    owner_id: str
    hushh_id: str
    tenant_id: str
    subscription_id: str
    resource_group: str
    location: str
    cell_id: str
    slot_id: str
    app_name: str
    service_uid: str
    url: str
    identity_id: str
    identity_client_id: str
    registry_server: str
    image_digest: str


def _owner_hash(owner_id: str) -> str:
    return "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def has_hosted_azure_evidence(row: Any) -> bool:
    """True when a row or its metadata claims Hussh-Hosted Azure placement."""
    if not isinstance(row, Mapping):
        return False
    if str(row.get("deployment_target") or "").strip() == BACKEND_AZURE:
        return True
    if str(row.get("backend") or "").strip() == BACKEND_AZURE:
        return True
    metadata = row.get("backend_metadata")
    if isinstance(metadata, Mapping) and isinstance(metadata.get("hostedAzureAdmission"), Mapping):
        return True
    return False


def retained_hosted_azure_placement(row: Any) -> HostedAzurePlacement | None:
    """Return validated placement when retained hosted Azure evidence holds."""
    if not isinstance(row, Mapping):
        return None
    try:
        if (
            row.get("deployment_target") != BACKEND_AZURE
            or row.get("backend") != BACKEND_AZURE
            or row.get("status") not in {"provisioning", "connecting", "provisioned", "migrating"}
            or row.get("model_credential_mode") not in {None, "byok_per_turn", "user_azure_mi"}
        ):
            return None
        if any(value for key, value in row.items() if str(key).startswith("user_cloud_")):
            return None

        metadata = row.get("backend_metadata")
        if not isinstance(metadata, Mapping):
            return None
        if metadata.get("tenancy") != "hussh-hosted" or "erasure" in metadata:
            return None

        admission = metadata.get("hostedAzureAdmission")
        if not isinstance(admission, Mapping):
            return None

        owner_id = str(row.get("user_id") or "").strip()
        hushh_id = str(row.get("hushh_id") or "").strip()
        tenant_id = str(admission.get("tenantId") or "").strip().lower()
        subscription_id = str(admission.get("subscriptionId") or "").strip().lower()
        resource_group = str(admission.get("resourceGroup") or "").strip()
        location = str(admission.get("location") or "").strip().lower()
        cell_id = str(admission.get("cellId") or "").strip()
        slot_id = str(admission.get("slotId") or "").strip()
        app_name = str(admission.get("appName") or "").strip()
        service_uid = str(admission.get("serviceUid") or "").strip()
        url = str(admission.get("url") or "").strip().rstrip("/")
        identity_id = str(admission.get("identityId") or "").strip()
        identity_client_id = str(admission.get("identityClientId") or "").strip().lower()
        registry_server = str(admission.get("registryServer") or "").strip()
        image_digest = str(admission.get("imageDigest") or "").strip()

        valid = (
            owner_id
            and hushh_id
            and admission.get("version") == 1
            and admission.get("environment") == "dev"
            and admission.get("ownerId") == owner_id
            and admission.get("ownerHash") == _owner_hash(owner_id)
            and admission.get("hushhId") == hushh_id
            and _GUID_RE.fullmatch(tenant_id)
            and _GUID_RE.fullmatch(subscription_id)
            and _GUID_RE.fullmatch(identity_client_id)
            and bool(resource_group)
            and _SAFE_SLUG_RE.fullmatch(cell_id)
            and bool(slot_id)
            and _SAFE_SLUG_RE.fullmatch(app_name)
            and 1 <= len(service_uid) <= 128
            and url.startswith("https://")
            and url == str(metadata.get("url") or "").strip().rstrip("/")
            and str(metadata.get("service") or "").strip() == app_name
            and str(metadata.get("serviceUid") or "").strip() == service_uid
            and bool(identity_id)
            and bool(registry_server)
            and bool(_SHA256_PREF_RE.fullmatch(image_digest))
            and str(metadata.get("image_digest") or "").strip() == image_digest
        )
        if not valid:
            return None
        return HostedAzurePlacement(
            owner_id=owner_id,
            hushh_id=hushh_id,
            tenant_id=tenant_id,
            subscription_id=subscription_id,
            resource_group=resource_group,
            location=location,
            cell_id=cell_id,
            slot_id=slot_id,
            app_name=app_name,
            service_uid=service_uid,
            url=url,
            identity_id=identity_id,
            identity_client_id=identity_client_id,
            registry_server=registry_server,
            image_digest=image_digest,
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def direct_azure_admission_snapshot(row: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Freeze the exact retained hosted Azure authority checked before ingress promotion."""
    if row is None or retained_hosted_azure_placement(row) is None:
        return None
    return {
        key: value
        for key, value in row.items()
        if str(key).startswith("user_cloud_")
        or key
        in {
            "user_id",
            "hushh_id",
            "backend",
            "deployment_target",
            "status",
            "pod_key_id",
            "pod_pubkey",
            "backend_metadata",
            "model_credential_mode",
        }
    }


__all__ = [
    "HostedAzurePlacement",
    "direct_azure_admission_snapshot",
    "has_hosted_azure_evidence",
    "retained_hosted_azure_placement",
]
