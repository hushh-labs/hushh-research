"""Referral program routes for the One product shell.

One authenticated surface for now: the summary the Profile Referrals tab
renders. It is deliberately the only place a slug gets minted, so a person's
link exists the first time they look for it and never before.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.one_referral_service import (
    ReferralProgramDisabled,
    ReferralServiceError,
    bind_attribution,
    get_referral_summary,
    resolve_slug_for_attribution,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/referrals", tags=["One Referrals"])


@router.get("/summary")
async def referral_summary(firebase_uid: str = Depends(require_firebase_auth)):
    """This person's referral link and how their referrals are doing.

    A failure here must never look like a broken Profile: the tab renders its
    own retry state, so the error stays a status code and a short message with
    nothing internal in it.
    """
    try:
        return get_referral_summary(firebase_uid)
    except ReferralProgramDisabled:
        raise HTTPException(status_code=503, detail={"code": "REFERRAL_PROGRAM_OFF"})
    except ReferralServiceError:
        logger.exception("[referrals] summary_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_SUMMARY_FAILED"})
    except Exception:
        logger.exception("[referrals] summary_unexpected")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_SUMMARY_FAILED"})


class ResolveSlugRequest(BaseModel):
    slug: str = Field(..., max_length=128)
    source: str | None = Field(default=None, max_length=64)
    campaign: str | None = Field(default=None, max_length=64)
    landing_route: str | None = Field(default=None, max_length=256)


class BindAttributionRequest(BaseModel):
    attribution_id: str = Field(..., max_length=64)


@router.post("/resolve")
async def resolve_referral_slug(payload: ResolveSlugRequest, request: Request):
    """Open a referral link. Public by necessity -- there is no session yet.

    Answers identically for an invalid slug, a disabled one, and one whose owner
    is gone. A caller must not be able to learn which slugs exist by trying
    them, so there is exactly one negative answer.
    """
    try:
        return resolve_slug_for_attribution(
            payload.slug,
            user_agent=request.headers.get("user-agent"),
            source=payload.source,
            campaign=payload.campaign,
            landing_route=payload.landing_route,
        )
    except Exception:
        logger.exception("[referrals] resolve_failed")
        # Even a server fault answers with the neutral shape: the person can
        # still sign in, they simply arrive unattributed.
        return {"status": "unavailable"}


@router.post("/bind")
async def bind_referral_attribution(
    payload: BindAttributionRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Attach a pending attribution to the person who just signed in."""
    try:
        return bind_attribution(payload.attribution_id, firebase_uid)
    except ReferralProgramDisabled:
        return {"status": "unavailable"}
    except Exception:
        logger.exception("[referrals] bind_failed")
        raise HTTPException(status_code=500, detail={"code": "REFERRAL_BIND_FAILED"})
