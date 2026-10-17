"""Bounded provider-retention observations; active absence is never physical purge.

Use pinned ARM management APIs, not storage keys. Recovery handles, credentials
and provider response bodies never enter the existing erasure receipt.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_setup_plan import (
    BINDING_TAG,
    NONCE_TAG,
    PlanInputs,
    Scopes,
    resource_names,
    tags,
)
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, TeardownResource


def retention_target(resource: TeardownResource, inputs: PlanInputs) -> tuple[str, str, str] | None:
    scopes = Scopes(inputs, resource_names(inputs))
    base = f"/subscriptions/{inputs.subscription_id}/providers/"
    name = resource.path.rsplit("/", 1)[-1]
    if resource.path == scopes.vault:
        return (
            base + f"Microsoft.KeyVault/locations/{inputs.location}/deletedVaults/{name}",
            API_VERSIONS["key_vault"],
            "key_vault",
        )
    if resource.path == scopes.storage:
        return (
            base + f"Microsoft.Storage/locations/{inputs.location}/deletedAccounts/{name}",
            API_VERSIONS["storage"],
            "storage",
        )
    if resource.path == scopes.openai:
        return (
            base
            + f"Microsoft.CognitiveServices/locations/{inputs.location}/resourceGroups/{inputs.resource_group}/deletedAccounts/{name}",
            API_VERSIONS["cognitive_services"],
            "model_account",
        )
    return None


def observe_retention(
    arm: ArmClient, inputs: PlanInputs, resource: TeardownResource, original_identity: dict | None
) -> dict | None:
    target = retention_target(resource, inputs)
    if target is None:
        return None
    path, version, kind = target
    body = arm.get_or_none(path, api_version=version, op="cleanup_retention")
    receipt: dict[str, Any] = {
        "id": resource.path,
        "providerRecord": path,
        "apiVersion": version,
        "kind": kind,
        "physicalPurgeVerified": False,
    }
    if body is None:
        # The provider may not expose a record yet, or may no longer expose it.
        # Neither observation independently establishes removal of retained copies.
        return {**receipt, "status": "provider_record_absent"}
    properties = body.get("properties")
    if (
        not isinstance(properties, dict)
        or properties.get("location", body.get("location")) != inputs.location
    ):
        raise AzureTeardownRefused("AZURE_RETENTION_IDENTITY_UNVERIFIED")
    if kind == "storage":
        if (
            not isinstance(properties.get("storageAccountResourceId"), str)
            or properties["storageAccountResourceId"].lower() != resource.path.lower()
            or not original_identity
            or properties.get("creationTime") != original_identity.get("createdAt")
            or not properties.get("creationTime")
        ):
            raise AzureTeardownRefused("AZURE_RETENTION_IDENTITY_UNVERIFIED")
        # restoreReference can restore private information: never retain it.
        fields = {
            "creationTime": properties["creationTime"],
            "deletionTime": properties.get("deletionTime"),
        }
    else:
        actual_id = properties.get("vaultId") if kind == "key_vault" else body.get("id")
        expected_id = resource.path if kind == "key_vault" else path
        actual_tags = properties.get("tags") if kind == "key_vault" else body.get("tags")
        expected_tags = tags(inputs)
        if (
            not isinstance(actual_id, str)
            or actual_id.lower() != expected_id.lower()
            or not isinstance(actual_tags, dict)
            or any(actual_tags.get(k) != expected_tags[k] for k in (BINDING_TAG, NONCE_TAG))
        ):
            raise AzureTeardownRefused("AZURE_RETENTION_IDENTITY_UNVERIFIED")
        fields = {
            "deletionDate": properties.get("deletionDate"),
            "scheduledPurgeDate": properties.get("scheduledPurgeDate"),
        }
        if kind == "key_vault":
            if not isinstance(properties.get("purgeProtectionEnabled"), bool):
                raise AzureTeardownRefused("AZURE_RETENTION_POLICY_UNVERIFIED")
            fields["purgeProtectionEnabled"] = properties["purgeProtectionEnabled"]
    _validate_times(fields)
    return {**receipt, "status": "provider_retained", **fields}


def _validate_times(fields: dict) -> None:
    for value in fields.values():
        if isinstance(value, bool):
            continue
        if not isinstance(value, str) or not 1 <= len(value) <= 64:
            raise AzureTeardownRefused("AZURE_RETENTION_TIME_UNVERIFIED")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("missing timezone")
        except ValueError as exc:
            raise AzureTeardownRefused("AZURE_RETENTION_TIME_UNVERIFIED") from exc
