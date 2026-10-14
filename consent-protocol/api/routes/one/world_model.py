"""Explicit, owner-scoped PWM research. Viewing the route never starts a job."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middlewares.chat_key import require_vault_owner_chat_key
from api.middlewares.rate_limit import limiter
from api.routes.one.profile_research import (
    MagicReviewCommit,
    MagicReviewCompletion,
    PrivateProfileRoute,
)
from hushh_mcp.services import world_model_invitations as invitations
from hushh_mcp.services.magic_intelligence_completion import (
    MagicReviewNotCommitted,
    complete_magic_intelligence,
)
from hushh_mcp.services.owner_placement_guard import hub_content_chat_owner
from hushh_mcp.services.world_model_service import world_model_jobs

router = APIRouter(
    prefix="/api/one/world-model", tags=["Personal World Model"], route_class=PrivateProfileRoute
)


def owner(token):
    if not token.get("user_id") or not token.get("token"):
        raise HTTPException(403, "Unlock your vault to continue.")
    return token["user_id"], token["token"]


async def operation(token, start):
    try:
        result = await (world_model_jobs.start if start else world_model_jobs.status)(*owner(token))
        return JSONResponse(result, status_code=202 if result["status"] == "pending" else 200)
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            503, "Research is temporarily unavailable.", headers={"Retry-After": "5"}
        ) from None


@router.post("/jobs")
@limiter.limit("20/hour")
async def start(request: Request, token: dict = Depends(hub_content_chat_owner)):
    return await operation(token, True)


@router.get("/jobs")
@limiter.limit("30/minute")
async def status(request: Request, token: dict = Depends(hub_content_chat_owner)):
    return await operation(token, False)


@router.delete("/jobs")
@limiter.limit("20/hour")
async def dismiss(
    request: Request,
    draft_id: UUID | None = None,
    token: dict = Depends(hub_content_chat_owner),
):
    try:
        await world_model_jobs.dismiss(*owner(token), str(draft_id) if draft_id else None)
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(409, "Draft changed. Try again.") from None
    return {"discarded": True}


class WorldModelCompletion(MagicReviewCompletion):
    draft_id: UUID
    commits: list[MagicReviewCommit] = Field(min_length=1, max_length=160)


@router.post("/complete")
@limiter.limit("10/minute")
async def complete(
    request: Request,
    body: WorldModelCompletion,
    token: dict = Depends(hub_content_chat_owner),
):
    user_id, consent_token = owner(token)
    try:
        await complete_magic_intelligence(
            user_id,
            [(row.domain, row.plan_id) for row in body.commits],
            verify_only=True,
            max_commits=160,
        )
        await world_model_jobs.dismiss(user_id, consent_token, str(body.draft_id))
    except MagicReviewNotCommitted:
        raise HTTPException(409, "Reviewed details have not all been confirmed.") from None
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except RuntimeError:
        raise HTTPException(409, "Draft changed. Refresh before saving.") from None
    return {"saved": True}


class InvitationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contact: str = Field(min_length=3, max_length=320)


class ClaimInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    consent: Literal[True]


@router.post("/invitations")
@limiter.limit("20/day")
async def create_invitation(
    request: Request, body: InvitationInput, token: dict = Depends(require_vault_owner_chat_key)
):
    try:
        return await invitations.create(*owner(token), body.contact)
    except PermissionError:
        raise HTTPException(403, "Verify your contact and unlock your vault.") from None
    except ValueError:
        raise HTTPException(
            422,
            "Use a valid email or phone with country code. At most 20 invitations can be pending.",
        ) from None


@router.get("/invitations")
@limiter.limit("30/minute")
async def list_invitations(request: Request, token: dict = Depends(require_vault_owner_chat_key)):
    try:
        return await invitations.list_invitations(*owner(token))
    except PermissionError:
        raise HTTPException(403, "Verify your contact and unlock your vault.") from None


@router.delete("/invitations/{invitation_id}")
@limiter.limit("30/minute")
async def revoke_invitation(
    request: Request, invitation_id: UUID, token: dict = Depends(require_vault_owner_chat_key)
):
    try:
        return await invitations.revoke(*owner(token), invitation_id)
    except PermissionError:
        raise HTTPException(403, "Verify your contact and unlock your vault.") from None


@router.post("/claims")
@limiter.limit("10/hour")
async def claim_invitation(
    request: Request, body: ClaimInput, token: dict = Depends(require_vault_owner_chat_key)
):
    try:
        return await invitations.claim(*owner(token), body.token)
    except (ValueError, PermissionError):
        raise HTTPException(
            403,
            "This invitation is unavailable, expired, or belongs to a different verified contact.",
        ) from None


class ResearchIdentityInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    email: str | None = Field(default=None, min_length=3, max_length=320)
    phone_number: str | None = Field(default=None, pattern=r"^\+[1-9]\d{7,14}$")


@router.post("/research")
@limiter.limit("20/hour")
async def research(
    request: Request,
    body: ResearchIdentityInput,
    token: dict = Depends(hub_content_chat_owner),
):
    """Integration endpoint: supplied identifiers must belong to the current owner."""
    from hushh_mcp.services.world_model_service import owner_identity

    user_id, consent_token = owner(token)
    try:
        identity = await owner_identity(user_id, consent_token)
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    if (
        identity is None
        or not (body.email or body.phone_number)
        or body.name.strip() != identity["full_name"]
        or (body.email and body.email.strip().lower() != str(identity["email"] or "").lower())
        or (body.phone_number and body.phone_number != identity["phone_number"])
    ):
        raise HTTPException(403, "Use your account name and a verified contact.")
    return await operation(token, True)
