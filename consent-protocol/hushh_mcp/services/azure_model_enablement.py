"""Exact admin-approved model repair for an existing owner's Azure pod.

This is a maintenance contract, not an image/Files approval or a client API.
Only public topology and opaque resource bindings belong in its durable plan.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.azure_agent_observation import assigned_identity
from hushh_mcp.services.azure_agent_setup import binding_is_valid
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_plan import (
    NONCE_TAG,
    ModelChoice,
    PlanInputs,
    Scopes,
    resource_names,
)
from hushh_mcp.services.azure_setup_roles import (
    ROLE_COGNITIVE_SERVICES_OPENAI_USER,
    role_assignment_body,
    role_assignment_path,
)
from hushh_mcp.services.azure_upgrade_configuration import replacement_body
from hushh_mcp.services.pod_release import is_immutable_image_reference


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def owner_binding_digest(row: dict) -> str:
    from hushh_mcp.services.personal_agent_registry_repo import upgrade_host_snapshot

    snapshot = upgrade_host_snapshot(row) or {}
    return digest(
        {
            key: value
            for key, value in snapshot.items()
            if key not in {"updated_at", "backend_metadata", "host_metadata"}
        }
    )


def writable_configuration(app: dict) -> dict:
    """Exclude provider status; preserve every writable identity/custody field."""
    properties = app.get("properties") or {}
    return copy.deepcopy(
        {
            **{key: app[key] for key in ("location", "tags", "identity") if key in app},
            "properties": {
                key: properties[key]
                for key in ("environmentId", "workloadProfileName", "configuration", "template")
                if key in properties
            },
        }
    )


class AzureModelEnablementPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal[1] = 1
    owner_id: str = Field(min_length=1, max_length=256)
    hushh_id: str = Field(min_length=1, max_length=128)
    tenant_id: str = Field(pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
    subscription_id: str = Field(pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
    resource_group: str = Field(min_length=1, max_length=90)
    region: str = Field(pattern=r"^[a-z0-9]+$")
    service_id: str = Field(min_length=1, max_length=1024)
    service_uid: str = Field(min_length=1, max_length=128)
    created_at: str = Field(min_length=1, max_length=128)
    nonce: str = Field(min_length=1, max_length=128)
    revision: str = Field(min_length=1, max_length=128)
    principal_id: str = Field(pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
    client_id: str = Field(pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
    image: str = Field(min_length=1, max_length=1024)
    configuration_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    owner_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    model_name: str = Field(pattern=r"^[a-zA-Z0-9.-]+$", max_length=100)
    model_version: str = Field(pattern=r"^[a-zA-Z0-9.-]+$", max_length=100)
    sku: Literal["GlobalStandard"] = "GlobalStandard"
    capacity: int = Field(strict=True, ge=1, le=250)

    @property
    def plan_digest(self) -> str:
        return digest(self.model_dump())

    @property
    def scopes(self) -> Scopes:
        inputs = PlanInputs(
            hushh_id=self.hushh_id,
            tenant_id=self.tenant_id,
            subscription_id=self.subscription_id,
            resource_group=self.resource_group,
            location=self.region,
            nonce=self.nonce,
        )
        return Scopes(inputs, resource_names(inputs))

    @property
    def environment(self) -> dict[str, str]:
        return {
            "AZURE_OPENAI_ENDPOINT": f"https://{self.scopes.openai.rsplit('/', 1)[-1]}.openai.azure.com/",
            "AZURE_OPENAI_DEPLOYMENT": self.scopes.deployment.rsplit("/", 1)[-1],
        }

    @property
    def model_body(self) -> dict:
        return {
            "sku": {"name": self.sku, "capacity": self.capacity},
            "properties": {
                "model": {
                    "format": "OpenAI",
                    "name": self.model_name,
                    "version": self.model_version,
                }
            },
        }

    @property
    def role(self) -> tuple[str, dict]:
        role_id = ROLE_COGNITIVE_SERVICES_OPENAI_USER
        definition = f"/subscriptions/{self.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/{role_id}"
        return (
            role_assignment_path(self.scopes.openai, role_id, self.principal_id),
            role_assignment_body(definition, self.principal_id),
        )

    def require_owner(self, row: dict, *, completed: bool = False) -> None:
        metadata = row.get("backend_metadata") or {}
        expected = {
            "user_id": self.owner_id,
            "hushh_id": self.hushh_id,
            "status": "provisioned",
            "deployment_target": "user_azure",
            "external_agent_id": self.service_id,
            "user_cloud_tenant_id": self.tenant_id,
            "user_cloud_subscription_id": self.subscription_id,
            "user_cloud_resource_group": self.resource_group,
            "user_cloud_region": self.region,
            "model_credential_mode": "user_azure_mi" if completed else "byok_per_turn",
        }
        if (
            any(row.get(key) != value for key, value in expected.items())
            or not row.get("user_cloud_authorized_at")
            or "erasure" in metadata
            or metadata.get("serviceUid") != self.service_uid
            or metadata.get("runtime_principal_id") != self.principal_id
            or metadata.get("runtime_client_id") != self.client_id
            or self.service_id.lower() != self.scopes.app.lower()
            or not is_immutable_image_reference(self.image)
            or owner_binding_digest({**row, "model_credential_mode": "byok_per_turn"})
            != self.owner_digest
        ):
            raise ValueError("Azure model repair owner or placement changed")

    def require_app(self, app: dict, *, expected_digest: str | None = None) -> None:
        properties, tags = app.get("properties") or {}, app.get("tags") or {}
        containers = (properties.get("template") or {}).get("containers") or []
        if (
            len(containers) != 1
            or containers[0].get("image") != self.image
            or str(app.get("id", "")).lower() != self.service_id.lower()
            or not binding_is_valid(tags, self.hushh_id)
            or tags.get(INCARNATION_TAG) != self.service_uid
            or tags.get(NONCE_TAG) != self.nonce
            or (app.get("systemData") or {}).get("createdAt") != self.created_at
            or assigned_identity(app, self.scopes.identity) != (self.principal_id, self.client_id)
            or digest(writable_configuration(app)) != (expected_digest or self.configuration_digest)
        ):
            raise ValueError("Azure model repair configuration or custody changed")

    def replacement(self, app: dict, suffix: str) -> dict:
        self.require_app(app)
        expected = writable_configuration(app)
        template = expected["properties"]["template"]
        template["revisionSuffix"] = suffix
        entries = template["containers"][0].setdefault("env", [])
        names = [entry["name"] for entry in entries]
        if len(set(names)) != len(names) or any(name in names for name in self.environment):
            raise ValueError("Existing Azure model configuration requires reconciliation")
        entries.extend({"name": key, "value": value} for key, value in self.environment.items())
        desired = replacement_body(app, image=self.image, suffix=suffix)
        desired["properties"]["template"]["containers"][0]["env"] = entries
        if desired != expected:
            raise ValueError("Azure model repair must preserve all other configuration")
        return cast(dict, desired)


def plan_from_observation(row: dict, app: dict, choice: ModelChoice) -> AzureModelEnablementPlan:
    metadata = row.get("backend_metadata") or {}
    properties, tags = app.get("properties") or {}, app.get("tags") or {}
    containers = (properties.get("template") or {}).get("containers") or []
    if len(containers) != 1 or properties.get("latestRevisionName") != properties.get(
        "latestReadyRevisionName"
    ):
        raise ValueError("Azure model repair needs one settled existing pod")
    plan = AzureModelEnablementPlan(
        owner_id=row["user_id"],
        hushh_id=row["hushh_id"],
        tenant_id=row["user_cloud_tenant_id"],
        subscription_id=row["user_cloud_subscription_id"],
        resource_group=row["user_cloud_resource_group"],
        region=row["user_cloud_region"],
        service_id=row["external_agent_id"],
        service_uid=metadata["serviceUid"],
        created_at=(app.get("systemData") or {})["createdAt"],
        nonce=tags[NONCE_TAG],
        revision=properties["latestReadyRevisionName"],
        principal_id=metadata["runtime_principal_id"],
        client_id=metadata["runtime_client_id"],
        image=containers[0]["image"],
        configuration_digest=digest(writable_configuration(app)),
        owner_digest=owner_binding_digest(row),
        model_name=choice.name,
        model_version=choice.version,
        sku=choice.sku,
        capacity=choice.capacity,
    )
    plan.require_owner(row)
    plan.require_app(app)
    return plan


def verified_completion(row: dict, metadata: dict, lease: str) -> bool:
    """Only the exact ready maintenance receipt may publish the paired mode."""
    record = metadata.get("modelEnablement")
    if not isinstance(record, dict) or record.get("status") != "verified":
        return False
    if not isinstance(record.get("drainReceipt"), dict) or not isinstance(
        record.get("runtimeProof"), dict
    ):
        return False
    previous = (row.get("backend_metadata") or {}).get("modelEnablement")
    if (
        not isinstance(previous, dict)
        or previous.get("status") != "pending"
        or record != {**previous, "status": "verified"}
    ):
        return False
    try:
        plan = AzureModelEnablementPlan.model_validate(record["plan"])
        plan.require_owner(row)
        return (
            record.get("planDigest") == plan.plan_digest
            and record.get("attemptId") == hashlib.sha256(lease.encode()).hexdigest()
            and record.get("verified") == ["model", "role", "replacement"]
            and record["runtimeProof"].get("reachable") is True
            and type(record["drainReceipt"].get("activeWork")) is int
            and record.get("intents")
            == [
                step
                for step in ("model", "role", "replacement")
                if step in record.get("intents", [])
            ]
            and "replacement" in record.get("intents", [])
            and {
                key: record.get("drainReceipt", {}).get(key)
                for key in ("operationId", "incarnation", "activeWork")
            }
            == {
                "operationId": "model_" + record["attemptId"],
                "incarnation": plan.revision,
                "activeWork": 0,
            }
            and isinstance(record.get("drainReceipt", {}).get("runtimeEpoch"), str)
            and bool(record["drainReceipt"]["runtimeEpoch"])
            and isinstance(record.get("drainReceipt", {}).get("committedState"), str)
            and len(record["drainReceipt"]["committedState"]) == 64
            and record.get("runtimeProof")
            == {
                "provider": "azure_openai",
                "model": plan.environment["AZURE_OPENAI_DEPLOYMENT"],
                "endpoint": plan.environment["AZURE_OPENAI_ENDPOINT"].split("/")[2],
                "revision": "ca-hussh-one-pod--u" + record["attemptId"][:12],
                "reachable": True,
            }
            and isinstance(record.get("replacementDigest"), str)
            and len(record["replacementDigest"]) == 64
        )
    except (KeyError, TypeError, ValueError):
        return False


def initial_record(plan: AzureModelEnablementPlan, lease: str) -> dict:
    """Written atomically with the lease; no claim-only recovery gap."""
    return {
        "plan": plan.model_dump(),
        "planDigest": plan.plan_digest,
        "attemptId": hashlib.sha256(lease.encode()).hexdigest(),
        "status": "pending",
        "intents": [],
        "verified": [],
    }


def reservation_metadata(
    observed: dict | None, owner: str, image: str, lease: str, encoded: dict | None
) -> dict:
    if encoded is None:
        return {}
    plan = AzureModelEnablementPlan.model_validate(encoded)
    plan.require_owner(observed or {})
    if plan.owner_id != owner or plan.image != image:
        raise ValueError("Model reservation does not match its owner and image")
    return {"modelEnablement": initial_record(plan, lease)}


def require_mode_publication(
    observed: dict | None,
    metadata: dict,
    lease: str,
    mode: str | None,
    retain: bool,
    unchanged: bool,
) -> bool:
    return mode is None or (
        mode == "user_azure_mi"
        and not retain
        and unchanged
        and verified_completion(observed or {}, metadata, lease)
    )
