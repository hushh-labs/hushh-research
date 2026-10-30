"""Owner cloud lifecycle routes, composed into the existing personal-agent family."""

from fastapi import APIRouter, Depends, HTTPException

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.account_cloud_cleanup import CloudRemovalRequest
from api.routes.one import personal_agent as owner
from hushh_mcp.services.account_personal_agent_erasure import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
    PersonalAgentDeprovisioningRequiredError,
)

router = APIRouter()


@router.post("/adopt")
async def adopt_personal_agent(
    user_id: str = Depends(require_firebase_auth),
):
    """Reconnect the caller to a pod that ALREADY exists in their own project.

    Owner-authenticated but NOT vault-gated, unlike ``/provision``: adoption can only
    RESTORE a lost row to a pod that is already running, never mint a new identity or
    create compute, so it needs no vault-owner token. Returns ``{adopted: false}`` when
    there is nothing to adopt (no orphan pod, or no BYOC cloud recorded) -- the caller
    then falls through to reinit or rebuild. The recovery classifier tries this FIRST,
    because reconnecting preserves the agent's identity and memory.
    """
    owner._require_enabled()
    from hushh_mcp.services.pod_adoption import PodAdoptionRefused

    try:
        result = await owner._service().adopt_orphan(user_id=user_id)
    except PodAdoptionRefused:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "POD_ADOPTION_REVIEW_REQUIRED",
                "message": "Review your hosting connection. Your existing resources have been retained.",
            },
        ) from None
    if not result:
        return {"adopted": False}
    return {"adopted": True, **result}


@router.get("/removal")
async def personal_agent_cloud_removal_availability(
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """No provider calls or reservations: offer only an installed removal contract."""
    from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
    from hushh_mcp.services.personal_agent_cloud_removal import CloudRemovalStore

    store = CloudRemovalStore(owner.PersonalAgentRegistryRepo())
    try:
        await store.require_completion_contract()
        row = await store.registry.get(user_id) or {}
        target = row.get("deployment_target")
        provider = "gcp" if target == "user_gcp" else "azure" if target == "user_azure" else None
        if provider is None and await store.can_offer_failed_setup_cleanup(user_id, row):
            provider = "azure"
        if provider is None:
            try:
                operation = await store.operation(user_id)
                if operation.get("completed") is True:
                    provider = operation["provider"]
            except AzureTeardownRefused as exc:
                if exc.code != "CLOUD_REMOVAL_NOT_STARTED":
                    raise
        return {"available": provider is not None, "provider": provider}
    except AzureTeardownRefused:
        return {"available": False, "provider": None}


@router.post("/removal")
async def remove_personal_agent_cloud(
    payload: CloudRemovalRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict:
    """Review and remove the caller's cloud; preserve their Hussh account."""
    from api.routes.account_cloud_cleanup import remove_owner_cloud

    return await remove_owner_cloud(token_data["user_id"], payload)


@router.get("/hosting/inspection")
async def inspect_personal_agent_hosting(user_id: str = Depends(require_firebase_auth)) -> dict:
    """Inspect only recorded owner resources; never repair or delete on a read."""
    from hushh_mcp.services.personal_agent_hosting_inspection import inspect_recorded_hosting

    row = await owner.PersonalAgentRegistryRepo().get(user_id)
    inspection: dict = await inspect_recorded_hosting(owner._service(), owner=user_id, row=row)
    return inspection


@router.post("/deprovision")
async def deprovision_personal_agent(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Tear down the caller's own agent. Requires the owner's VAULT_OWNER token."""
    user_id = token_data["user_id"]
    # Cloud removal requires its purpose-bound review and exact operation.
    # The account erasure worker retains its separate qualified entrypoint.
    row = await owner.PersonalAgentRegistryRepo().get(user_id)
    if row and row.get("deployment_target") in {"user_gcp", "user_azure"}:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CLOUD_REMOVAL_REVIEW_REQUIRED",
                "message": "Review cloud removal in Hosting before removing your private agent.",
            },
        )
    try:
        result = await owner._service().deprovision(user_id=user_id)
    except PersonalAgentDeprovisioningRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
                "message": "Private-agent erasure is incomplete. Recovery resources have been preserved.",
            },
        ) from exc
    return {"success": True, **result}
