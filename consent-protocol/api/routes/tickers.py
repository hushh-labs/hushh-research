"""
Ticker search routes (public)

GET /api/tickers/search?q=...&limit=10
"""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.ticker_cache import ticker_cache
from hushh_mcp.services.ticker_db import TickerDBService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tickers", tags=["Tickers (Public)"])


class SyncHoldingsRequest(BaseModel):
    """User-holdings driven ticker ETL request payload."""

    holdings: list[dict] = Field(default_factory=list)
    max_symbols: int = Field(default=200, ge=1, le=1000)
    enrich_missing: bool = Field(default=True)
    refresh_cache: bool = Field(default=True)


@router.get("/search", response_model=List[dict])
async def search_tickers(q: str = Query(..., min_length=1), limit: int = Query(10, ge=1, le=100)):
    """Search for tickers by symbol prefix or company name."""
    try:
        # Serve from memory when available.
        if ticker_cache.loaded:
            return ticker_cache.search(q, limit=limit)

        # Startup race fallback: hit DB directly.
        service = TickerDBService()
        results = await service.search_tickers(q, limit=limit)
        return results
    except Exception as e:
        logger.error(f"Error searching tickers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/all", response_model=List[dict])
async def all_tickers(refresh: bool = Query(False)):
    """Return the full ticker universe (cached in memory when available)."""
    try:
        if refresh or not ticker_cache.loaded:
            # Reload on demand (after metadata enrichment), otherwise load once per process.
            ticker_cache.load_from_db()

        return ticker_cache.all()
    except Exception as e:
        logger.error(f"Error returning all tickers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/cache-status")
async def ticker_cache_status():
    """Debug endpoint: confirms cache size and load time."""
    return {
        "loaded": ticker_cache.loaded,
        "size": ticker_cache.size(),
        "loaded_at": ticker_cache.loaded_at,
    }


@router.post("/sync-holdings/{user_id}", response_model=dict)
async def sync_tickers_from_holdings(
    user_id: str,
    request: SyncHoldingsRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    ETL symbols from decrypted PKM holdings into ticker master metadata.

    Protected by VAULT_OWNER token because holdings are user-sensitive input.
    """
    if token_data.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Token user_id does not match request user_id")

    try:
        service = TickerDBService()
        result = await service.sync_holdings_symbols(
            request.holdings,
            max_symbols=request.max_symbols,
            enrich_missing=request.enrich_missing,
            refresh_cache=request.refresh_cache,
        )
        return {"success": True, **result}
    except Exception as e:
        logger.error("Error syncing tickers from holdings for %s: %s", user_id, e)
        raise HTTPException(status_code=500, detail=str(e))
