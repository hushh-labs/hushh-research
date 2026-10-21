"""Compose owner-approved Azure cleanup over the existing erasure operation.

Inspection only reserves and reads. Destructive preparation runs only after the
vault owner approved the exact retained plan and supplied fresh Microsoft consent.
Provider credentials stay in the joined worker's memory; no callback can approve.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Literal

from hushh_mcp.services import azure_entra_authorizer as entra
from hushh_mcp.services import azure_federation as federation
from hushh_mcp.services.azure_arm_client import ArmClient
from hushh_mcp.services.azure_setup_plan import PlanInputs
from hushh_mcp.services.azure_setup_worker import run_setup_thread
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, TeardownResource
from hushh_mcp.services.azure_teardown_store import AzureTeardownStore
from hushh_mcp.services.compute_backend import OwnerAccessCheckpointBackend

logger = logging.getLogger(__name__)
CleanupPurpose = Literal["inspect", "execute"]


def _checkpoint_backend(
    snapshot: dict, inputs: PlanInputs, arm: ArmClient
) -> OwnerAccessCheckpointBackend:
    """Use the reserved host and delegated transport, never fresh placement inference."""
    from hushh_mcp.services.personal_agent_owner_access_erasure import owner_access_spec
    from hushh_mcp.services.user_azure_backend import UserAzureBackend
    from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend

    spec = owner_access_spec(snapshot)

    # Inspection has already opened this operation's pool. A borrowed reader
    # must not close the destructive worker's transport when its fence settles.
    def observer() -> ArmClient:
        return arm.with_request_budget(lambda: 15.0)

    if spec.azure_vm_host is not None:
        return UserAzureVmBackend(spec, observer=observer)
    metadata = snapshot.get("backend_metadata") or {}
    return UserAzureBackend(
        tenant_id=inputs.tenant_id,
        subscription_id=inputs.subscription_id,
        resource_group=inputs.resource_group,
        location=inputs.location,
        observer=observer,
        recorded_principal=str(metadata.get("runtime_principal_id") or ""),
        recorded_digest=str(metadata.get("image_digest") or ""),
        files_library_enabled=True,
    )


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
            if not await store.never_deployed(owner, row):
                await verify_owner_access_compatibility(
                    PersonalAgentProvisioningService(registry=store.registry),
                    user_id=owner,
                    row=row,
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
    authorization: dict = await store.match_authorization(
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
        plan = await run_setup_thread(
            _inspect,
            access_token=token.access_token,
            context=authorization["context"],
            reservation=reservation,
            principal=principal,
            advance=lambda _: None,
        )
        await store.retain_plan(owner, plan)
        return {"status": "cleanup_review_required", **await store.view(owner)}
    await _execute(store, owner, reservation, token, principal, selection)
    return {"status": "cleanup_observed", **await store.view(owner)}


def _inspect(
    *,
    access_token: str,
    context: dict,
    reservation: dict,
    principal: str,
    guard: Callable[[], None],
    advance: Callable[[str], None],
) -> dict:
    from hushh_mcp.services.azure_teardown_observation import inspect_plan

    arm = ArmClient(access_token, throttle_retries=0, transient_retries=0)
    try:
        guard()
        plan: dict = inspect_plan(
            arm, context=context, reservation=reservation, hub_principal=principal
        )
        guard()
        return plan
    finally:
        arm.close()


def _prepare(
    arm: ArmClient,
    reservation: dict,
    principal: str,
    *,
    guard: Callable[[], None],
    advance: Callable[[str], None],
) -> tuple[PlanInputs, tuple[TeardownResource, ...], dict]:
    from hushh_mcp.services.azure_teardown_observation import (
        bound_execution_inventory,
        inspect_plan,
    )

    guard()
    inputs, resources, frozen = bound_execution_inventory(
        arm,
        plan=reservation["azureTeardown"]["plan"],
        reservation=reservation,
        hub_principal=principal,
    )
    guard()
    if not reservation.get("agentCryptoErase"):
        fresh = inspect_plan(
            arm,
            context=reservation["azureTeardown"]["plan"]["context"],
            reservation=reservation,
            hub_principal=principal,
        )
        if fresh != reservation["azureTeardown"]["plan"]:
            raise AzureTeardownRefused("AZURE_CLEANUP_PLAN_CHANGED")
    guard()
    return inputs, resources, frozen


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
    from hushh_mcp.services.personal_agent_owner_access_erasure import (
        checkpoint_reserved_owner_access,
    )
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )

    # Resolve the complete immutable inventory BEFORE touching pod keys or roles.
    arm = ArmClient(token.access_token, throttle_retries=0, transient_retries=0)
    try:
        inputs, resources, frozen = await run_setup_thread(
            _prepare,
            arm=arm,
            reservation=reservation,
            principal=principal,
            advance=lambda _: None,
        )
        await bound_authorization(store, owner, selection)
        never_deployed = await store.never_deployed(owner, reservation["registrySnapshot"])
        if (
            reservation["azureTeardown"]["plan"]["context"].get("neverDeployed") is True
            and not never_deployed
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_CHANGED")
        if not never_deployed:
            backend = _checkpoint_backend(reservation["registrySnapshot"], inputs, arm)
            service = PersonalAgentProvisioningService(registry=store.registry, backend=backend)
            await checkpoint_reserved_owner_access(
                service, user_id=owner, reservation=reservation, backend=backend
            )
        # Only SQL-qualified historical provider coverage can admit the worker.
        async with azure_teardown_authority(
            owner=owner, attempt=reservation["attemptId"]
        ) as authority:
            await authority.run_worker(
                lambda **_kwargs: execute(arm, inputs, resources, authority, frozen)
            )
    finally:
        arm.close()


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
