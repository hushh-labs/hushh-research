"""Compose owner-approved Azure cleanup over the existing erasure operation.

Inspection only reserves and reads. Destructive preparation runs only after the
vault owner approved the exact retained plan and supplied fresh Microsoft consent.
Provider credentials stay in the joined worker's memory; no callback can approve.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from hushh_mcp.services import azure_entra_authorizer as entra
from hushh_mcp.services import azure_federation as federation
from hushh_mcp.services.azure_arm_client import ArmClient
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
from hushh_mcp.services.azure_teardown_store import AzureTeardownStore

logger = logging.getLogger(__name__)
CleanupPurpose = Literal["inspect", "execute"]


async def begin(store: AzureTeardownStore, owner: str, purpose: CleanupPurpose) -> dict:
    """Start a purpose-bound, online-only grant; never delete from this operation."""
    await store.require_completion_contract()
    if purpose == "inspect":
        from hushh_mcp.services.personal_agent_owner_access_erasure import (
            verify_owner_access_compatibility,
        )
        from hushh_mcp.services.personal_agent_provisioning_service import (
            PersonalAgentProvisioningService,
        )

        row = await store.registry.get(owner) or {}
        snapshot_digest = None
        if row.get("status") != "suspended":
            snapshot_digest = await store.candidate_digest(owner, row)
            await verify_owner_access_compatibility(
                PersonalAgentProvisioningService(registry=store.registry), user_id=owner, row=row
            )
        # Retains a snapshot and closes new pod admission. No key destruction,
        # cloud mutation or account deletion occurs while inspecting terms.
        await store.reserve(owner, snapshot_digest)
    authorization = await store.authorization(owner, purpose)
    context = authorization["context"]
    url = await asyncio.to_thread(
        entra.begin,
        owner,
        kind="teardown",
        subscription_id=context["subscriptionId"],
        tenant_id=context["tenantId"],
        erasure_attempt=context["attemptId"],
        erasure_digest=authorization["digest"],
    )
    return {
        "status": "authorization_required",
        "authorizationUrl": url,
        "operationId": context["attemptId"],
    }


async def bound_authorization(
    store: AzureTeardownStore, owner: str, selection: entra.AuthorizationState
) -> dict:
    """Re-read SQL authority before code redemption, including the grant's purpose."""
    await store.require_completion_contract()
    if selection.kind != "teardown" or selection.user_id != owner:
        raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")
    authorization = await store.match_authorization(
        owner, attempt=selection.erasure_attempt, digest=selection.erasure_digest
    )
    context = authorization["context"]
    if (
        context["tenantId"] != selection.authority
        or context["subscriptionId"] != selection.subscription_id
    ):
        raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")
    return authorization


async def complete(
    store: AzureTeardownStore,
    owner: str,
    selection: entra.AuthorizationState,
    token: entra.DelegatedToken,
) -> dict:
    """Consume only current authority; return metadata rather than credentials."""
    authorization = await bound_authorization(store, owner, selection)
    if token.tenant_id != authorization["context"]["tenantId"]:
        raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")
    reservation = await store.reservation(owner)
    principal = (await asyncio.to_thread(federation.app_token, token.tenant_id)).object_id
    if authorization["purpose"] == "inspect":
        from hushh_mcp.services.azure_teardown_observation import inspect_plan

        plan = await asyncio.to_thread(
            inspect_plan,
            ArmClient(token.access_token),
            context=authorization["context"],
            reservation=reservation,
            hub_principal=principal,
        )
        await store.retain_plan(owner, plan)
        return {"status": "cleanup_review_required", **await store.view(owner)}
    await _execute(store, owner, reservation, token, principal, selection)
    return {"status": "cleanup_observed", **await store.view(owner)}


async def _execute(
    store: AzureTeardownStore,
    owner: str,
    reservation: dict,
    token: entra.DelegatedToken,
    principal: str,
    selection: entra.AuthorizationState,
) -> None:
    from hushh_mcp.services.azure_resource_teardown import execute
    from hushh_mcp.services.azure_teardown_authority import azure_teardown_authority
    from hushh_mcp.services.azure_teardown_observation import (
        bound_execution_inventory,
        inspect_plan,
    )
    from hushh_mcp.services.personal_agent_owner_access_erasure import (
        checkpoint_reserved_owner_access,
    )
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

    # Resolve the complete immutable inventory BEFORE touching pod keys or roles.
    arm = ArmClient(token.access_token, throttle_retries=0, transient_retries=0)
    inputs, resources, frozen = await asyncio.to_thread(
        bound_execution_inventory,
        arm,
        plan=reservation["azureTeardown"]["plan"],
        reservation=reservation,
        hub_principal=principal,
    )
    if not reservation.get("agentCryptoErase"):
        fresh = await asyncio.to_thread(
            inspect_plan,
            arm,
            context=reservation["azureTeardown"]["plan"]["context"],
            reservation=reservation,
            hub_principal=principal,
        )
        if fresh != reservation["azureTeardown"]["plan"]:
            raise AzureTeardownRefused("AZURE_CLEANUP_PLAN_CHANGED")
    await bound_authorization(store, owner, selection)
    metadata = reservation["registrySnapshot"].get("backend_metadata") or {}
    backend = UserAzureBackend(
        tenant_id=inputs.tenant_id,
        subscription_id=inputs.subscription_id,
        resource_group=inputs.resource_group,
        location=inputs.location,
        observer=lambda: arm,
        recorded_principal=str(metadata.get("runtime_principal_id") or ""),
        recorded_digest=str(metadata.get("image_digest") or ""),
        files_library_enabled=True,
    )
    service = PersonalAgentProvisioningService(registry=store.registry, backend=backend)
    await checkpoint_reserved_owner_access(
        service, user_id=owner, reservation=reservation, backend=backend
    )
    # Only SQL-qualified historical provider coverage can admit the worker.
    async with azure_teardown_authority(owner=owner, attempt=reservation["attemptId"]) as authority:
        await authority.run_worker(
            lambda **_kwargs: execute(arm, inputs, resources, authority, frozen)
        )


async def run_cleanup(
    store: AzureTeardownStore,
    owner: str,
    selection: entra.AuthorizationState,
    token: entra.DelegatedToken,
) -> None:
    """Background completion is observable through retained receipts, never raw errors."""
    purpose = "execute"
    try:
        await bound_authorization(store, owner, selection)
        await complete(store, owner, selection, token)
        await store.mark_authorization(owner, selection, purpose, "settled", "OBSERVED")
    except asyncio.CancelledError:
        await store.mark_authorization(
            owner, selection, purpose, "attention_required", "INTERRUPTED"
        )
        raise
    except Exception as exc:
        # The durable operation keeps accepted/uncertain provider outcomes. No
        # exception payload, bearer or provider body enters logs or task metadata.
        logger.warning("azure_cleanup.interrupted error_type=%s", type(exc).__name__)
        await store.mark_authorization(
            owner, selection, purpose, "attention_required", "RETRY_REQUIRED"
        )
