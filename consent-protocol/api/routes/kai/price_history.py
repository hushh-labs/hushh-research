"""Bounded public stock history, separate from a person's holdings and spot quote."""

import math
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.operons.kai.fetchers import fetch_market_session_history
from hushh_mcp.services.market_provider_telemetry import (
    degraded_provider_resources,
    finish_provider_call_counts,
    start_provider_call_counts,
)
from hushh_mcp.services.market_refresh_policy import us_market_is_open
from hushh_mcp.services.symbol_master_service import get_symbol_master_service

router = APIRouter()


@router.get("/market/history/{user_id}")
async def get_stock_price_history(
    user_id: Annotated[str, Path(min_length=1, max_length=128)],
    symbol: Annotated[str, Query(pattern=r"^[A-Z][A-Z0-9.-]{0,15}$")],
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """Observed month of daily closes; never synthesize intraday observations."""
    verify_user_id_match(firebase_uid, user_id)
    metadata = get_symbol_master_service().get_ticker_metadata(symbol)
    if not metadata or str(metadata.get("exchange") or "").upper() not in {
        "NASDAQ",
        "NYSE",
        "AMEX",
        "NYSE AMERICAN",
        "NYSE ARCA",
        "CBOE",
        "BATS",
    }:
        raise HTTPException(status_code=422, detail="Select a supported US-listed stock.")
    # Use the existing shared L1/L2 owner, including its per-key single flight.
    from .market_insights import _get_or_refresh_public_module

    async def load() -> dict[str, Any]:
        # This also guards closed-market cold misses and background revalidations.
        if not us_market_is_open():
            raise RuntimeError("Prices are paused outside the regular session")
        token = start_provider_call_counts()
        try:
            history = await fetch_market_session_history([symbol])
            if degraded_provider_resources():
                raise RuntimeError("Provider history is cached after a failed refresh")
        finally:
            finish_provider_call_counts(token)
        points = [
            {"t": float(point["t"]), "p": float(point["p"])}
            for point in history.get(symbol, [])
            if all(
                isinstance(point.get(key), (int, float))
                and not isinstance(point[key], bool)
                and math.isfinite(point[key])
                and point[key] > 0
                for key in ("t", "p")
            )
        ][-32:]
        if len(points) < 2:
            raise RuntimeError("Observed history is unavailable")
        return {"points": points, "retrieved_at": datetime.now(timezone.utc).isoformat()}

    try:
        value, stale, *_ = await _get_or_refresh_public_module(
            key=f"stock_history:v1:{symbol}:1mo",
            fresh_ttl_seconds=120,
            stale_ttl_seconds=7 * 24 * 60 * 60,
            fetcher=load,
            warm_source="stock_history",
            serve_stale_while_revalidate=False,
        )
    except Exception:
        value, stale = {"points": [], "retrieved_at": None}, True
    return {
        "symbol": symbol,
        "currency": "USD",
        "interval": "1d",
        "points": value["points"],
        "retrieved_at": value["retrieved_at"],
        "stale": stale or not us_market_is_open(),
        "unavailable": len(value["points"]) < 2,
    }
