"""Vault-owner cleanup phases in the existing account-deletion API family."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Coroutine, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError

if TYPE_CHECKING:
    from api.routes.one.byoc_azure import AzureAuthorizeCompleteResponse
    from hushh_mcp.services.azure_entra_authorizer import AuthorizationState


class _CloudCleanupTerms(BaseModel):
    model_config = ConfigDict(extra="forbid")
    planDigest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    groupConfirmation: str | None = Field(default=None, max_length=256)
    allContentsAccepted: bool = Field(default=False, strict=True)
    retentionAccepted: bool = Field(default=False, strict=True)


class AccountCloudCleanupRequest(_CloudCleanupTerms):
    action: Literal["inspect", "status", "approve", "execute"]


class CloudRemovalRequest(_CloudCleanupTerms):
    action: Literal["inspect", "status", "approve", "execute", "finalize", "cancel"]
    operationId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")


async def remove_owner_cloud(owner: str, request: CloudRemovalRequest) -> dict:
    from hushh_mcp.services import azure_owner_cleanup
    from hushh_mcp.services.personal_agent_cloud_removal import (
        CloudRemovalStore,
        execute_gcp,
        inspect_gcp,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    store = CloudRemovalStore(PersonalAgentRegistryRepo())
    try:
        await store.require_completion_contract()
        if request.action == "cancel":
            if not request.operationId:
                raise AzureTeardownRefused("CLOUD_REMOVAL_OPERATION_REQUIRED")
            return await store.cancel(owner, request.operationId)
        if request.action == "finalize":
            if not request.operationId or not request.planDigest:
                raise AzureTeardownRefused("CLOUD_REMOVAL_APPROVAL_REQUIRED")
            finalized: dict = await store.finalize(owner, request.operationId, request.planDigest)
            return finalized
        if request.action == "status":
            return {"status": "cleanup_status", **await store.view(owner)}
        if request.action == "approve":
            view = await store.view(owner)
            if (
                not request.allContentsAccepted
                or not request.retentionAccepted
                or not request.planDigest
                or not request.groupConfirmation
                or view["operationId"] != request.operationId
            ):
                raise AzureTeardownRefused("CLOUD_REMOVAL_APPROVAL_REQUIRED")
            return {
                "status": "cleanup_approved",
                **await store.approve(owner, request.planDigest, request.groupConfirmation),
            }
        row = await store.registry.get(owner) or {}
        snapshot = (
            (row.get("backend_metadata") or {}).get("erasure", {}).get("registrySnapshot", row)
        )
        if snapshot.get("deployment_target") == "user_gcp":
            if request.action == "inspect":
                inspected: dict = await inspect_gcp(store, owner, row)
                return inspected
            if not request.operationId or not request.planDigest:
                raise AzureTeardownRefused("CLOUD_REMOVAL_APPROVAL_REQUIRED")
            executed: dict = await execute_gcp(
                store, owner, request.operationId, request.planDigest
            )
            return executed
        if snapshot.get("deployment_target") != "user_azure" and not await store.never_deployed(
            owner, snapshot
        ):
            raise AzureTeardownRefused("CLOUD_REMOVAL_HOSTING_UNVERIFIED")
        if request.action == "execute":
            if not request.operationId or not request.planDigest:
                raise AzureTeardownRefused("CLOUD_REMOVAL_APPROVAL_REQUIRED")
            await store.require_execution(owner, request.operationId, request.planDigest)
        authorization: dict = await azure_owner_cleanup.begin(store, owner, request.action)
        return authorization
    except (AzureTeardownRefused, PodMigrationTransportError) as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": exc.code,
                "message": "Cloud removal needs your review or a retry. Your account is retained.",
            },
        ) from None


async def account_cloud_cleanup(owner: str, request: AccountCloudCleanupRequest) -> dict:
    from hushh_mcp.services import azure_owner_cleanup
    from hushh_mcp.services.azure_teardown_store import AzureTeardownStore
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    store = AzureTeardownStore(PersonalAgentRegistryRepo())
    try:
        await store.require_completion_contract()
        if request.action == "status":
            return {"status": "cleanup_status", **await store.view(owner)}
        if request.action == "approve":
            if (
                not request.allContentsAccepted
                or not request.retentionAccepted
                or not request.planDigest
                or not request.groupConfirmation
            ):
                raise AzureTeardownRefused("AZURE_CLEANUP_TERMS_REQUIRED")
            await store.approve(owner, request.planDigest, request.groupConfirmation)
            return {"status": "cleanup_approved", **await store.view(owner)}
        result: dict[str, Any] = await azure_owner_cleanup.begin(store, owner, request.action)
        return result
    except PodMigrationTransportError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": exc.code,
                "message": "Update or repair your private agent before cloud cleanup.",
            },
        ) from None
    except AzureTeardownRefused as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": exc.code,
                "message": "Cloud cleanup needs your review or a retry. Your account is retained.",
            },
        ) from None


async def complete_azure_cleanup(
    owner: str,
    state: str,
    selection: AuthorizationState,
    code: str,
    spawn: Callable[[Coroutine[Any, Any, None]], None],
) -> AzureAuthorizeCompleteResponse:
    """Callback only consumes current owner approval; it can never create that approval."""
    import asyncio

    from api.routes.one.byoc_azure import AzureAuthorizeCompleteResponse
    from hushh_mcp.services import azure_entra_authorizer as entra
    from hushh_mcp.services import azure_owner_cleanup
    from hushh_mcp.services.azure_teardown_store import AzureTeardownStore
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    store = AzureTeardownStore(PersonalAgentRegistryRepo())
    try:
        authorization = await azure_owner_cleanup.bound_authorization(store, owner, selection)
        cloud_only = False
        if (
            await store._value(
                "SELECT to_regclass('public.personal_agent_cloud_removals') IS NOT NULL AS value",
                {},
            )
            is True
        ):
            cloud_only = (
                await store._value(
                    "SELECT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE user_id=:owner AND attempt_id=:attempt AND completed_at IS NULL) AS value",
                    {"owner": owner, "attempt": selection.erasure_attempt},
                )
                is True
            )
        token = await asyncio.to_thread(entra.redeem, state, selection, code)
        if token.tenant_id != selection.authority:
            raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")
        if authorization["purpose"] == "inspect":
            await azure_owner_cleanup.complete(store, owner, selection, token)
            return AzureAuthorizeCompleteResponse(
                status="cleanup_review_required",
                operationId=selection.erasure_attempt,
                cleanupPurpose="remove_cloud" if cloud_only else None,
            )
        if cloud_only:
            from hushh_mcp.services.personal_agent_cloud_removal import CloudRemovalStore

            cloud_store = CloudRemovalStore(store.registry)
            operation = await cloud_store.operation(owner)
            await cloud_store.require_execution(
                owner, selection.erasure_attempt, operation.get("approved") or ""
            )
        await store.mark_authorization(owner, selection, "execute", "running", "STARTED")
        spawn(azure_owner_cleanup.run_cleanup(store, owner, selection, token))
        return AzureAuthorizeCompleteResponse(
            status="cleanup_pending",
            operationId=selection.erasure_attempt,
            cleanupPurpose="remove_cloud" if cloud_only else None,
        )
    except AzureTeardownRefused as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": exc.code,
                "message": "Cloud cleanup needs your review or a retry. Your account is retained.",
            },
        ) from None
