"""Exact owner-approved Azure Files additions; no cloud writes or credentials."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.azure_agent_observation import assigned_identity
from hushh_mcp.services.azure_agent_setup import binding_is_valid
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_applier import resolve
from hushh_mcp.services.azure_setup_plan import (
    NONCE_TAG,
    PlanInputs,
    Scopes,
    files_capability_steps,
    resource_names,
)
from hushh_mcp.services.pod_files.capability_update import _digest
from hushh_mcp.services.pod_release import is_immutable_image_reference


def literal_environment(app: dict) -> dict[str, str]:
    containers = app["properties"]["template"]["containers"]
    if len(containers) != 1:
        raise ValueError("Files requires one pod container")
    entries = containers[0].get("env") or []
    if len({entry["name"] for entry in entries}) != len(entries):
        raise ValueError("Pod environment contains duplicate settings")
    return {entry["name"]: entry["value"] for entry in entries if "value" in entry}


class AzureFilesCapabilityPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal[2] = 2
    provider: Literal["user_azure"] = "user_azure"
    capability: Literal["files"] = "files"
    ownerId: str = Field(min_length=1, max_length=256)
    hushhId: str = Field(min_length=1, max_length=128)
    serviceUid: str = Field(min_length=1, max_length=128)
    service: str = Field(min_length=1, max_length=1024)
    tenantId: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    subscriptionId: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    resourceGroup: str = Field(min_length=1, max_length=90)
    location: str = Field(pattern=r"^[a-z0-9]+$")
    setupNonce: str = Field(min_length=1, max_length=128)
    createdAt: str = Field(min_length=1, max_length=128)
    readyRevision: str = Field(min_length=1, max_length=128)
    templateDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    targetImage: str = Field(min_length=1, max_length=1024)
    identityId: str = Field(min_length=1, max_length=1024)
    principalId: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    clientId: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    storageId: str = Field(min_length=1, max_length=1024)
    blobUrl: str = Field(min_length=1, max_length=1024)
    keyUri: str = Field(min_length=1, max_length=1024)
    modelEndpoint: str = Field(min_length=1, max_length=1024)
    modelDeployment: str = Field(min_length=1, max_length=128)

    @property
    def digest(self) -> str:
        return _digest(self.model_dump())

    @property
    def inputs(self) -> PlanInputs:
        return PlanInputs(
            hushh_id=self.hushhId,
            tenant_id=self.tenantId,
            subscription_id=self.subscriptionId,
            resource_group=self.resourceGroup,
            location=self.location,
            nonce=self.setupNonce,
            files_enabled=True,
        )

    @property
    def scopes(self) -> Scopes:
        return Scopes(self.inputs, resource_names(self.inputs))

    def operations(self) -> list[dict]:
        return [
            {
                "step": name,
                "path": step.path,
                "api": step.api,
                "kind": step.kind,
                "body": resolve(step.body, {"podPrincipalId": self.principalId}),
            }
            for name, step in files_capability_steps(self.inputs)
        ]

    @property
    def environment(self) -> dict[str, str]:
        account = self.storageId.rsplit("/", 1)[-1]
        return {
            "POD_FILES_ENABLED": "true",
            "POD_FILES_AZURE_STORAGE_RESOURCE_ID": self.storageId,
            "POD_FILES_AZURE_QUEUE_URL": f"https://{account}.queue.core.windows.net/files-organization",
        }

    def require_owner(self, row: dict, target_image: str) -> None:
        meta = row.get("backend_metadata") or {}
        expected = {
            "ownerId": row.get("user_id"),
            "hushhId": row.get("hushh_id"),
            "serviceUid": meta.get("serviceUid"),
            "service": row.get("external_agent_id"),
            "tenantId": row.get("user_cloud_tenant_id"),
            "subscriptionId": row.get("user_cloud_subscription_id"),
            "resourceGroup": row.get("user_cloud_resource_group"),
            "location": row.get("user_cloud_region"),
            "targetImage": target_image,
            "principalId": meta.get("runtime_principal_id"),
            "clientId": meta.get("runtime_client_id"),
        }
        if (
            row.get("deployment_target") != self.provider
            or row.get("status") != "provisioned"
            or not row.get("user_cloud_authorized_at")
            or "erasure" in meta
            or not is_immutable_image_reference(target_image)
            or any(getattr(self, name) != value for name, value in expected.items())
        ):
            raise ValueError("Files capability owner or pod assignment changed")
        scopes, names = self.scopes, resource_names(self.inputs)
        if (
            self.service.lower() != scopes.app.lower()
            or self.identityId.lower() != scopes.identity.lower()
            or self.storageId.lower() != scopes.storage.lower()
            or self.blobUrl != f"https://{names.storage_account}.blob.core.windows.net/pod"
            or not self.keyUri.startswith(
                f"https://{names.key_vault}.vault.azure.net/keys/{names.key}/"
            )
            or self.modelEndpoint.rstrip("/") != f"https://{names.openai_account}.openai.azure.com"
            or self.modelDeployment != names.model_deployment
        ):
            raise ValueError("Files requires the existing owner's custody and model binding")

    def require_observation(self, app: dict) -> None:
        props, tags = app.get("properties") or {}, app.get("tags") or {}
        if (
            str(app.get("id", "")).lower() != self.service.lower()
            or not binding_is_valid(tags, self.hushhId)
            or tags.get(INCARNATION_TAG) != self.serviceUid
            or tags.get(NONCE_TAG) != self.setupNonce
            or (app.get("systemData") or {}).get("createdAt") != self.createdAt
            or props.get("latestReadyRevisionName") != self.readyRevision
            or props.get("latestRevisionName") != self.readyRevision
            or _digest(props.get("template")) != self.templateDigest
            or assigned_identity(app, self.identityId) != (self.principalId, self.clientId)
        ):
            raise ValueError("Files capability pod configuration changed")

    def apply_configuration(self, *, existing: dict, desired: dict) -> None:
        self.require_observation(existing)
        template = desired["properties"]["template"]
        env = template["containers"][0].setdefault("env", [])
        if any(entry["name"].startswith("POD_FILES_") for entry in env):
            raise ValueError("Existing Files configuration requires reconciliation")
        env.extend({"name": name, "value": value} for name, value in self.environment.items())
        rules = template["scale"].setdefault("rules", [])
        if any(rule.get("name") == "files" for rule in rules):
            raise ValueError("Existing Files scaler requires reconciliation")
        # Preserve explicit owner HTTP/other rules; make the platform default HTTP
        # rule explicit when adding the first custom scaler.
        if not rules:
            rules.append({"name": "http", "http": {"metadata": {"concurrentRequests": "8"}}})
        rules.append(
            {
                "name": "files",
                "custom": {
                    "type": "azure-queue",
                    "identity": self.identityId,
                    "metadata": {
                        "accountName": self.storageId.rsplit("/", 1)[-1],
                        "queueName": "files-organization",
                        "queueLength": "1",
                        "activationQueueLength": "0",
                        "queueLengthStrategy": "all",
                    },
                },
            }
        )

    def require_installed(self, app: dict) -> None:
        from .azure_provisioning import require_installation

        require_installation(app, storage_id=self.storageId, identity_id=self.identityId)
        env = literal_environment(app)
        if (
            (app.get("tags") or {}).get(INCARNATION_TAG) != self.serviceUid
            or (app.get("systemData") or {}).get("createdAt") != self.createdAt
            or assigned_identity(app, self.identityId) != (self.principalId, self.clientId)
            or any(
                env.get(key) != value
                for key, value in {
                    "HUSSH_ID": self.hushhId,
                    "POD_STORAGE_BACKEND": "commit_log",
                    "POD_STORAGE_AZURE_BLOB_URL": self.blobUrl,
                    "HUSSH_POD_KEY_VAULT_KEY": self.keyUri,
                    "AZURE_OPENAI_ENDPOINT": self.modelEndpoint,
                    "AZURE_OPENAI_DEPLOYMENT": self.modelDeployment,
                }.items()
            )
        ):
            raise ValueError("Files installed custody or model binding changed")


def plan_from_observation(row: dict, target_image: str, app: dict) -> AzureFilesCapabilityPlan:
    props, tags = app.get("properties") or {}, app.get("tags") or {}
    env = literal_environment(app)
    if any(key.startswith("POD_FILES_") for key in env):
        raise ValueError("Existing Files configuration requires reconciliation")
    identity = f"/subscriptions/{row['user_cloud_subscription_id']}/resourceGroups/{row['user_cloud_resource_group']}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-hussh-one-pod"
    principal, client = assigned_identity(app, identity)
    inputs = PlanInputs(
        hushh_id=row["hushh_id"],
        tenant_id=row["user_cloud_tenant_id"],
        subscription_id=row["user_cloud_subscription_id"],
        resource_group=row["user_cloud_resource_group"],
        location=row["user_cloud_region"],
        nonce=tags.get(NONCE_TAG, ""),
    )
    scopes = Scopes(inputs, resource_names(inputs))
    plan = AzureFilesCapabilityPlan(
        ownerId=row["user_id"],
        hushhId=row["hushh_id"],
        serviceUid=tags.get(INCARNATION_TAG),
        service=scopes.app,
        tenantId=inputs.tenant_id,
        subscriptionId=inputs.subscription_id,
        resourceGroup=inputs.resource_group,
        location=inputs.location,
        setupNonce=inputs.nonce,
        createdAt=(app.get("systemData") or {}).get("createdAt"),
        readyRevision=props.get("latestReadyRevisionName"),
        templateDigest=_digest(props.get("template")),
        targetImage=target_image,
        identityId=scopes.identity,
        principalId=principal,
        clientId=client,
        storageId=scopes.storage,
        blobUrl=env.get("POD_STORAGE_AZURE_BLOB_URL"),
        keyUri=env.get("HUSSH_POD_KEY_VAULT_KEY"),
        modelEndpoint=env.get("AZURE_OPENAI_ENDPOINT"),
        modelDeployment=env.get("AZURE_OPENAI_DEPLOYMENT"),
    )
    plan.require_owner(row, target_image)
    plan.require_observation(app)
    if (
        env.get("HUSSH_ID") != plan.hushhId
        or env.get("POD_STORAGE_BACKEND") != "commit_log"
        or env.get("AZURE_CLIENT_ID") != plan.clientId
        or (props.get("configuration") or {}).get("activeRevisionsMode") != "Single"
        or (props.get("template") or {}).get("scale", {}).get("maxReplicas") != 1
    ):
        raise ValueError("Files requires the owner's encrypted single-writer pod")
    return plan
