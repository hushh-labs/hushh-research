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


class AccountCloudCleanupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["inspect", "status", "approve", "execute"]
    planDigest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    groupConfirmation: str | None = Field(default=None, max_length=256)
    allContentsAccepted: bool = Field(default=False, strict=True)
    retentionAccepted: bool = Field(default=False, strict=True)


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
        token = await asyncio.to_thread(entra.redeem, state, selection, code)
        if token.tenant_id != selection.authority:
            raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_CHANGED")
        if authorization["purpose"] == "inspect":
            await azure_owner_cleanup.complete(store, owner, selection, token)
            return AzureAuthorizeCompleteResponse(
                status="cleanup_review_required", operationId=selection.erasure_attempt
            )
        await store.mark_authorization(owner, selection, "execute", "running", "STARTED")
        spawn(azure_owner_cleanup.run_cleanup(store, owner, selection, token))
        return AzureAuthorizeCompleteResponse(
            status="cleanup_pending", operationId=selection.erasure_attempt
        )
    except AzureTeardownRefused as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": exc.code,
                "message": "Cloud cleanup needs your review or a retry. Your account is retained.",
            },
        ) from None
