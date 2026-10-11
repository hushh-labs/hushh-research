"""Ephemeral profile draft for One chat, admitted like other background cards."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middlewares.chat_key import require_vault_owner_chat_key
from api.middlewares.rate_limit import limiter
from api.utils.private_no_store import PRIVATE_NO_STORE_HEADERS, PrivateNoStoreRoute
from hushh_mcp.services.magic_intelligence_completion import (
    MagicReviewNotCommitted,
    complete_magic_intelligence,
)
from hushh_mcp.services.owner_placement_guard import hub_content_chat_owner
from hushh_mcp.services.profile_research_service import offer_profile_research


class PrivateProfileRoute(PrivateNoStoreRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                return JSONResponse(
                    {"detail": "Invalid reviewed receipts."},
                    status_code=422,
                    headers=PRIVATE_NO_STORE_HEADERS,
                )

        return private_handler


router = APIRouter(prefix="/api/one", tags=["Agent One"], route_class=PrivateProfileRoute)


class MagicReviewCommit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    domain: str = Field(min_length=1, max_length=120)
    plan_id: str = Field(min_length=1, max_length=160)


class MagicReviewCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commits: list[MagicReviewCommit] = Field(min_length=1, max_length=64)


@router.post("/profile-research/complete")
@limiter.limit("10/minute")
async def profile_review_complete(
    request: Request,
    body: MagicReviewCompletion,
    token: dict = Depends(require_vault_owner_chat_key),
):
    owner_id = token.get("user_id")
    if not owner_id:
        raise HTTPException(status_code=403, detail="Unlock your vault to continue.")
    try:
        await asyncio.wait_for(
            complete_magic_intelligence(
                owner_id, [(row.domain, row.plan_id) for row in body.commits]
            ),
            timeout=10,
        )
    except MagicReviewNotCommitted:
        raise HTTPException(
            status_code=409, detail="Reviewed details have not all been confirmed."
        ) from None
    except Exception:
        return JSONResponse(
            {"detail": "Completion could not be confirmed. Retry the saved review."},
            status_code=503,
            headers={"Retry-After": "5"},
        )
    return JSONResponse({"saved": True})


@router.post("/profile-research")
@limiter.limit("3/hour")
async def profile_research(request: Request, token: dict = Depends(hub_content_chat_owner)):
    owner_id, owner_token = token.get("user_id"), token.get("token")
    if not owner_id or not owner_token:
        raise HTTPException(status_code=403, detail="Unlock your vault to continue.")
    try:
        result = await asyncio.wait_for(
            offer_profile_research(user_id=owner_id, consent_token=owner_token), timeout=40
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="Unlock your vault to continue.") from None
    except Exception:  # Provider text and identifiers never enter errors or logs.
        result = {"status": "unavailable", "pkm_written": False}
    return JSONResponse(result)
