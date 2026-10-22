"""Config-only Browser activation on the owner's existing ACA Files delivery.

No new identity, queue, scaler or IAM is created. The existing Files resource
inventory remains its erasure owner; Browser receives no resource authority.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.pod_files.azure_capability import (
    AzureFilesCapabilityPlan,
    literal_environment,
)
from hushh_mcp.services.pod_files.azure_capability import (
    plan_from_observation as installed_files_plan,
)
from hushh_mcp.services.pod_release import browser_qualification_environment, image_digest

from .capability_update import commitment
from .deployment import BrowserOwnerPolicy
from .execution_authority import PublicResearchPolicy


class AzureBrowserCapabilityPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    version: Literal[2] = 2
    capability: Literal["browser"] = "browser"
    hostKind: Literal["azure_container_apps"] = "azure_container_apps"
    ownerId: str = Field(min_length=1, max_length=256)
    hushhId: str = Field(min_length=1, max_length=128)
    podKeyId: str = Field(min_length=1, max_length=128)
    placementEpoch: int = Field(ge=0)
    serviceUid: str = Field(min_length=1, max_length=128)
    targetImage: str = Field(min_length=1, max_length=1024)
    qualificationDigest: str = Field(pattern=r"^[a-f0-9]{64}$")
    publicPolicy: PublicResearchPolicy = Field(repr=False)
    resourceLimits: dict[str, str]
    installation: AzureFilesCapabilityPlan = Field(repr=False)

    @property
    def digest(self) -> str:
        return str(commitment(self.model_dump(mode="json")))

    @property
    def environment(self) -> dict[str, str]:
        policy = BrowserOwnerPolicy(
            version=1,
            pod_id=self.hushhId,
            pod_key_id=self.podKeyId,
            public_policy=self.publicPolicy,
        )
        return {
            "POD_COMPUTER_USE_ENABLED": "true",
            "POD_BROWSER_DELIVERY_MODE": "owner_files_queue_v1",
            "HUSSH_BROWSER_POLICY_JSON": policy.model_dump_json(),
        }

    def require_owner(self, row: dict, target_image: str) -> None:
        self.installation.require_owner(row, target_image)
        metadata = row.get("backend_metadata") or {}
        if (
            self.ownerId != row.get("user_id")
            or self.hushhId != row.get("hushh_id")
            or self.podKeyId != row.get("pod_key_id")
            or self.placementEpoch != row.get("placement_epoch")
            or self.serviceUid != self.installation.serviceUid
            or self.targetImage != self.installation.targetImage
            or "hostKind" in metadata
            or "vmHost" in metadata
        ):
            raise ValueError("Browser owner or pod configuration changed")

    def require_qualification(self, qualification: dict | None) -> None:
        if (
            qualification is None
            or commitment(qualification) != self.qualificationDigest
            or qualification.get("host_kind") != self.hostKind
            or qualification.get("public_policy_sha256") != self.publicPolicy.digest
            or qualification.get("readiness", {}).get("component_digest")
            != image_digest(self.targetImage)
        ):
            raise ValueError("Browser image qualification changed")
        browser_qualification_environment(
            qualification, target_image=self.targetImage, host_kind=self.hostKind
        )

    def require_observation(self, app: dict) -> None:
        self.installation.require_observation(app)
        self.installation.require_installed(app)

    def require_delivery(self, arm) -> None:
        from hushh_mcp.services.azure_arm_client import API_VERSIONS
        from hushh_mcp.services.pod_files.azure_checkpoint import qualify_readback

        for call in self.installation.operations():
            qualify_readback(
                call,
                arm.get(call["path"], api_version=API_VERSIONS[call["api"]], op="browser_delivery"),
            )

    def apply_configuration(
        self, existing: dict, desired: dict, qualification: dict | None
    ) -> None:
        self.require_observation(existing)
        self.require_qualification(qualification)
        environment = {
            **self.environment,
            **browser_qualification_environment(
                qualification, target_image=self.targetImage, host_kind=self.hostKind
            ),
        }
        container = desired["properties"]["template"]["containers"][0]
        container["env"] = [
            item for item in container.get("env", []) if item["name"] not in environment
        ]
        container["env"] += [{"name": name, "value": value} for name, value in environment.items()]

    def require_installed(self, app: dict) -> None:
        self.installation.require_installed(app)
        env = literal_environment(app)
        container = app["properties"]["template"]["containers"][0]
        resources = {name: str(value) for name, value in container["resources"].items()}
        if (
            image_digest(container["image"]) != image_digest(self.targetImage)
            or resources != self.resourceLimits
            or any(env.get(name) != value for name, value in self.environment.items())
        ):
            raise ValueError("Browser installed configuration changed")
        self.require_qualification(json.loads(env.get("HUSSH_BROWSER_QUALIFICATION_JSON", "null")))


def plan_from_observation(row: dict, target_image: str, app: dict, qualification: dict):
    installation = installed_files_plan(row, target_image, app, installed=True)
    container = app["properties"]["template"]["containers"][0]
    plan = AzureBrowserCapabilityPlan(
        ownerId=row["user_id"],
        hushhId=row["hushh_id"],
        podKeyId=row["pod_key_id"],
        placementEpoch=row["placement_epoch"],
        serviceUid=installation.serviceUid,
        targetImage=target_image,
        qualificationDigest=commitment(qualification),
        publicPolicy=PublicResearchPolicy.model_validate_json(
            json.dumps(qualification.get("public_policy"))
        ),
        resourceLimits={name: str(value) for name, value in container["resources"].items()},
        installation=installation,
    )
    plan.require_owner(row, target_image)
    plan.require_qualification(qualification)
    plan.require_observation(app)
    return plan


def approved_upgrade_plan(spec, existing: dict, arm) -> AzureBrowserCapabilityPlan | None:
    if spec.browser_upgrade_plan is None:
        return None
    plan = AzureBrowserCapabilityPlan.model_validate_json(json.dumps(spec.browser_upgrade_plan))
    if (
        not spec.upgrade_operation_id
        or not spec.upgrade_attempt_id
        or spec.files_upgrade_plan is not None
        or plan.hushhId != spec.hushh_id
        or plan.serviceUid != spec.expected_service_uid
        or plan.targetImage != spec.upgrade_target_image
    ):
        raise ValueError("Browser requires its exact approved operation")
    plan.require_observation(existing)
    plan.require_qualification(spec.browser_qualification)
    plan.require_delivery(arm)
    return plan
