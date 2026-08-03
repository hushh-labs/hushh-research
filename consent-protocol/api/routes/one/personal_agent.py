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
        default=WRAPPING_ALG, alias="podKeyWrappingAlg", max_length=64  # gitleaks:allow -- algorithm label, not key material
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


# ``personal_agent_registry.status`` -> the ``state`` this endpoint reports.
#
# The left column is the real vocabulary of that column, taken from the code that
# WRITES it rather than from any design note. Four values have a writer today:
#
#   unprovisioned  schema DEFAULT (db/migrations/parked/900_personal_agent_registry.sql)
#   pending        PersonalAgentProvisioningService.register_pending, off phone-verify
#   provisioning   PersonalAgentProvisioningService.provision, around the backend call
#   provisioned    PersonalAgentProvisioningService.provision, after the standing mint
#
# ``connecting`` and ``provisioning_failed`` are declared here AHEAD of their
# writer. Nothing emits them yet -- the live compute backend and the reconcile
# sweep that will (DEV-LIVE-EXECUTION-PLAN.md, Workstreams B and C) are unbuilt, so
# today those two rows are unreachable. They are declared anyway because this map
# is the read-side contract: with them present the write side lands without a
# second edit here and without any client change. Keeping the two halves of that
# seam in one file is the point.
#
# ``deprovision_requested`` is deliberately absent: it is written to
# ``personal_agent_deletion_tombstones.status``, never to the registry.
_STATE_BY_REGISTRY_STATUS: dict[str, str] = {
    "unprovisioned": "reserved",
    "pending": "reserved",
    "provisioning": "provisioning",
    "connecting": "connecting",
    "provisioned": "active",
    "provisioning_failed": "failed",
}

# Every unmapped status degrades to this. A raw DB value is NEVER echoed to the
# caller: an unrecognised status is a backend detail, and leaking it would make a
# client's own state handling a function of our schema.
_DEFAULT_STATE = "reserved"


@router.get("/status")
async def personal_agent_status(
    user_id: str = Depends(require_firebase_auth),
):
    """The caller's own personal-agent state — honest even while the feature is off.

    Deliberately NOT flag-gated and never 404: an Apple-grade product meets the
    customer honestly rather than in silence. Reads only the user's OWN row.

    ``state`` is one of ``reserved | provisioning | connecting | active | failed``,
    mapped from ``personal_agent_registry.status`` by
    :data:`_STATE_BY_REGISTRY_STATUS` (see that map for which of those the backend
    can actually produce today). ``reserved`` is both a real state — their sovereign
    agent identity is reserved and ready to activate — and the fail-safe: a registry
    read error, a missing row, and a status this build does not recognise all report
    ``reserved`` rather than an error or a raw DB value. That is deliberate. The home
    must never break, and it must never over-claim.
    """
    row = None
    try:
        row = await PersonalAgentRegistryRepo().get(user_id)
    except Exception as exc:  # fail safe: never break the home on a registry hiccup
        logger.warning("personal_agent.status_read_failed err=%s", type(exc).__name__)

    status = str((row or {}).get("status") or "").strip()
    state = _STATE_BY_REGISTRY_STATUS.get(status, _DEFAULT_STATE)
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
