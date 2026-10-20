"""Retained Azure host identity, never inferred from a resource name or fleet flag."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from hushh_mcp.services.azure_vm_power import AzureVmPowerTarget
from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation
from hushh_mcp.services.pod_gmail_push_config import canonical_pod_origin
from hushh_mcp.services.pod_release import image_digest, is_immutable_image_reference

if TYPE_CHECKING:
    from hushh_mcp.services.compute_backend import PodSpec


@dataclass(frozen=True)
class AzureVmHostBinding:
    installation: AzureVmInstallation
    identity_resource_id: str
    principal_id: str
    location: str
    image: str
    url: str

    def __post_init__(self) -> None:
        if (
            str(UUID(self.principal_id)) != self.principal_id
            or not re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io/pod@sha256:[a-f0-9]{64}", self.image)
            or image_digest(self.image) != self.installation.image_digest
            or canonical_pod_origin(self.url) != self.url
        ):
            raise ValueError("Azure VM host configuration is invalid")
        self.target()

    def target(self) -> AzureVmPowerTarget:
        return AzureVmPowerTarget(
            installation=self.installation,
            identity_resource_id=self.identity_resource_id,
            principal_id=self.principal_id,
            location=self.location,
            binding_tags={
                "husshPod": self.installation.hushh_id,
                "husshPodGeneration": self.installation.generation,
                "husshPodImage": self.installation.image_digest,
            },
        )

    def require_spec(self, spec: PodSpec) -> None:
        group = (
            f"/subscriptions/{spec.user_cloud_subscription_id}"
            f"/resourceGroups/{spec.user_cloud_resource_group}/providers/"
        )
        if (
            spec.deployment_target != "user_azure"
            or not self.installation.resource_id.casefold().startswith(group.casefold())
            or spec.hushh_id != self.installation.hushh_id
            or spec.expected_service_uid != self.installation.generation
            or spec.expected_runtime_principal != self.principal_id
            or spec.expected_image_digest != self.installation.image_digest
            or str(spec.user_cloud_region).casefold() != self.location.casefold()
        ):
            raise ValueError("Azure VM host differs from the recorded pod")

    def record(self) -> dict:
        return {
            "installation": self.installation.model_dump(),
            "identityResourceId": self.identity_resource_id,
            "principalId": self.principal_id,
            "location": self.location,
        }


def recorded_vm_host(metadata: dict) -> AzureVmHostBinding | None:
    kind = metadata.get("hostKind")
    if kind is None and "vmHost" not in metadata:
        return None  # Existing Container Apps records retain their current meaning.
    if kind != "azure_vm":
        raise ValueError("Azure host kind is not supported")
    host = metadata.get("vmHost")
    if not isinstance(host, dict) or set(host) != {
        "installation",
        "identityResourceId",
        "principalId",
        "location",
    }:
        raise ValueError("Azure VM host binding is incomplete")
    installation = AzureVmInstallation.model_validate(host["installation"])
    principal, location, identity = (
        host[k] for k in ("principalId", "location", "identityResourceId")
    )
    if any(not isinstance(value, str) or not value for value in (principal, location, identity)):
        raise ValueError("Azure VM host identity is incomplete")
    image, url = metadata.get("image"), metadata.get("url")
    if (
        not isinstance(image, str)
        or not is_immutable_image_reference(image)
        or image_digest(image) != installation.image_digest
        or metadata.get("image_digest") != installation.image_digest
        or metadata.get("serviceUid") != installation.generation
        or metadata.get("runtime_principal_id") != principal
        or metadata.get("runtime_client_id") != installation.client_id
        or not isinstance(url, str)
        or canonical_pod_origin(url) != url
    ):
        raise ValueError("Azure VM host metadata differs from its installation")
    return AzureVmHostBinding(installation, identity, principal, location, image, url)
