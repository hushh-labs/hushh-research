"""Referral program routes for the One product shell.

One authenticated surface for now: the summary the Profile Referrals tab
renders. It is deliberately the only place a slug gets minted, so a person's
link exists the first time they look for it and never before.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from api.middleware import require_firebase_auth
from hushh_mcp.services.one_referral_service import (
    ReferralProgramDisabled,
    ReferralServiceError,
    get_referral_summary,
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
