"""iAlphabets internal scoring and season rollover routes.

Protected by X-Internal-Token header (not vault owner tokens).
"""

from __future__ import annotations

import logging
import os
from datetime import date

from fastapi import APIRouter, Header, HTTPException

from hushh_mcp.services.ialphabets_scoring_service import IalphabetsScoringService

logger = logging.getLogger(__name__)
router = APIRouter()

_scoring = IalphabetsScoringService()

INTERNAL_TOKEN = os.getenv("IALPHABETS_INTERNAL_TOKEN", "")


def _require_internal_token(x_internal_token: str = Header(...)) -> None:
    if not INTERNAL_TOKEN or x_internal_token != INTERNAL_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid internal token")


@router.post("/scoring/run-daily")
async def run_daily_scoring(x_internal_token: str = Header(...)):
    _require_internal_token(x_internal_token)
    result = await _scoring.run_daily_snapshot(as_of_date=date.today())
    logger.info("Daily scoring complete: %s", result)
    return result


@router.post("/scoring/rollover-seasons")
async def rollover_seasons(x_internal_token: str = Header(...)):
    _require_internal_token(x_internal_token)
    result = _scoring.rollover_seasons()
    logger.info("Season rollover complete: %s", result)
    return result
