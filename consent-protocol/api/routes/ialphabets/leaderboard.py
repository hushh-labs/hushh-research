"""iAlphabets leaderboard routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from hushh_mcp.services.ialphabets_service import IalphabetsService

logger = logging.getLogger(__name__)
router = APIRouter()

_svc = IalphabetsService()


@router.get("/leagues/{league_id}/leaderboard")
async def get_leaderboard(league_id: str):
    rows = _svc.get_leaderboard(league_id)
    return {"rows": rows, "league_id": league_id}


@router.get("/leagues/{league_id}/leaderboard/history")
async def get_leaderboard_history(league_id: str):
    series = _svc.get_leaderboard_history(league_id)
    return {"series": series, "league_id": league_id}
