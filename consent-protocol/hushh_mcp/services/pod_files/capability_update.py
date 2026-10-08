"""Frozen Files additions for the existing owner-approved update operation.

An image-only approval never supplies this plan. This module performs no cloud
mutation and grants no authority: the update lease, checkpoint persistence and
provider readback remain mandatory at execution.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.pod_files.provisioning import coordinates, extend_plan
from hushh_mcp.services.pod_release import is_immutable_image_reference


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _literal_environment(service: dict) -> dict[str, str]:
    containers = service["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise ValueError("Files activation requires the verified single-container pod")
    entries = containers[0].get("env", [])
    names = [item["name"] for item in entries]
    if len(set(names)) != len(names):
        raise ValueError("Pod environment contains duplicate settings")
    return {item["name"]: item["value"] for item in entries if "value" in item}


class FilesCapabilityChanged(ValueError):
    """A proven refusal before this update has attempted any external mutation."""


class FilesCapabilityPlan(BaseModel):
    """Identifiers and hashes only; never provider credentials or file content."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal[1] = 1
    capability: Literal["files"] = "files"
    ownerId: str = Field(min_length=1, max_length=256)
    hushhId: str = Field(min_length=1, max_length=128)
    serviceUid: str = Field(min_length=1, max_length=128)
    serviceGeneration: str = Field(pattern=r"^[1-9][0-9]*$")
    service: str = Field(min_length=1, max_length=128)
    project: str = Field(pattern=r"^[a-z][a-z0-9-]{4,61}[a-z0-9]$")
    region: str = Field(pattern=r"^[a-z]+-[a-z]+[0-9]+$")
    bootstrapAccount: str = Field(min_length=1, max_length=256)
    runtimeAccount: str = Field(min_length=1, max_length=256)
    targetImage: str = Field(min_length=1, max_length=1024)
    bucket: str = Field(min_length=3, max_length=222)
    kmsKey: str = Field(min_length=1, max_length=512)
    storagePrefix: str = Field(min_length=1, max_length=512)
    templateDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    modelProject: str = Field(pattern=r"^[a-z][a-z0-9-]{4,61}[a-z0-9]$")
    devModelProject: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9-]{4,61}[a-z0-9]$")

    @property
    def digest(self) -> str:
        return _digest(self.model_dump())

    @property
    def environment(self) -> dict[str, str]:
        names = coordinates(self.hushhId, self.project, self.region)
        env = {
            "POD_FILES_ENABLED": "true",
            "POD_FILES_TASK_QUEUE": names["queue"],
            "POD_FILES_WORKER_SERVICE_ACCOUNT": names["worker"],
        }
        if self.devModelProject:
            env["POD_FILES_DEV_MODEL_PROJECT"] = self.devModelProject
        return env

    def substrate_plan(self) -> dict:
        # Reuse the canonical resource and IAM renderer. The bucket is an existing
        # prerequisite, never part of the resource-creation steps for this delta.
        plan: dict = {"resources": [{"type": "gcs_bucket", "id": self.bucket}], "iam": []}
        extend_plan(
            plan,
            owner=self.hushhId,
            project=self.project,
            region=self.region,
            runtime=self.runtimeAccount,
            service=self.service,
            bucket=self.bucket,
        )
        plan["filesLibrary"]["prefix"] = self.storagePrefix + "/files/v1"
        if self.devModelProject:
            plan["filesLibrary"]["backgroundProvider"] = "explicit dev Vertex AI bridge"
        plan["filesLibrary"]["modelProject"] = self.modelProject
        plan["iam"].append(
            {
                "member": self.bootstrapAccount,
                "role": "roles/cloudtasks.queueAdmin",
                "on": f"project:{self.project}",
                "note": "Queue management for this approved Files setup; never a runtime grant",
            }
        )
        return plan

    def require_owner(self, row: dict, target_image: str) -> None:
        metadata = row.get("backend_metadata") or {}
        expected = {
            "ownerId": row.get("user_id"),
            "hushhId": row.get("hushh_id"),
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
            or "erasure" in metadata
            or not is_immutable_image_reference(target_image)
            or any(getattr(self, key) != value for key, value in expected.items())
        ):
            raise ValueError("Files capability owner or pod assignment changed")

    def require_observation(self, service: dict) -> None:
        metadata = service.get("metadata") or {}
        if (
            metadata.get("uid") != self.serviceUid
            or str(metadata.get("generation")) != self.serviceGeneration
            or metadata.get("name") != self.service
            or _digest(service["spec"]["template"]) != self.templateDigest
        ):
            raise ValueError("Files capability pod configuration changed")

    def apply_configuration(self, *, existing: dict, desired: dict) -> None:
        """Apply only after the caller durably qualifies every resource/IAM step."""
        self.require_observation(existing)
        container = desired["spec"]["template"]["spec"]["containers"][0]
        container["env"] = [
            item for item in container.get("env", []) if item["name"] not in self.environment
        ]
        container["env"].extend(
            {"name": name, "value": value} for name, value in self.environment.items()
        )

    def require_installed(self, service: dict) -> None:
        if (
            service.get("metadata", {}).get("uid") != self.serviceUid
            or service["spec"]["template"]["spec"].get("serviceAccountName") != self.runtimeAccount
        ):
            raise ValueError("Files installation belongs to another pod identity")
        env = _literal_environment(service)
        expected = {
            **self.environment,
            "HUSSH_ID": self.hushhId,
            "POD_STORAGE_BACKEND": "commit_log",
            "POD_STORAGE_GCS_BUCKET": self.bucket,
            "POD_STORAGE_GCS_PREFIX": self.storagePrefix,
            "HUSSH_POD_KMS_KEY": self.kmsKey,
        }
        if any(env.get(name) != value for name, value in expected.items()):
            raise ValueError("Files installation configuration is not verified")
        model_project = env.get("GENAI_GOOGLE_CLOUD_PROJECT") or env.get("GOOGLE_CLOUD_PROJECT")
        if (
            model_project != self.modelProject
            or env.get("HUSSH_POD_USER_ADC_ENABLED", "").lower() not in {"1", "true"}
            or env.get("HUSHH_GENAI_AUTH_MODE", "vertex_adc") != "vertex_adc"
            or env.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() not in {"1", "true"}
            or (self.devModelProject and env.get("HUSHH_DEPLOY_ENV") != "dev")
            or (not self.devModelProject and model_project != self.project)
        ):
            raise ValueError("Files installation model authority is not verified")


def plan_from_observation(
    row: dict, target_image: str, service: dict, *, dev_model_project: str | None = None
) -> FilesCapabilityPlan:
    """Freeze actual custody/configuration, not a newly rendered pod default."""
    metadata = service.get("metadata") or {}
    spec = service["spec"]["template"]["spec"]
    env = _literal_environment(service)
    if env.get("POD_FILES_ENABLED", "").lower() in {"1", "true"}:
        raise ValueError("Files is already enabled on this pod")
    if any(name.startswith("POD_FILES_") for name in env):
        raise ValueError("Existing Files configuration requires reconciliation")
    if env.get("POD_STORAGE_BACKEND") != "commit_log":
        raise ValueError("Files requires the existing encrypted GCS recovery store")
    prefix = env.get("POD_STORAGE_GCS_PREFIX", "").strip("/")
    from hushh_mcp.services.pod_commit_log import object_key_segments

    object_key_segments(prefix)
    model_project = env.get("GENAI_GOOGLE_CLOUD_PROJECT") or env.get("GOOGLE_CLOUD_PROJECT")
    bridge = model_project != row.get("user_cloud_project")
    if (
        env.get("HUSSH_POD_USER_ADC_ENABLED", "").lower() not in {"1", "true"}
        or env.get("HUSHH_GENAI_AUTH_MODE", "vertex_adc") != "vertex_adc"
        or env.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() not in {"1", "true"}
        or (
            bridge
            and (
                env.get("HUSHH_DEPLOY_ENV") != "dev"
                or not dev_model_project
                or model_project != dev_model_project
            )
        )
    ):
        raise ValueError("Files requires an explicitly approved Vertex ADC model project")
    plan = FilesCapabilityPlan(
        ownerId=row.get("user_id"),
        hushhId=row.get("hushh_id"),
        serviceUid=metadata.get("uid"),
        serviceGeneration=str(metadata.get("generation")),
        service=metadata.get("name"),
        project=row.get("user_cloud_project"),
        region=row.get("user_cloud_region"),
        bootstrapAccount=row.get("user_cloud_bootstrap_sa"),
        runtimeAccount=spec.get("serviceAccountName"),
        targetImage=target_image,
        bucket=env.get("POD_STORAGE_GCS_BUCKET"),
        kmsKey=env.get("HUSSH_POD_KMS_KEY"),
        storagePrefix=prefix,
        templateDigest=_digest(deepcopy(service["spec"]["template"])),
        modelProject=model_project,
        devModelProject=dev_model_project if bridge else None,
    )
    plan.require_owner(row, target_image)
    if env.get("HUSSH_ID") != plan.hushhId or any(
        not account.endswith(f"@{plan.project}.iam.gserviceaccount.com")
        for account in (plan.runtimeAccount, plan.bootstrapAccount)
    ):
        raise ValueError("Files requires this owner's pod and project identities")
    if not plan.kmsKey.startswith(f"projects/{plan.project}/locations/{plan.region}/keyRings/"):
        raise ValueError("Files requires the existing owner-project encryption key")
    receipt = (row.get("backend_metadata") or {}).get("substrateReceipt") or {}
    if (
        receipt.get("applied") is not True
        or receipt.get("tenantRef") != f"{plan.project}/{plan.region}"
        or {"type": "gcs_bucket", "id": plan.bucket} not in receipt.get("plannedResources", [])
        or {"type": "kms_key", "id": plan.kmsKey.rsplit("/", 1)[-1]}
        not in receipt.get("plannedResources", [])
    ):
        raise ValueError("Files requires a reconciled recovery inventory")
    from hushh_mcp.services.byoc_substrate import (
        _bucket_creation_identity,
        _kms_key_creation_identity,
    )

    if not any(
        item.get("type") == "kms_key"
        and item.get("id") == plan.kmsKey.rsplit("/", 1)[-1]
        and _kms_key_creation_identity(item.get("identity"), plan.kmsKey) is not None
        for item in receipt.get("resourceObservations", [])
        if isinstance(item, dict)
    ):
        raise ValueError("Files requires retained encryption-key identity evidence")
    if not any(
        item.get("type") == "gcs_bucket"
        and item.get("id") == plan.bucket
        and _bucket_creation_identity(item.get("identity"), plan.bucket) is not None
        for item in receipt.get("resourceObservations", [])
        if isinstance(item, dict)
    ):
        raise ValueError("Files requires retained bucket identity evidence")
    return plan
