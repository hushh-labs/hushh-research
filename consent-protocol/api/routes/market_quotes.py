"""
Public batch market quotes.

    GET /api/market/quotes?symbols=AAPL,MSFT,BRK-B

WHY THIS EXISTS. Market quotes are public provider data — `fetch_market_data` says exactly that,
the L1/L2 cache key carries no user, and `fetch_market_data_batch` takes `consent_token=None`. The
data layer was always common; only the doors onto it were user-scoped, so the Hushh Tech marquee
had no way in and grew its own Yahoo client instead. Two implementations of one cache is the thing
worth removing, so this is the shared door: one warm cache serving both Cloud Run services.

WHAT IT REUSES, rather than restating:

  - `_get_or_refresh_public_module` for the read order — L1 memory (MarketInsightsCache), then L2
    Postgres (`kai_market_cache_entries`), then live providers with write-through to both. L2 is
    what makes this genuinely shared: two services, and every instance of each, warm the same rows.
  - The `quotes:` key prefix, already registered in MARKET_PRICE_SENSITIVE_PREFIXES, so the fresh
    window is 120s while the US session is scheduled open and 1800s when it is closed. The cadence
    is not restated here; it is inherited.
  - `fetch_market_data_batch` for the provider ladder and its cooldowns.

No consent token, deliberately and narrowly: this returns prices for symbols the caller names and
nothing derived from anyone's holdings, picks or vault. It is the same public posture as
`/api/tickers/search`. Anything user-shaped stays on the authenticated routes where it belongs.
"""

import hashlib
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from api.routes.kai.market_insights import _get_or_refresh_public_module
from hushh_mcp.operons.kai.fetchers import fetch_market_data_batch
from hushh_mcp.types import UserID

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/market", tags=["Market (Public)"])

# A public endpoint that fans out per symbol is an amplifier if it is unbounded. The Hushh Tech
# marquee asks for 27.
MAX_SYMBOLS = 50

# Anything longer is not a ticker. Bounds the work before any of it reaches a provider.
MAX_SYMBOL_LENGTH = 16

# Audit identity for the shared path. There is no person behind a marquee render, and passing a
# real user id would imply one.
PUBLIC_AUDIENCE = UserID("public-market-quotes")

# The fetcher applies the market-aware window itself; these are the outer bounds handed to the
# module cache. Stale is generous on purpose — serving a quote a few minutes old beats serving a
# blank strip when a provider is in cooldown.
FRESH_TTL_SECONDS = 120
STALE_TTL_SECONDS = 3_600


def normalize_symbols(raw: str) -> list[str]:
    """Upper-case, de-duplicated, order-preserving, and bounded.

    Order is preserved so the caller's strip renders in the order it asked for, and the cache key
    below sorts separately — two callers asking for the same set in different orders should share
    one cache entry rather than warming two.
    """
    seen: dict[str, None] = {}
    for chunk in str(raw or "").split(","):
        symbol = chunk.strip().upper()
        if not symbol or len(symbol) > MAX_SYMBOL_LENGTH:
            continue
        # Letters, digits, and the separators real tickers use: BRK-B, 2222.SR, 601939.SS.
        if not all(char.isalnum() or char in {".", "-", "^", "="} for char in symbol):
            continue
        seen.setdefault(symbol, None)
    return list(seen)[:MAX_SYMBOLS]


def quotes_cache_key(symbols: list[str]) -> str:
    """A stable key for a symbol set, under the price-sensitive `quotes:` prefix.

    Hashed rather than joined: the raw list would make a key hundreds of characters long, and the
    cache key is a Postgres primary key.
    """
    digest = hashlib.sha256(",".join(sorted(symbols)).encode("utf-8")).hexdigest()[:32]
    return f"quotes:public:batch:{digest}"


@router.get("/quotes")
async def public_market_quotes(
    symbols: str = Query(..., min_length=1, max_length=1_024, description="Comma-separated tickers"),
) -> dict[str, Any]:
    requested = normalize_symbols(symbols)
    if not requested:
        raise HTTPException(status_code=400, detail="No valid ticker symbols were provided.")

    async def load() -> dict[str, Any]:
        quotes = await fetch_market_data_batch(requested, PUBLIC_AUDIENCE, None)
        return {"quotes": quotes if isinstance(quotes, dict) else {}}

    try:
        payload, _refreshed, age_seconds, cache_tier, cache_hit = await _get_or_refresh_public_module(
            key=quotes_cache_key(requested),
            fresh_ttl_seconds=FRESH_TTL_SECONDS,
            stale_ttl_seconds=STALE_TTL_SECONDS,
            fetcher=load,
            warm_source="public_quotes",
        )
    except Exception:
        logger.error("market.public_quotes.error", exc_info=True)
        raise HTTPException(status_code=503, detail="Market quotes are temporarily unavailable.")

    resolved = payload.get("quotes") if isinstance(payload, dict) else {}
    resolved = resolved if isinstance(resolved, dict) else {}

    # The caller's order, and only symbols that actually resolved. A row with no price is omitted
    # rather than zero-filled: a rendered zero is indistinguishable from a real one.
    rows = [
        {
            "symbol": symbol,
            "price": float(resolved[symbol].get("price") or 0),
            "change_percent": float(resolved[symbol].get("change_percent") or 0),
            "company_name": resolved[symbol].get("company_name") or symbol,
            "source": resolved[symbol].get("source") or "Unknown",
        }
        for symbol in requested
        if isinstance(resolved.get(symbol), dict) and float(resolved[symbol].get("price") or 0) > 0
    ]

    return {
        "success": bool(rows),
        "quotes": rows,
        "count": len(rows),
        "requested": len(requested),
        "cache": {"tier": cache_tier, "hit": bool(cache_hit), "age_seconds": int(age_seconds)},
    }
