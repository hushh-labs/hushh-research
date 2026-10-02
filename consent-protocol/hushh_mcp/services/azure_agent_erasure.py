"""Erase an owner Azure agent with only the authority Hussh is allowed to hold.

Order, and why:

1. **Fence.** The agent must read back from ARM as THIS person's (setup binding and
   identity), so erasure never acts on a resource it cannot prove it created.
2. **Crypto-erase in the agent.** The agent deletes its wrapped key, memory and blobs
   with its own identity. Hussh holds no Storage or Key Vault role and so cannot do
   this itself, which is the point.
3. **Revoke the agent's access** (key, secret, blob container, registry, model) with
   the ABAC-conditioned ``roleAssignments/delete``.
4. **Revoke Hussh's own access, LAST**: the observer assignments, then the removal
   assignment itself.

Nothing is deleted from the person's subscription: Hussh has no delete authority
there, by design. The receipt names what remains, the resource group to delete, and
the earliest date the purge-protected vault can be purged.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_setup_plan import (
    HUSSH_PRINCIPAL,
    KEY_VAULT_SOFT_DELETE_DAYS,
    POD_PRINCIPAL,
    ROLE_ACR_PULL,
    ROLE_COGNITIVE_SERVICES_OPENAI_USER,
    ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER,
    ROLE_KEY_VAULT_SECRETS_USER,
    ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR,
    PlanInputs,
    Scopes,
    observer_role_id,
    removal_role_id,
    resource_names,
    role_assignment_path,
)

logger = logging.getLogger(__name__)

RECEIPT_VERSION = 1


class AzureErasureRefused(RuntimeError):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def _pod_grants(scopes: Scopes) -> list[str]:
    return [
        role_assignment_path(
            scopes.key, ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER, POD_PRINCIPAL
        ),
        role_assignment_path(scopes.secret, ROLE_KEY_VAULT_SECRETS_USER, POD_PRINCIPAL),
        role_assignment_path(scopes.container, ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR, POD_PRINCIPAL),
        role_assignment_path(scopes.registry, ROLE_ACR_PULL, POD_PRINCIPAL),
        role_assignment_path(scopes.openai, ROLE_COGNITIVE_SERVICES_OPENAI_USER, POD_PRINCIPAL),
    ]


def _hussh_grants(inputs: PlanInputs, scopes: Scopes) -> list[str]:
    """Observer first; the removal grant that authorizes all of this goes last."""
    observer = observer_role_id(inputs)
    return [
        role_assignment_path(scopes.app, observer, HUSSH_PRINCIPAL),
        role_assignment_path(scopes.environment, observer, HUSSH_PRINCIPAL),
        role_assignment_path(scopes.group, removal_role_id(inputs), HUSSH_PRINCIPAL),
    ]


def _remaining(scopes: Scopes) -> list[str]:
    return [
        scopes.app,
        scopes.environment,
        scopes.identity,
        scopes.vault,
        scopes.storage,
        scopes.registry,
        scopes.openai,
        scopes.group,
    ]


def _delete_all(arm: ArmClient, paths: list[str]) -> list[str]:
    api = API_VERSIONS["authorization"]
    removed = []
    for path in paths:
        if arm.delete(path, api_version=api, op="erasure"):
            removed.append(path)
    return removed


def receipt_for(
    inputs: PlanInputs, *, pod_receipt: dict, pod_revoked: list[str], hussh_revoked: list[str],
    now: datetime | None = None,
) -> dict[str, Any]:  # fmt: skip
    names = resource_names(inputs)
    scopes = Scopes(inputs, names)
    today = (now or datetime.now(timezone.utc)).date()
    return {
        "version": RECEIPT_VERSION,
        "tenantId": inputs.tenant_id,
        "subscriptionId": inputs.subscription_id,
        "resourceGroup": inputs.resource_group,
        "agentErased": pod_receipt,
        "agentAccessRevoked": pod_revoked,
        "husshAccessRevoked": hussh_revoked,
        "remainingResources": _remaining(scopes),
        "keyVault": {
            "name": names.key_vault,
            "purgeProtection": True,
            "softDeleteRetentionDays": KEY_VAULT_SOFT_DELETE_DAYS,
            "earliestPurgeIfDeletedToday": (
                today + timedelta(days=KEY_VAULT_SOFT_DELETE_DAYS)
            ).isoformat(),
        },
        "nextStep": (
            f"Delete the resource group {inputs.resource_group} in your Azure subscription "
            "to remove the remaining resources and stop their charges. Hussh can no "
            "longer see or change anything there."
        ),
    }


async def erase_owner_access(
    *,
    inputs: PlanInputs,
    observer: ArmClient,
    verify_fence: Callable[[], Awaitable[None]],
    crypto_erase: Callable[[], Awaitable[dict]],
) -> dict[str, Any]:
    """Run the four steps in order; any refusal stops before Hussh revokes itself."""
    import asyncio  # noqa: PLC0415

    await verify_fence()
    pod_receipt = await crypto_erase()
    if not isinstance(pod_receipt, dict) or pod_receipt.get("erased") is not True:
        raise AzureErasureRefused(
            "the agent did not confirm its crypto-erase; nothing was revoked",
            code="AGENT_ERASE_UNCONFIRMED",
        )
    scopes = Scopes(inputs, resource_names(inputs))
    pod_revoked = await asyncio.to_thread(_delete_all, observer, _pod_grants(scopes))
    hussh_revoked = await asyncio.to_thread(_delete_all, observer, _hussh_grants(inputs, scopes))
    logger.info(
        "azure_erasure.revoked agent=%d hussh=%d group=%s",
        len(pod_revoked),
        len(hussh_revoked),
        inputs.resource_group,
    )
    return receipt_for(
        inputs, pod_receipt=pod_receipt, pod_revoked=pod_revoked, hussh_revoked=hussh_revoked
    )


__all__ = ["RECEIPT_VERSION", "AzureErasureRefused", "erase_owner_access", "receipt_for"]
