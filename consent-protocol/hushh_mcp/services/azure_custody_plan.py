"""Owner custody resources for the canonical Azure setup plan.

The same plan values govern provisioning, transparency and Files compatibility;
there are no provider writes or alternate custody defaults in this module.
"""

from __future__ import annotations

from hushh_mcp.services.azure_setup_plan import (
    KEY_VAULT_SOFT_DELETE_DAYS,
    SIGNING_SECRET_VALUE,
    ArmStep,
    PlanInputs,
    ResourceNames,
    Scopes,
    _resource,
    tags,
)


def custody_steps(inputs: PlanInputs, names: ResourceNames, scopes: Scopes) -> list[ArmStep]:
    located = {"location": inputs.location, "tags": tags(inputs)}
    vault = {
        **located,
        "properties": {
            "tenantId": inputs.tenant_id,
            "sku": {"family": "A", "name": "standard"},
            "enableRbacAuthorization": True,
            "enableSoftDelete": True,
            "softDeleteRetentionInDays": KEY_VAULT_SOFT_DELETE_DAYS,
            "enablePurgeProtection": True,
            "publicNetworkAccess": "Enabled",
        },
    }
    key = {"properties": {"kty": "RSA", "keySize": 3072, "keyOps": ["wrapKey", "unwrapKey"]}}
    secret = {"properties": {"value": SIGNING_SECRET_VALUE, "contentType": "text/plain"}}
    account = {
        **located,
        "sku": {"name": "Standard_LRS"},
        "kind": "StorageV2",
        "properties": {
            "allowSharedKeyAccess": False,
            "allowBlobPublicAccess": False,
            "allowCrossTenantReplication": False,
            "defaultToOAuthAuthentication": True,
            "minimumTlsVersion": "TLS1_2",
            "supportsHttpsTrafficOnly": True,
            "publicNetworkAccess": "Enabled",
        },
    }
    # Soft delete and versioning OFF: the agent's crypto-erase must actually delete.
    blob_service = {
        "properties": {
            "deleteRetentionPolicy": {"enabled": False},
            "containerDeleteRetentionPolicy": {"enabled": False},
            "isVersioningEnabled": False,
        }
    }
    steps = [
        _resource("creating_key_vault", scopes.vault, "key_vault", vault),
        _resource("creating_key_vault", scopes.key, "key_vault", key, create_only=True),
        _resource("creating_key_vault", scopes.secret, "key_vault", secret, create_only=True),
        _resource("creating_storage", scopes.storage, "storage", account),
        _resource("creating_storage", scopes.blob_service, "storage", blob_service),
        _resource(
            "creating_storage",
            scopes.container,
            "storage",
            {"properties": {"publicAccess": "None"}},
        ),
    ]
    if inputs.files_enabled:
        steps.append(
            _resource(
                "creating_storage",
                scopes.files_queue,
                "storage",
                {"properties": {}},
                create_only=True,
            )
        )
    return steps
