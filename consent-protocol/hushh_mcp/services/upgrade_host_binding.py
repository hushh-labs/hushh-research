"""Canonical retained-host binding for one personal-agent upgrade lease."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Optional, cast

_UPGRADE_HOST_METADATA_KEYS = (
    "project",
    "region",
    "service",
    "serviceUid",
    "url",
    "runtime_service_account",
    "tenancy",
    "ingress",
    "substrateReceipt",
    "filesUpgradeCheckpoint",
    "hostKind",
    "vmHost",
    "vmConfigurationSha256",
    "vmUpdateModuleSha256",
    "image",
    "image_digest",
    "runtime_principal_id",
    "runtime_client_id",
    "vmPower",
)

# A retained lease belongs to one exact pod generation and provider resource.
# Release progress such as the running image and Files checkpoint can advance
# during an update, so it is deliberately excluded from this immutable binding.
_UPGRADE_HOST_BINDING_REGISTRY_KEYS = (
    "user_id",
    "hushh_id",
    "backend",
    "external_agent_id",
    "a2a_route",
    "billing_space_id",
    "phone_e164_hash",
    "deployment_target",
    "user_cloud_project",
    "user_cloud_tenant_id",
    "user_cloud_subscription_id",
    "user_cloud_resource_group",
    "user_cloud_region",
    "user_cloud_bootstrap_sa",
    "placement_epoch",
    "pod_pubkey",
    "pod_key_id",
    "pod_signing_key_id",
    "pod_signing_pubkey",
)
_UPGRADE_HOST_BINDING_METADATA_KEYS = (
    "project",
    "region",
    "service",
    "serviceUid",
    "url",
    "runtime_service_account",
    "tenancy",
    "ingress",
    "hostKind",
    "vmHost",
    "vmConfigurationSha256",
    "vmUpdateModuleSha256",
    "runtime_principal_id",
    "runtime_client_id",
)


def upgrade_host_snapshot(
    row: Optional[dict],
    *,
    registry_snapshot: Callable[[Optional[dict]], Optional[dict]],
) -> Optional[dict]:
    snapshot = registry_snapshot(row)
    if row is None or snapshot is None:
        return None
    # Reuse the host authority projection and include the remaining PodSpec inputs.
    snapshot.update(
        {
            key: row.get(key)
            for key in (
                "phone_e164_hash",
                "placement_epoch",
                "pod_pubkey",
                "pod_key_id",
                "pod_signing_key_id",
                "pod_signing_pubkey",
                "liveness_mode",
            )
        }
    )
    metadata = snapshot["backend_metadata"] or {}
    snapshot["host_metadata"] = {key: metadata.get(key) for key in _UPGRADE_HOST_METADATA_KEYS}
    return snapshot


def upgrade_host_binding_json(
    snapshot: dict,
    *,
    dump_json: Callable[..., str],
) -> str:
    """Serialize the pod generation and provider host captured by a lease claim."""
    registry = {key: snapshot.get(key) for key in _UPGRADE_HOST_BINDING_REGISTRY_KEYS}
    authorized_at = snapshot.get("user_cloud_authorized_at")
    if authorized_at is not None:
        if isinstance(authorized_at, str):
            authorized_at = datetime.fromisoformat(authorized_at.replace("Z", "+00:00"))
        if not isinstance(authorized_at, datetime) or authorized_at.tzinfo is None:
            raise ValueError("The retained upgrade host timestamp is unavailable")
        authorized_at = authorized_at.astimezone(timezone.utc).isoformat(timespec="microseconds")
    return dump_json(
        {
            "registry": registry,
            "hostMetadata": {
                key: snapshot["host_metadata"].get(key)
                for key in _UPGRADE_HOST_BINDING_METADATA_KEYS
            },
            "userCloudAuthorizedAt": authorized_at,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def upgrade_lease_host_binding_matches(
    row: dict,
    *,
    snapshot_for_row: Callable[[Optional[dict]], Optional[dict]],
    binding_json: Callable[[dict], str],
    load_json: Callable[[str], Any],
) -> bool:
    """Fail closed when a held lease is legacy, malformed, or on another host."""
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("upgradeLeaseHost"), dict):
        return False
    snapshot = snapshot_for_row(row)
    if snapshot is None:
        return False
    try:
        current = load_json(binding_json(snapshot))
    except (TypeError, ValueError):
        return False
    return cast(bool, metadata["upgradeLeaseHost"] == current)
