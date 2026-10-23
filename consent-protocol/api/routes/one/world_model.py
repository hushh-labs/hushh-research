"""Owner-scoped PWM preparation; default-on after setup, with a persistent opt-out."""

import json
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
from hushh_mcp.managed_ai_config import load_pwm_policy
from hushh_mcp.one_adk.public_sources import OwnerPublicProfiles
from hushh_mcp.one_adk.world_model import OwnerDecisions
from hushh_mcp.one_adk.world_model_usage import public_result
from hushh_mcp.services import world_model_invitations as invitations
from hushh_mcp.services import world_model_preferences as preferences
from hushh_mcp.services import world_model_source_review as source_reviews
from hushh_mcp.services.magic_intelligence_completion import (
    MagicReviewNotCommitted,
    complete_magic_intelligence,
)
from hushh_mcp.services.owner_placement_guard import hub_content_chat_owner
from hushh_mcp.services.world_model_service import PublicProfilesChanged, world_model_jobs

router = APIRouter(
    prefix="/api/one/world-model", tags=["Personal World Model"], route_class=PrivateProfileRoute
)


def owner(token):
    if not token.get("user_id") or not token.get("token"):
        raise HTTPException(403, "Unlock your vault to continue.")
    return token["user_id"], token["token"]


class PreparationInput(BaseModel):
    """Optional: owner decisions the model must not propose again."""

    model_config = ConfigDict(extra="forbid")
    owner_decisions: OwnerDecisions | None = None


class RefreshPreparationInput(PreparationInput):
    """Explicit owner refresh; automatic ensure retains its reuse contract."""

    refresh: bool = Field(default=False, strict=True)
    public_profiles: OwnerPublicProfiles | None = None


def decisions(body: PreparationInput | None):
    return body.owner_decisions.model_dump() if body and body.owner_decisions else None


def research_response(result, status_code):
    payload, usage = public_result(result)
    headers = {"X-Hussh-PWM-Usage": json.dumps(usage, separators=(",", ":"))} if usage else None
    return JSONResponse(payload, status_code=status_code, headers=headers)


async def operation(token, start, owner_decisions=None, refresh=False, public_profiles=None):
    try:
        if start:
            kwargs = (
                {"inputs": {"owner_decisions": owner_decisions}}
                if owner_decisions is not None
                else {}
            )
            if refresh:
                kwargs["refresh_completed"] = True
            if public_profiles is not None:
                kwargs.setdefault("inputs", {})["public_profiles"] = public_profiles
            result = await world_model_jobs.start(*owner(token), **kwargs)
        else:
            result = await world_model_jobs.status(*owner(token))
        return research_response(result, status_code=202 if result["status"] == "pending" else 200)
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except HTTPException:
        raise
    except PublicProfilesChanged:
        raise HTTPException(
            409, "Wait for current research, then explicitly research these profiles."
        ) from None
    except Exception:
        raise HTTPException(
            503, "Research is temporarily unavailable.", headers={"Retry-After": "5"}
        ) from None


@router.post("/jobs")
@limiter.limit("20/hour")
async def start(
    request: Request,
    body: RefreshPreparationInput | None = None,
    token: dict = Depends(hub_content_chat_owner),
):
    return await operation(
        token,
        True,
        decisions(body),
        refresh=bool(body and body.refresh),
        public_profiles=body.public_profiles.model_dump()
        if body and body.public_profiles
        else None,
    )


@router.get("/jobs")
@limiter.limit("30/minute")
async def status(
    request: Request,
    draft_id: UUID | None = None,
    token: dict = Depends(hub_content_chat_owner),
):
    response = await operation(token, False)
    if draft_id:
        import json

        value = json.loads(response.body)
        if value.get("draft_id") != str(draft_id):
            raise HTTPException(404, "This research draft is no longer available.")
    return response


class ResearchPreferencesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    email_enabled: bool
    consent_version: Literal["pwm-native-v1", "pwm-azure-bing-v1", "pwm-azure-tavily-v1"]


@router.get("/preferences")
async def get_preferences(request: Request, token: dict = Depends(require_vault_owner_chat_key)):
    user_id, _ = owner(token)
    return preferences.public_preferences(await preferences.preferences(user_id))


@router.put("/preferences")
@limiter.limit("30/hour")
async def set_preferences(
    request: Request,
    body: ResearchPreferencesInput,
    token: dict = Depends(require_vault_owner_chat_key),
):
    try:
        return await preferences.update_preferences(
            *owner(token),
            enabled=body.enabled,
            email_enabled=body.email_enabled,
            consent_version=body.consent_version,
        )
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except ValueError:
        raise HTTPException(422, "Accept the current research disclosure to continue.") from None


# Paid work is bounded in the database (3 new runs an hour, a fixed search and
# model-call budget per discovery, one lease per owner), not by this per-process
# counter. One driver resuming 240 s slices on two devices needs ~30 an hour.
@router.post("/ensure")
@limiter.limit("60/hour")
async def ensure(
    request: Request,
    body: PreparationInput | None = None,
    token: dict = Depends(hub_content_chat_owner),
):
    try:
        result = await world_model_jobs.ensure(*owner(token), owner_decisions=decisions(body))
        return research_response(
            result, status_code=202 if result["status"] in {"pending", "paused"} else 200
        )
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except Exception:
        raise HTTPException(
            503, "Research is temporarily unavailable.", headers={"Retry-After": "60"}
        ) from None


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
        draft = await world_model_jobs.status(user_id, consent_token)
        if draft.get("research", {}).get("source_use") not in {
            "owner_supplied",
            "tavily_review_retained",
        }:
            raise HTTPException(
                409,
                "This search response is for viewing. Add your own details or a permitted source to save knowledge.",
            )
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
    secondary_contact: str | None = Field(default=None, min_length=3, max_length=320)
    subject_name: str | None = Field(default=None, min_length=1, max_length=160)
    preview_draft_id: UUID | None = None
    selected_fact_ids: list[str] = Field(default_factory=list, max_length=8)
    introduction: str = Field(default="", max_length=500)


class ClaimInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    consent: Literal[True]
    research_consent: bool = False


@router.post("/invitations")
@limiter.limit("20/day")
async def create_invitation(
    request: Request, body: InvitationInput, token: dict = Depends(require_vault_owner_chat_key)
):
    try:
        return await invitations.create(
            *owner(token),
            body.contact,
            preview_draft_id=body.preview_draft_id,
            selected_fact_ids=body.selected_fact_ids,
            introduction=body.introduction,
            secondary_contact=body.secondary_contact,
            subject_name=body.subject_name,
        )
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
    if body.research_consent and load_pwm_policy()["provider"] in {
        "azure_openai_web_search",
        "azure_openai_tavily",
    }:
        raise HTTPException(422, "Turn on Azure public research in Personal World Model settings.")
    try:
        result = await invitations.claim(*owner(token), body.token)
        if body.research_consent:
            # Claim and consent are explicit; retries reuse the claimed draft/job.
            # The owner's existing email choice is kept.
            current = await preferences.preferences(owner(token)[0])
            if current is None:
                await preferences.enroll_default(*owner(token))
            else:
                await preferences.update_preferences(
                    *owner(token), enabled=True, email_enabled=current["email_enabled"]
                )
            prepared = await world_model_jobs.ensure(*owner(token))
            result["research_started"] = prepared["status"] in {"pending", "paused", "offered"}
        return result
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


# Independent source reviews have their own encrypted draft and completion fence.


@router.post("/source-reviews")
@limiter.limit("3/hour")
async def prepare_sources(
    request: Request,
    body: source_reviews.SourceReviewInput,
    token: dict = Depends(hub_content_chat_owner),
):
    try:
        return await source_reviews.prepare(*owner(token), body)
    except PermissionError:
        raise HTTPException(403, "Verify your contact and unlock your vault.") from None
    except ValueError:
        raise HTTPException(
            422, "Use permitted public source pages. No supported result could be prepared."
        ) from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "Source review is temporarily unavailable.") from None


@router.get("/source-reviews")
async def read_sources(
    request: Request,
    purpose: Literal["owner", "invitation"] = "owner",
    token: dict = Depends(hub_content_chat_owner),
):
    try:
        state = await source_reviews.read(*owner(token))
        return (
            state["result"]
            if state["purpose"] == purpose
            else {"status": "saved", "pkm_written": False}
        )
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except ValueError:
        return {"status": "saved", "pkm_written": False}


@router.delete("/source-reviews")
async def discard_sources(
    request: Request, draft_id: UUID, token: dict = Depends(hub_content_chat_owner)
):
    try:
        await source_reviews.discard(*owner(token), str(draft_id))
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except (ValueError, RuntimeError):
        raise HTTPException(409, "Source draft changed.") from None
    return {"discarded": True}


@router.post("/source-reviews/complete")
async def complete_sources(
    request: Request,
    body: WorldModelCompletion,
    token: dict = Depends(hub_content_chat_owner),
):
    user_id, consent_token = owner(token)
    try:
        state = await source_reviews.read(user_id, consent_token, body.draft_id)
        if state["purpose"] != "owner":
            raise ValueError("Review belongs to an invitation")
        await complete_magic_intelligence(
            user_id,
            [(row.domain, row.plan_id) for row in body.commits],
            verify_only=True,
            max_commits=160,
        )
        await source_reviews.discard(user_id, consent_token, str(body.draft_id))
    except PermissionError:
        raise HTTPException(403, "Unlock your vault to continue.") from None
    except (ValueError, RuntimeError, MagicReviewNotCommitted):
        raise HTTPException(
            409, "Source draft changed or reviewed details have not been saved."
        ) from None
    return {"saved": True}


class PreviewToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


@router.post("/invitation-preview")
@limiter.limit("20/minute")
async def invitation_preview(request: Request, body: PreviewToken):
    try:
        return await invitations.preview(body.token)
    except (ValueError, PermissionError):
        raise HTTPException(404, "This preview is unavailable.") from None


@router.post("/invitations/reject")
@limiter.limit("10/hour")
async def reject_invitation(
    request: Request, body: PreviewToken, token: dict = Depends(require_vault_owner_chat_key)
):
    try:
        return await invitations.reject(*owner(token), body.token)
    except PermissionError:
        raise HTTPException(403, "Verify the invited contact before rejecting.") from None
