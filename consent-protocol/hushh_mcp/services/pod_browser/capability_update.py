"""Exact GCP Browser configuration delta under the existing update operation.

No resource creation or owner migration. Image-only updates do not construct
this plan; the owner separately approves its digest, destinations and processing.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.pod_release import image_digest, is_immutable_image_reference

from .deployment import BrowserOwnerPolicy
from .execution_authority import PublicResearchPolicy

if TYPE_CHECKING:
    from hushh_mcp.services.compute_backend import PodSpec


def commitment(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def literal_environment(service: dict) -> dict[str, str]:
    containers = service["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise ValueError("Browser requires the verified single-container pod")
    entries = containers[0].get("env", [])
    if len({item["name"] for item in entries}) != len(entries):
        raise ValueError("Pod environment has duplicate settings")
    return {item["name"]: item["value"] for item in entries if "value" in item}


class GcpBrowserCapabilityPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    version: Literal[1] = 1
    capability: Literal["browser"] = "browser"
    hostKind: Literal["gcp_cloud_run"] = "gcp_cloud_run"
    ownerId: str = Field(min_length=1, max_length=256)
    hushhId: str = Field(min_length=1, max_length=128)
    podKeyId: str = Field(min_length=1, max_length=128)
    placementEpoch: int = Field(ge=0)
    serviceUid: str = Field(min_length=1, max_length=128)
    serviceGeneration: str = Field(pattern=r"^[1-9][0-9]*$")
    service: str = Field(min_length=1, max_length=128)
    project: str = Field(pattern=r"^[a-z][a-z0-9-]{4,61}[a-z0-9]$")
    region: str = Field(pattern=r"^[a-z]+-[a-z]+[0-9]+$")
    bootstrapAccount: str = Field(min_length=1, max_length=256)
    runtimeAccount: str = Field(min_length=1, max_length=256)
    targetImage: str = Field(min_length=1, max_length=1024)
    templateDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    qualificationDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    publicPolicy: PublicResearchPolicy = Field(repr=False)
    resourceLimits: dict[str, str]

    @property
    def digest(self) -> str:
        return commitment(self.model_dump(mode="json"))

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
            "HUSSH_BROWSER_POLICY_JSON": policy.model_dump_json(),
        }

    def require_owner(self, row: dict, target_image: str) -> None:
        metadata = row.get("backend_metadata") or {}
        expected = {
            "ownerId": row.get("user_id"),
            "hushhId": row.get("hushh_id"),
            "podKeyId": row.get("pod_key_id"),
            "placementEpoch": row.get("placement_epoch"),
            "serviceUid": metadata.get("serviceUid"),
            "service": row.get("external_agent_id"),
            "project": row.get("user_cloud_project"),
            "region": row.get("user_cloud_region"),
            "bootstrapAccount": row.get("user_cloud_bootstrap_sa"),
            "runtimeAccount": metadata.get("runtime_service_account"),
            "targetImage": target_image,
        }
        if (
            row.get("deployment_target") != "user_gcp"
            or row.get("status") != "provisioned"
            or not row.get("user_cloud_authorized_at")
            or not row.get("pod_pubkey")
            or "erasure" in metadata
            or not is_immutable_image_reference(target_image)
            or any(getattr(self, key) != value for key, value in expected.items())
        ):
            raise ValueError("Browser owner or pod configuration changed")

    def require_observation(self, service: dict) -> None:
        metadata = service.get("metadata") or {}
        if (
            metadata.get("uid") != self.serviceUid
            or metadata.get("name") != self.service
            or str(metadata.get("generation")) != self.serviceGeneration
            or commitment(service["spec"]["template"]) != self.templateDigest
        ):
            raise ValueError("Browser pod configuration changed")

    def require_qualification(self, qualification: dict | None) -> None:
        if (
            qualification is None
            or commitment(qualification) != self.qualificationDigest
            or qualification.get("public_policy_sha256") != self.publicPolicy.digest
            or qualification.get("host_kind") != self.hostKind
            or qualification.get("readiness", {}).get("component_digest")
            != image_digest(self.targetImage)
        ):
            raise ValueError("Browser image qualification changed")

    def apply_configuration(
        self, existing: dict, desired: dict, qualification: dict | None
    ) -> None:
        self.require_observation(existing)
        self.require_qualification(qualification)
        container = desired["spec"]["template"]["spec"]["containers"][0]
        container["env"] = [
            entry for entry in container["env"] if entry["name"] not in self.environment
        ]
        container["env"].extend(
            {"name": key, "value": value} for key, value in self.environment.items()
        )

    def require_installed(self, service: dict) -> None:
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        try:
            # Reuse the provider's strict serving observation, not erasure authority.
            GcpRunClient.erasure_fence_target(
                service, name=self.service, expected_uid=self.serviceUid
            )
        except RuntimeError:
            raise ValueError("Browser serving revision is not verified") from None
        spec = service["spec"]["template"]["spec"]
        env = literal_environment(service)
        if (
            service.get("metadata", {}).get("uid") != self.serviceUid
            or spec.get("serviceAccountName") != self.runtimeAccount
            or image_digest(spec["containers"][0].get("image")) != image_digest(self.targetImage)
            or spec["containers"][0].get("resources", {}).get("limits") != self.resourceLimits
            or any(env.get(key) != value for key, value in self.environment.items())
        ):
            raise ValueError("Browser installed configuration is not verified")
        self.require_qualification(json.loads(env.get("HUSSH_BROWSER_QUALIFICATION_JSON", "null")))


def plan_from_observation(
    row: dict, target_image: str, service: dict, qualification: dict
) -> GcpBrowserCapabilityPlan:
    policy = PublicResearchPolicy.model_validate_json(
        json.dumps(qualification.get("public_policy"))
    )
    metadata, spec = service["metadata"], service["spec"]["template"]["spec"]
    plan = GcpBrowserCapabilityPlan(
        ownerId=row["user_id"],
        hushhId=row["hushh_id"],
        podKeyId=row["pod_key_id"],
        placementEpoch=row["placement_epoch"],
        serviceUid=metadata["uid"],
        serviceGeneration=str(metadata["generation"]),
        service=metadata["name"],
        project=row["user_cloud_project"],
        region=row["user_cloud_region"],
        bootstrapAccount=row["user_cloud_bootstrap_sa"],
        runtimeAccount=spec["serviceAccountName"],
        targetImage=target_image,
        templateDigest=commitment(service["spec"]["template"]),
        qualificationDigest=commitment(qualification),
        publicPolicy=policy,
        resourceLimits=deepcopy(spec["containers"][0]["resources"]["limits"]),
    )
    plan.require_owner(row, target_image)
    plan.require_qualification(qualification)
    env = literal_environment(service)
    if env.get("HUSSH_ID") != plan.hushhId:
        raise ValueError("Browser pod identity changed")
    if all(env.get(key) == value for key, value in plan.environment.items()) and (
        env.get("HUSSH_BROWSER_QUALIFICATION_JSON")
        and commitment(json.loads(env["HUSSH_BROWSER_QUALIFICATION_JSON"]))
        == plan.qualificationDigest
    ):
        raise ValueError("Browser is already configured on this pod")
    return plan


def approved_upgrade_browser_plan(
    spec: PodSpec, existing: dict, *, project: str, bootstrap_sa: str
) -> GcpBrowserCapabilityPlan | None:
    if spec.browser_upgrade_plan is None:
        return None
    plan = GcpBrowserCapabilityPlan.model_validate_json(json.dumps(spec.browser_upgrade_plan))
    if (
        not spec.upgrade_operation_id
        or not spec.upgrade_attempt_id
        or spec.files_upgrade_plan is not None
        or plan.hushhId != spec.hushh_id
        or plan.serviceUid != spec.expected_service_uid
        or plan.project != project
        or plan.targetImage != spec.upgrade_target_image
        or plan.bootstrapAccount != bootstrap_sa
    ):
        raise ValueError("Browser configuration requires its exact approved operation")
    plan.require_observation(existing)
    plan.require_qualification(spec.browser_qualification)
    return plan
