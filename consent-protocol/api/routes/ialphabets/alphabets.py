"""iAlphabets draft and alphabet management routes."""

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


class PickRequest(BaseModel):
    letter: str = Field(..., min_length=1, max_length=1, pattern=r"^[A-Za-z]$")
    ticker: str = Field(..., min_length=1, max_length=10)
    company_name: str = Field(default="")


class SwapRequest(BaseModel):
    letter: str = Field(..., min_length=1, max_length=1, pattern=r"^[A-Za-z]$")
    new_ticker: str = Field(..., min_length=1, max_length=10)
    new_company_name: str = Field(default="")


@router.post("/leagues/{league_id}/alphabet/draft")
async def start_draft(
    league_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        alpha = _svc.ensure_draft(league_id, token_data["user_id"])
        return alpha
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/leagues/{league_id}/alphabet/pick")
async def upsert_pick(
    league_id: str,
    body: PickRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    alpha = _svc.get_alphabet_with_picks(league_id, token_data["user_id"])
    if not alpha:
        raise HTTPException(status_code=404, detail="No draft found. Start a draft first.")
    try:
        pick = _svc.upsert_draft_pick(
            alphabet_id=alpha["id"],
            letter=body.letter,
            ticker=body.ticker,
            company_name=body.company_name,
        )
        return pick
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/leagues/{league_id}/alphabet/finalize")
async def finalize_alphabet(
    league_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    alpha = _svc.get_alphabet_with_picks(league_id, token_data["user_id"])
    if not alpha:
        raise HTTPException(status_code=404, detail="No draft found")
    try:
        result = _svc.finalize_alphabet(alpha["id"])
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/leagues/{league_id}/alphabet/swap")
async def swap_pick(
    league_id: str,
    body: SwapRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    alpha = _svc.get_alphabet_with_picks(league_id, token_data["user_id"])
    if not alpha:
        raise HTTPException(status_code=404, detail="No alphabet found")
    try:
        result = _svc.swap_pick(
            alphabet_id=alpha["id"],
            letter=body.letter,
            new_ticker=body.new_ticker,
            new_company_name=body.new_company_name,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/leagues/{league_id}/alphabet")
async def get_my_alphabet(
    league_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    alpha = _svc.get_alphabet_with_picks(league_id, token_data["user_id"])
    if not alpha:
        raise HTTPException(status_code=404, detail="No alphabet found")
    return alpha


@router.get("/tickers/by-letter/{letter}")
async def search_tickers_by_letter(
    letter: str,
    q: Optional[str] = Query(default=""),
    limit: int = Query(default=25, ge=1, le=100),
):
    return {"tickers": _svc.search_tickers_by_letter(letter, q or "", limit)}
