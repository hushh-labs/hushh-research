# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Authoritative multi-cloud pod capability and substrate mapping registry.

Maintains one typed table mapping every deployment target (`gcp`, `ace`,
`user_gcp`, `user_azure`, `user_aws`) onto its compute, key-custody, object-store,
workload-identity, browser-sandbox, and owner-update capabilities without leaking
provider switch statements into Layer 1 orchestration.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from browser_runtime.qualification import (
    BROWSER_HOST_CAPABILITIES,
    RuntimeSandboxCapability,
    default_chromium_sandbox_for_cloud,
    get_host_capability,
)

TenancyKind = Literal["hussh_hosted", "owner_cloud"]
ProviderFamily = Literal["gcp", "azure", "aws", "ace"]
ObjectStoreKind = Literal["gcs", "azure_blob", "s3", "prefix_token"]
WorkloadIdentityKind = Literal["gce_metadata", "azure_msi", "aws_irsa_ecs", "ace_attestation"]


@dataclass(frozen=True)
class ProviderTargetSpec:
    """Complete capability profile for one pod deployment target."""

    target_id: str
    provider_family: ProviderFamily
    tenancy: TenancyKind
    required_coordinates: tuple[str, ...]
    default_host_kind: str
    default_custody_mode: str
    allowed_custody_modes: tuple[str, ...]
    object_store_kind: ObjectStoreKind
    workload_identity_kind: WorkloadIdentityKind
    owner_update_qualified: bool
    registry_sql_admitted: bool

    @property
    def sandbox_capability(self) -> RuntimeSandboxCapability:
        capability = get_host_capability(self.default_host_kind)
        if capability is None:
            raise KeyError(f"unknown default_host_kind {self.default_host_kind!r}")
        return capability


PROVIDER_CAPABILITY_REGISTRY: dict[str, ProviderTargetSpec] = {
    "gcp": ProviderTargetSpec(
        target_id="gcp",
        provider_family="gcp",
        tenancy="hussh_hosted",
        required_coordinates=(),
        default_host_kind="gcp_cloud_run",
        default_custody_mode="fleet_hkdf",
        allowed_custody_modes=("ephemeral", "fleet_hkdf", "owner_kms", "ace_envelope"),
        object_store_kind="gcs",
        workload_identity_kind="gce_metadata",
        owner_update_qualified=False,
        registry_sql_admitted=True,
    ),
    "ace": ProviderTargetSpec(
        target_id="ace",
        provider_family="ace",
        tenancy="hussh_hosted",
        required_coordinates=(),
        default_host_kind="gcp_ace",
        default_custody_mode="ace_envelope",
        allowed_custody_modes=("ephemeral", "ace_envelope"),
        object_store_kind="prefix_token",
        workload_identity_kind="ace_attestation",
        owner_update_qualified=False,
        registry_sql_admitted=False,
    ),
    "user_gcp": ProviderTargetSpec(
        target_id="user_gcp",
        provider_family="gcp",
        tenancy="owner_cloud",
        required_coordinates=("project",),
        default_host_kind="gcp_cloud_run",
        default_custody_mode="owner_kms",
        allowed_custody_modes=("owner_kms", "ace_envelope"),
        object_store_kind="gcs",
        workload_identity_kind="gce_metadata",
        owner_update_qualified=True,
        registry_sql_admitted=True,
    ),
    "user_azure": ProviderTargetSpec(
        target_id="user_azure",
        provider_family="azure",
        tenancy="owner_cloud",
        required_coordinates=("tenant_id", "subscription_id", "resource_group", "region"),
        default_host_kind="azure_container_apps",
        default_custody_mode="owner_vault",
        allowed_custody_modes=("owner_vault", "ace_envelope"),
        object_store_kind="azure_blob",
        workload_identity_kind="azure_msi",
        owner_update_qualified=True,
        registry_sql_admitted=True,
    ),
    "user_aws": ProviderTargetSpec(
        target_id="user_aws",
        provider_family="aws",
        tenancy="owner_cloud",
        required_coordinates=("account_id", "region", "role_arn"),
        default_host_kind="aws_fargate",
        default_custody_mode="owner_kms",
        allowed_custody_modes=("owner_kms", "ace_envelope"),
        object_store_kind="s3",
        workload_identity_kind="aws_irsa_ecs",
        owner_update_qualified=False,
        registry_sql_admitted=False,
    ),
}


def get_provider_target_spec(target: object) -> ProviderTargetSpec | None:
    return PROVIDER_CAPABILITY_REGISTRY.get(str(target or "").strip())


def hosted_cloud_targets() -> tuple[str, ...]:
    return tuple(
        spec.target_id
        for spec in PROVIDER_CAPABILITY_REGISTRY.values()
        if spec.tenancy == "hussh_hosted"
    )


def owner_cloud_targets() -> tuple[str, ...]:
    return tuple(
        spec.target_id
        for spec in PROVIDER_CAPABILITY_REGISTRY.values()
        if spec.tenancy == "owner_cloud"
    )


def owner_cloud_required_coordinates_map() -> dict[str, tuple[str, ...]]:
    return {
        spec.target_id: spec.required_coordinates
        for spec in PROVIDER_CAPABILITY_REGISTRY.values()
        if spec.tenancy == "owner_cloud"
    }


def is_hosted_pod_target(target: object) -> bool:
    spec = get_provider_target_spec(target)
    return spec is not None and spec.tenancy == "hussh_hosted"


def is_owner_update_qualified_target(target: object) -> bool:
    spec = get_provider_target_spec(target)
    return spec is not None and spec.owner_update_qualified


def validate_target_custody_mode(*, target: str, custody_mode: str) -> None:
    spec = get_provider_target_spec(target)
    if spec is None:
        return
    if spec.tenancy == "owner_cloud" and custody_mode == "fleet_hkdf":
        raise ValueError("owner-cloud pods cannot use shared fleet_hkdf key custody")
    if custody_mode not in spec.allowed_custody_modes:
        raise ValueError(f"{spec.target_id} pods cannot use {custody_mode} key custody")


def verify_browser_contract_alignment(contracts_cloud_map: Mapping[str, bool]) -> bool:
    """Verify standalone `/opt/browser` contract defaults match `qualification.py`."""
    for cloud, expected in contracts_cloud_map.items():
        if default_chromium_sandbox_for_cloud(cloud) is not expected:
            return False
    return True


__all__ = [
    "BROWSER_HOST_CAPABILITIES",
    "PROVIDER_CAPABILITY_REGISTRY",
    "ObjectStoreKind",
    "ProviderFamily",
    "ProviderTargetSpec",
    "RuntimeSandboxCapability",
    "TenancyKind",
    "WorkloadIdentityKind",
    "get_host_capability",
    "get_provider_target_spec",
    "hosted_cloud_targets",
    "is_hosted_pod_target",
    "is_owner_update_qualified_target",
    "owner_cloud_required_coordinates_map",
    "owner_cloud_targets",
    "validate_target_custody_mode",
    "verify_browser_contract_alignment",
]
