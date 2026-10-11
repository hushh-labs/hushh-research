"""Ephemeral profile draft for One chat, admitted like other background cards."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from api.middlewares.chat_key import require_vault_owner_chat_key
from api.middlewares.rate_limit import limiter
from api.utils.private_no_store import PrivateNoStoreRoute
from hushh_mcp.services.profile_research_service import offer_profile_research

router = APIRouter(prefix="/api/one", tags=["Agent One"], route_class=PrivateNoStoreRoute)


@router.post("/profile-research")
@limiter.limit("3/hour")
async def profile_research(request: Request, token: dict = Depends(require_vault_owner_chat_key)):
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
