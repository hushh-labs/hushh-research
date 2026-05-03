"""iAlphabets invite and referral routes."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.ialphabets_service import IalphabetsService

logger = logging.getLogger(__name__)
router = APIRouter()

_svc = IalphabetsService()


class CreateInviteRequest(BaseModel):
    league_id: Optional[str] = None
    kind: str = Field(default="league", pattern=r"^(league|referral)$")


@router.post("/invites")
async def create_invite(
    body: CreateInviteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    invite = _svc.create_invite(
        inviter_user_id=token_data["user_id"],
        league_id=body.league_id,
        kind=body.kind,
    )
    return invite


@router.get("/invites/{code}")
async def get_invite_preview(code: str):
    preview = _svc.get_invite_preview(code)
    if not preview:
        raise HTTPException(status_code=404, detail="Invalid invite code")
    return preview


@router.post("/invites/{code}/redeem")
async def redeem_invite(
    code: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        result = _svc.redeem_invite(code, token_data["user_id"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
