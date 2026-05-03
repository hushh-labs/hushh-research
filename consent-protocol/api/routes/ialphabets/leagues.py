"""iAlphabets league management routes."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.ialphabets_service import IalphabetsService

logger = logging.getLogger(__name__)
router = APIRouter()

_svc = IalphabetsService()


class CreateLeagueRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    privacy: str = Field(default="private", pattern=r"^(private|public)$")
    max_members: int = Field(default=50, ge=2, le=50)


@router.get("/seasons/active")
async def get_active_season():
    season = _svc.get_active_season()
    if not season:
        raise HTTPException(status_code=404, detail="No active season")
    return season


@router.post("/leagues")
async def create_league(
    body: CreateLeagueRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = token_data["user_id"]
    try:
        league = _svc.create_league(
            owner_user_id=user_id,
            name=body.name,
            privacy=body.privacy,
            max_members=body.max_members,
        )
        return league
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/leagues/mine")
async def list_my_leagues(
    token_data: dict = Depends(require_vault_owner_token),
):
    return {"leagues": _svc.list_user_leagues(token_data["user_id"])}


@router.get("/leagues/public")
async def list_public_leagues(
    limit: int = Query(default=20, ge=1, le=50),
    cursor: Optional[str] = Query(default=None),
):
    return _svc.list_public_leagues(limit=limit, cursor=cursor)


@router.get("/leagues/{league_id}")
async def get_league(
    league_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    detail = _svc.get_league_detail(league_id, user_id=token_data["user_id"])
    if not detail:
        raise HTTPException(status_code=404, detail="League not found")
    return detail


@router.delete("/leagues/{league_id}")
async def close_league(
    league_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    ok = _svc.close_league(league_id, token_data["user_id"])
    if not ok:
        raise HTTPException(status_code=403, detail="Not allowed or league already closed")
    return {"status": "closed"}
