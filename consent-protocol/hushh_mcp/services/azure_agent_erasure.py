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

Between 2 and 3 the hub checkpoints the agent's confirmation with the setup nonce
(``crypto_erase`` returns only after that). A revocation cut short by a transient ARM
error resumes from the checkpoint (``resume_revocation``): the agent is never asked
again, and nothing is read from the agent, because Hussh's observer grants may already
be gone while the removal grant, revoked last, still is not.

Nothing is deleted from the person's subscription: Hussh has no delete authority
there, by design. The receipt names what remains, the resource group to delete, and
the earliest date the purge-protected vault can be purged.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Awaitable, Callable

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
from hushh_mcp.services.compute_backend import PodSpec

if TYPE_CHECKING:
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

logger = logging.getLogger(__name__)

RECEIPT_VERSION = 1
#: ``azure_agent_setup`` mints the setup nonce as 8 random bytes in hex.
_SETUP_NONCE = re.compile(r"^[0-9a-f]{16}$")


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


def _revoke_all(arm: ArmClient, paths: list[str]) -> list[str]:
    """Delete each assignment; afterwards none exists (removed now, or already gone).

    A refused delete raises, so the returned list is exactly what is confirmed
    revoked, and a resumed revocation reports what an uninterrupted one would.
    """
    api = API_VERSIONS["authorization"]
    for path in paths:
        arm.delete(path, api_version=api, op="erasure")
    return list(paths)


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


def erasure_target(backend: UserAzureBackend, spec: PodSpec) -> dict[str, str]:
    """The serving incarnation, as the pod names it, that an erasure order must match.

    The pod reads CONTAINER_APP_NAME / CONTAINER_APP_REVISION: the app's own name (the
    last segment of its ARM id) and the revision serving now.
    """
    observation = backend.observe_sync()
    if not observation.present:
        raise observation.refusal("erase")
    metadata = backend.verified_handle(spec.hushh_id, observation).backend_metadata or {}
    revision = str((observation.app.get("properties") or {}).get("latestReadyRevisionName") or "")
    uid = str(spec.expected_service_uid or "")
    if not uid or metadata.get("serviceUid") != uid or not revision or not metadata.get("url"):
        raise RuntimeError("the agent's serving incarnation is not the recorded one")
    return {
        "service": backend.app_id.rsplit("/", 1)[-1],
        "serviceUid": uid,
        "revision": revision,
        "podUrl": str(metadata["url"]).rstrip("/"),
    }


async def erase_through_backend(
    backend: UserAzureBackend,
    spec: PodSpec,
    *,
    observer: ArmClient,
    crypto_erase: Callable[[dict[str, str]], Awaitable[dict]],
) -> dict[str, Any]:
    """Bind the four steps to the agent ARM reads back as THIS person's, then run them."""
    observation = await backend.observe()
    if not observation.present:
        raise observation.refusal("erase")
    handle = backend.verified_handle(spec.hushh_id, observation)
    nonce = str((handle.backend_metadata or {}).get("setupNonce") or "")

    async def fence() -> None:
        current = await backend.observe()
        fenced = backend.verified_handle(spec.hushh_id, current)
        if (fenced.backend_metadata or {}).get("serviceUid") != (handle.backend_metadata or {}).get(
            "serviceUid"
        ):
            raise RuntimeError("the agent was replaced during erasure; nothing was revoked")

    return await erase_owner_access(
        inputs=backend.plan_inputs(spec.hushh_id, nonce),
        observer=observer,
        verify_fence=fence,
        crypto_erase=crypto_erase,
    )


def revoke_access(inputs: PlanInputs, observer: ArmClient, agent_erased: dict) -> dict[str, Any]:
    """Revoke the agent's grants, then Hussh's own, last. Idempotent; reads nothing."""
    scopes = Scopes(inputs, resource_names(inputs))
    pod_revoked = _revoke_all(observer, _pod_grants(scopes))
    hussh_revoked = _revoke_all(observer, _hussh_grants(inputs, scopes))
    logger.info(
        "azure_erasure.revoked agent=%d hussh=%d group=%s",
        len(pod_revoked),
        len(hussh_revoked),
        inputs.resource_group,
    )
    return receipt_for(
        inputs, pod_receipt=agent_erased, pod_revoked=pod_revoked, hussh_revoked=hussh_revoked
    )


async def erase_owner_access(
    *,
    inputs: PlanInputs,
    observer: ArmClient,
    verify_fence: Callable[[], Awaitable[None]],
    crypto_erase: Callable[[dict[str, str]], Awaitable[dict]],
) -> dict[str, Any]:
    """Run the four steps in order; any refusal stops before Hussh revokes itself."""
    await verify_fence()
    pod_receipt = await crypto_erase({"setupNonce": inputs.nonce})
    if not isinstance(pod_receipt, dict) or pod_receipt.get("erased") is not True:
        raise AzureErasureRefused(
            "the agent did not confirm its crypto-erase; nothing was revoked",
            code="AGENT_ERASE_UNCONFIRMED",
        )
    return await asyncio.to_thread(revoke_access, inputs, observer, pod_receipt)


def _checkpoint_names(spec: PodSpec, agent_erased: Any, resume: Any) -> bool:
    nonce = resume.get("setupNonce") if isinstance(resume, dict) else None
    return (
        isinstance(resume, dict)
        and set(resume) == {"setupNonce"}
        and isinstance(nonce, str)
        and _SETUP_NONCE.match(nonce) is not None
        and isinstance(agent_erased, dict)
        and agent_erased.get("erased") is True
        and agent_erased.get("hushhId") == spec.hushh_id
        and bool(spec.expected_service_uid)
        and agent_erased.get("serviceUid") == spec.expected_service_uid
    )


async def resume_revocation(
    backend: UserAzureBackend,
    spec: PodSpec,
    *,
    observer: ArmClient,
    agent_erased: dict[str, Any],
    resume: dict[str, str],
) -> dict[str, Any]:
    """Finish a revocation cut short, from the checkpoint the hub retained.

    Steps 1 and 2 are done and must not repeat: the agent erased itself and its
    confirmation is durable. Only revocation remains, under the removal grant alone.
    """
    if not _checkpoint_names(spec, agent_erased, resume):
        raise AzureErasureRefused(
            "the retained erasure checkpoint does not name this agent; nothing was revoked",
            code="CHECKPOINT_MISMATCH",
        )
    inputs = backend.plan_inputs(spec.hushh_id, resume["setupNonce"])
    return await asyncio.to_thread(revoke_access, inputs, observer, agent_erased)


__all__ = [
    "RECEIPT_VERSION",
    "AzureErasureRefused",
    "erase_owner_access",
    "erase_through_backend",
    "erasure_target",
    "receipt_for",
    "resume_revocation",
    "revoke_access",
]
