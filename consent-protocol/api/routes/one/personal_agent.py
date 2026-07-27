"""Owner-authorized provisioning for a user's own personal agent.

Every action requires the owner's VAULT_OWNER token, so only the person
themselves can stand up or tear down their own agent. Auth is resolved before the
kill-switch check, so an unauthenticated caller gets 401 regardless of the flag;
once authenticated, the surface returns 404 while ``PERSONAL_AGENT_ENABLED`` is
off. The handlers are thin; the real work lives in the provisioning service and
registry.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.compute_backend import resolve_compute_backend
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_connector_keypair_service import WRAPPING_ALG

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/personal-agent", tags=["personal-agent"])


class ProvisionRequest(BaseModel):
    pod_public_key: str = Field(..., alias="podPublicKey", min_length=1, max_length=256)
    pod_key_id: str = Field(..., alias="podKeyId", min_length=1, max_length=128)
    pod_key_wrapping_alg: str = Field(
        default=WRAPPING_ALG, alias="podKeyWrappingAlg", max_length=64
    )

    model_config = ConfigDict(populate_by_name=True)


def _require_enabled() -> None:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")


def _service() -> PersonalAgentProvisioningService:
    # backend from PERSONAL_AGENT_BACKEND (default unset -> inert NullBackend).
    return PersonalAgentProvisioningService(
        registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
    )


@router.get("/status")
async def personal_agent_status(
    user_id: str = Depends(require_firebase_auth),
):
    """The caller's own personal-agent state — honest even while the feature is off.

    Deliberately NOT flag-gated and never 404: an Apple-grade product meets the
    customer honestly rather than in silence. When the always-on pod is not yet
    active for this user the honest state is ``reserved`` (their sovereign agent
    identity is reserved and ready to activate), becoming ``active`` once a pod is
    provisioned. Reads only the user's OWN row; fails safe to ``reserved``.
    """
    row = None
    try:
        row = await PersonalAgentRegistryRepo().get(user_id)
    except Exception as exc:  # fail safe: never break the home on a registry hiccup
        logger.warning("personal_agent.status_read_failed err=%s", type(exc).__name__)

    status = str((row or {}).get("status") or "").strip()
    state = "active" if status == "provisioned" else "reserved"
    result: dict = {"state": state, "featureEnabled": personal_agent_enabled()}
    hushh_id = (row or {}).get("hushh_id")
    if hushh_id:
        result["hushhId"] = hushh_id
    return result


@router.post("/provision")
async def provision_personal_agent(
    payload: ProvisionRequest = Body(...),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Stand up the caller's own agent. Requires the owner's VAULT_OWNER token."""
    _require_enabled()
    user_id = token_data["user_id"]

    identity = (await ActorIdentityService().get_many([user_id])).get(user_id)
    if not identity or identity.get("phone_verified") is not True:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "PHONE_NOT_VERIFIED",
                "message": "A verified phone is required to provision the agent.",
            },
        )
    phone = str(identity.get("phone_number") or "").strip()
    if not phone:
        raise HTTPException(
            status_code=409,
            detail={"code": "PHONE_NOT_VERIFIED", "message": "A verified phone is required."},
        )

    try:
        result = await _service().provision(
            user_id=user_id,
            phone_e164=phone,
            pod_public_key_b64=payload.pod_public_key,
            pod_key_id=payload.pod_key_id,
            pod_key_wrapping_alg=payload.pod_key_wrapping_alg,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_PROVISION_INPUT", "message": str(exc)},
        ) from exc

    return {"success": True, **result}


@router.post("/deprovision")
async def deprovision_personal_agent(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Tear down the caller's own agent. Requires the owner's VAULT_OWNER token."""
    _require_enabled()
    user_id = token_data["user_id"]
    result = await _service().deprovision(user_id=user_id)
    return {"success": True, **result}
