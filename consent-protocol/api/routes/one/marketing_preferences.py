"""Optional, Firebase-owner-bound email preference, available before vault setup."""

import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services import marketing_preferences as service

router = APIRouter()
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class EmailPreference(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    frequency: Literal["daily", "weekly", "updates"]
    expectedRevision: int = Field(ge=0, le=9_007_199_254_740_991)
    disclosureVersion: Literal["one-email-updates-v1"]
    surface: Literal["setup", "account"]


@router.get("/preferences")
async def read_preference(uid: str = Depends(require_firebase_auth_read_only)):
    try:
        result = await asyncio.wait_for(service.preference(uid), timeout=15)
    except PermissionError:
        raise HTTPException(403, "Account unavailable", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Email preferences unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


@router.put("/preferences")
async def save_preference(
    body: EmailPreference, uid: str = Depends(require_firebase_auth_read_only)
):
    try:
        result = await asyncio.wait_for(
            service.choose_preference(
                uid,
                enabled=body.enabled,
                frequency=body.frequency,
                expected_revision=body.expectedRevision,
                disclosure_version=body.disclosureVersion,
                surface=body.surface,
            ),
            timeout=30,
        )
    except service.VerifiedEmailRequired:
        raise HTTPException(
            409,
            {
                "code": "verified_email_required",
                "message": "Verify your account email before subscribing",
            },
            headers=NO_STORE,
        ) from None
    except service.PreferenceConflict:
        raise HTTPException(
            409,
            {
                "code": "preference_conflict",
                "message": "Email preferences changed; refresh and choose again",
            },
            headers=NO_STORE,
        ) from None
    except PermissionError:
        raise HTTPException(403, "Account unavailable", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(
            503, "Email preference was not confirmed; refresh before retrying", headers=NO_STORE
        ) from None
    return JSONResponse(result, headers=NO_STORE)
