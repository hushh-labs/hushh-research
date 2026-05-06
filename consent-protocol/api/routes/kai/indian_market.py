"""FastAPI router for Indian stock market data.

Endpoints
---------
GET /kai/indian-market/status           — configuration status
GET /kai/indian-market/indices          — Nifty 50, Sensex, Bank Nifty
GET /kai/indian-market/quote/{symbol}   — single equity quote
GET /kai/indian-market/search           — symbol search (NSE/BSE)
GET /kai/indian-market/portfolio        — Zerodha/Upstox holdings (requires credentials)
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from hushh_mcp.adapters.upstox_adapter import UpstoxConfig, UpstoxNotConfiguredError, get_upstox_adapter
from hushh_mcp.adapters.zerodha_kite_adapter import (
    ZerodhaKiteConfig,
    ZerodhaNotConfiguredError,
    get_zerodha_adapter,
)
from hushh_mcp.services.indian_market_service import (
    IndianMarketSettings,
    get_indian_market_service,
    normalize_indian_symbol,
    resolve_spoken_to_symbol,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kai/indian-market", tags=["Indian Market"])


def _settings() -> IndianMarketSettings:
    return IndianMarketSettings.from_env()


# ------------------------------------------------------------------
# Status
# ------------------------------------------------------------------


@router.get("/status")
async def indian_market_status() -> dict[str, Any]:
    """Return configuration status for the Indian market feature."""
    z = ZerodhaKiteConfig.from_env()
    u = UpstoxConfig.from_env()
    return {
        "enabled": True,
        "data_provider": "yfinance",
        "broker_providers": {
            "zerodha": {
                "configured": z.configured,
                "missing": z.to_status()["zerodha_missing"],
            },
            "upstox": {
                "configured": u.configured,
                "missing": u.to_status()["upstox_missing"],
            },
        },
        "note": (
            "yfinance is always active and requires no API key. "
            "Broker features (portfolio, orders) require ZERODHA_API_KEY/UPSTOX_API_KEY."
        ),
    }


# ------------------------------------------------------------------
# Indices
# ------------------------------------------------------------------


@router.get("/indices")
async def indian_market_indices() -> dict[str, Any]:
    """Return real-time Nifty 50, Sensex, and Bank Nifty snapshots."""
    svc = get_indian_market_service()
    indices = await svc.get_indices()
    return {"indices": indices, "count": len(indices)}


# ------------------------------------------------------------------
# Single quote
# ------------------------------------------------------------------


@router.get("/quote/{symbol}")
async def indian_market_quote(symbol: str) -> dict[str, Any]:
    """Return a live quote for an Indian equity.

    ``symbol`` examples: ``RELIANCE``, ``RELIANCE.NS``, ``TCS.BO``.
    Also accepts spoken aliases: ``reliance``, ``hdfc bank``, etc.
    """
    svc = get_indian_market_service()

    # Try spoken alias first
    resolved = resolve_spoken_to_symbol(symbol) or normalize_indian_symbol(symbol)
    quote = await svc.get_quote(resolved)

    if quote.get("error"):
        raise HTTPException(
            status_code=404,
            detail=f"Could not fetch quote for '{symbol}'. Check the symbol and try again.",
        )
    return quote


# ------------------------------------------------------------------
# Search
# ------------------------------------------------------------------


@router.get("/search")
async def indian_market_search(
    q: str = Query(..., min_length=1, description="Search query (symbol or company name)"),
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    """Search NSE/BSE symbols by ticker or company name."""
    svc = get_indian_market_service()
    results = svc.search_symbol(q, limit=limit)
    return {"results": results, "count": len(results), "query": q}


# ------------------------------------------------------------------
# Portfolio (broker-gated)
# ------------------------------------------------------------------


@router.get("/portfolio")
async def indian_market_portfolio(
    broker: str = Query("zerodha", description="Broker: 'zerodha' or 'upstox'"),
) -> dict[str, Any]:
    """Return portfolio holdings from Zerodha or Upstox.

    Requires ZERODHA_API_KEY + ZERODHA_ACCESS_TOKEN  (for broker='zerodha')
    or UPSTOX_API_KEY + UPSTOX_ACCESS_TOKEN           (for broker='upstox').
    """
    broker_lower = broker.strip().lower()

    if broker_lower == "zerodha":
        try:
            adapter = get_zerodha_adapter()
            holdings = await adapter.get_portfolio()
            return {"holdings": holdings, "count": len(holdings), "broker": "zerodha"}
        except ZerodhaNotConfiguredError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except Exception as exc:
            logger.error("[IndianMarket] zerodha portfolio error: %s", exc)
            raise HTTPException(status_code=502, detail="Failed to fetch Zerodha portfolio.") from exc

    if broker_lower == "upstox":
        try:
            adapter = get_upstox_adapter()
            holdings = await adapter.get_portfolio()
            return {"holdings": holdings, "count": len(holdings), "broker": "upstox"}
        except UpstoxNotConfiguredError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except Exception as exc:
            logger.error("[IndianMarket] upstox portfolio error: %s", exc)
            raise HTTPException(status_code=502, detail="Failed to fetch Upstox portfolio.") from exc

    raise HTTPException(
        status_code=400,
        detail=f"Unknown broker '{broker}'. Supported: 'zerodha', 'upstox'.",
    )
