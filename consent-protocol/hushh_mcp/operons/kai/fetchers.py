# hushh_mcp/operons/kai/fetchers.py

"""
Kai Fetcher Operons

External data retrieval with per-source consent validation.
Each fetcher validates a specific consent token scope for the data source.

Runtime provider priority (for realtime market/news flows):
1) Finnhub
2) PMP (Financial Modeling Prep)
3) Existing free/public fallbacks (NewsAPI/Google RSS, yfinance/Yahoo)
"""

import asyncio
import logging
import math
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from defusedxml import ElementTree as DefusedET

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.fmp_call_budget import is_budget_critical, record_fmp_call
from hushh_mcp.services.market_provider_telemetry import record_provider_request
from hushh_mcp.services.market_refresh_policy import (
    US_MARKET_OPEN_CACHE_TTL_SECONDS,
    provider_quote_cache_ttl_seconds,
    us_market_session_opened_at,
)
from hushh_mcp.types import UserID

logger = logging.getLogger(__name__)
_PROVIDER_COOLDOWNS: dict[str, float] = {}
_PROVIDER_COOLDOWNS_LOCK = threading.RLock()
_PROVIDER_COOLDOWNS_MAX = max(
    1,
    int(os.getenv("KAI_PROVIDER_COOLDOWNS_MAX", "1000") or "1000"),
)
_PROVIDER_COOLDOWN_BY_STATUS: dict[int, int] = {
    401: 15 * 60,
    402: 15 * 60,
    403: 10 * 60,
    404: 20 * 60,
    429: 5 * 60,
}


@dataclass(frozen=True)
class _MarketDataCacheEntry:
    expires_at: float
    fetched_at: float
    payload: Dict[str, Any]


_MARKET_DATA_CACHE: dict[str, _MarketDataCacheEntry] = {}
_MARKET_DATA_LOCKS: dict[str, asyncio.Lock] = {}
_MARKET_DATA_CACHE_LOCK = threading.RLock()
_MARKET_DATA_CACHE_MAX = max(
    1,
    int(os.getenv("KAI_MARKET_DATA_CACHE_MAX", "5000") or "5000"),
)
_MARKET_DATA_LOCKS_MAX = max(
    1,
    int(os.getenv("KAI_MARKET_DATA_LOCKS_MAX", "10000") or "10000"),
)
_MARKET_DATA_CACHE_TTL_SECONDS = max(
    60,
    int(os.getenv("KAI_MARKET_DATA_CACHE_TTL_SECONDS", "600") or "600"),
)
_YFINANCE_TIMEOUT_COOLDOWN_SECONDS = max(
    60,
    int(os.getenv("KAI_YFINANCE_TIMEOUT_COOLDOWN_SECONDS", "180") or "180"),
)
_YAHOO_FAST_TIMEOUT_SECONDS = max(
    3.0,
    float(os.getenv("KAI_YAHOO_FAST_TIMEOUT_SECONDS", "8") or "8"),
)
_YAHOO_FAST_TIMEOUT_COOLDOWN_SECONDS = max(
    60,
    int(os.getenv("KAI_YAHOO_FAST_TIMEOUT_COOLDOWN_SECONDS", "180") or "180"),
)
# The chart endpoint takes one symbol per request, so a batch fans out. Bounded so a 27-symbol
# marquee finishes quickly without arriving at Yahoo as a burst.
_YAHOO_CHART_CONCURRENCY = max(
    1,
    int(os.getenv("KAI_YAHOO_CHART_CONCURRENCY", "6") or "6"),
)


def _drop_expired_provider_cooldowns_locked(now: float) -> None:
    expired_keys = [key for key, until in _PROVIDER_COOLDOWNS.items() if until <= now]
    for key in expired_keys:
        _PROVIDER_COOLDOWNS.pop(key, None)


def _provider_in_cooldown(key: str) -> bool:
    now = time.time()
    with _PROVIDER_COOLDOWNS_LOCK:
        until = _PROVIDER_COOLDOWNS.get(key)
        if until is None:
            return False
        if until <= now:
            _PROVIDER_COOLDOWNS.pop(key, None)
            return False
        return True


def _set_provider_cooldown(key: str, duration_seconds: int) -> None:
    if duration_seconds <= 0:
        return
    now = time.time()
    with _PROVIDER_COOLDOWNS_LOCK:
        _drop_expired_provider_cooldowns_locked(now)
        if key not in _PROVIDER_COOLDOWNS:
            while len(_PROVIDER_COOLDOWNS) >= _PROVIDER_COOLDOWNS_MAX:
                _PROVIDER_COOLDOWNS.pop(next(iter(_PROVIDER_COOLDOWNS)), None)
        _PROVIDER_COOLDOWNS[key] = now + int(duration_seconds)


def _mark_provider_cooldown(key: str, status_code: int | None) -> None:
    if status_code is None:
        return
    duration = _PROVIDER_COOLDOWN_BY_STATUS.get(int(status_code))
    if not duration:
        return
    _set_provider_cooldown(key, duration)


def _mark_provider_cooldown_for_duration(key: str, duration_seconds: int) -> None:
    _set_provider_cooldown(key, duration_seconds)


def _provider_cooldown_key(provider_name: str, symbol: str) -> str | None:
    if provider_name == "yfinance":
        return f"yfinance:{symbol}"
    if provider_name == "yahoo_quote_fast":
        return "yahoo_quote_fast:global"
    if provider_name == "finnhub":
        return "finnhub:global"
    if provider_name == "pmp":
        return "pmp:global"
    return None


def _market_data_cache_key(symbol: str, *, finnhub_enabled: bool, pmp_enabled: bool) -> str:
    return f"{symbol}|fh:{int(finnhub_enabled)}|pmp:{int(pmp_enabled)}"


def _get_market_data_lock(cache_key: str) -> asyncio.Lock:
    with _MARKET_DATA_CACHE_LOCK:
        lock = _MARKET_DATA_LOCKS.get(cache_key)
        if lock is None:
            now = time.time()
            stale_keys = []
            for key, existing_lock in _MARKET_DATA_LOCKS.items():
                cached = _MARKET_DATA_CACHE.get(key)
                expired = cached is not None and cached.expires_at <= now
                if not existing_lock.locked() and (cached is None or expired):
                    stale_keys.append(key)
            for key in stale_keys:
                _MARKET_DATA_LOCKS.pop(key, None)
                cached = _MARKET_DATA_CACHE.get(key)
                if cached is not None and cached.expires_at <= now:
                    _MARKET_DATA_CACHE.pop(key, None)
            while len(_MARKET_DATA_LOCKS) >= _MARKET_DATA_LOCKS_MAX:
                evicted = False
                for key, existing_lock in list(_MARKET_DATA_LOCKS.items()):
                    if not existing_lock.locked():
                        _MARKET_DATA_LOCKS.pop(key, None)
                        evicted = True
                        break
                if not evicted:
                    break
            lock = asyncio.Lock()
            _MARKET_DATA_LOCKS[cache_key] = lock
        return lock


def _get_cached_market_data(cache_key: str) -> Dict[str, Any] | None:
    now = time.time()
    opened_at = us_market_session_opened_at(datetime.fromtimestamp(now, tz=timezone.utc))
    with _MARKET_DATA_CACHE_LOCK:
        cached = _MARKET_DATA_CACHE.get(cache_key)
        if not cached:
            return None
        if cached.expires_at <= now or (
            opened_at is not None
            and (
                cached.fetched_at < opened_at
                or now - cached.fetched_at >= US_MARKET_OPEN_CACHE_TTL_SECONDS
            )
        ):
            _MARKET_DATA_CACHE.pop(cache_key, None)
            return None
        return dict(cached.payload)


def _drop_expired_market_data_locked(now: float) -> None:
    expired_keys = [key for key, cached in _MARKET_DATA_CACHE.items() if cached.expires_at <= now]
    for key in expired_keys:
        _MARKET_DATA_CACHE.pop(key, None)


def _set_cached_market_data(
    cache_key: str, payload: Dict[str, Any], ttl_seconds: int, requested_at: float | None = None
) -> None:
    ttl = max(60, int(ttl_seconds))
    with _MARKET_DATA_CACHE_LOCK:
        now = time.time()
        if cache_key not in _MARKET_DATA_CACHE:
            _drop_expired_market_data_locked(now)
            while len(_MARKET_DATA_CACHE) >= _MARKET_DATA_CACHE_MAX:
                _MARKET_DATA_CACHE.pop(next(iter(_MARKET_DATA_CACHE)), None)
        # A request spanning the opening must not make a pre-open quote look
        # newly fetched merely because its response arrived after 09:30.
        _MARKET_DATA_CACHE[cache_key] = _MarketDataCacheEntry(
            now + ttl, now if requested_at is None else requested_at, dict(payload)
        )


class RealtimeDataUnavailable(RuntimeError):
    """Raised when a required realtime external signal is unavailable."""

    code = "REALTIME_DATA_UNAVAILABLE"

    def __init__(self, source: str, detail: str, *, retryable: bool = True):
        super().__init__(detail)
        self.source = source
        self.detail = detail
        self.retryable = retryable

    def to_payload(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "source": self.source,
            "detail": self.detail,
            "retryable": self.retryable,
        }


async def _fetch_yahoo_quote_fast(ticker: str) -> Dict[str, Any]:
    """
    Fast market-data fallback using Yahoo's public quote endpoint.

    Rationale: `yfinance` is synchronous and can hang in some Cloud Run environments.
    This endpoint is lighter-weight and has explicit timeouts.

    NOTE: This is public market data (no user data). Consent is still enforced by the caller.
    """
    if _provider_in_cooldown("yahoo_quote_fast:global"):
        raise RuntimeError("yahoo_quote_fast_provider_cooldown")
    url = "https://query1.finance.yahoo.com/v7/finance/quote"
    params = {"symbols": ticker.upper()}
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}

    timeout = httpx.Timeout(connect=3.0, read=4.0, write=4.0, pool=3.0)
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        try:
            res = await asyncio.wait_for(
                client.get(url, params=params),
                timeout=_YAHOO_FAST_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            _mark_provider_cooldown_for_duration(
                "yahoo_quote_fast:global",
                _YAHOO_FAST_TIMEOUT_COOLDOWN_SECONDS,
            )
            raise RuntimeError("yahoo_quote_fast_timeout") from exc
        if not res.is_success:
            _mark_provider_cooldown("yahoo_quote_fast:global", res.status_code)
        res.raise_for_status()
        data = res.json() or {}
        results = ((data.get("quoteResponse") or {}).get("result")) or []
        if not results:
            return {}

        q = results[0] or {}

        # Map a minimal common subset
        return {
            "ticker": ticker.upper(),
            "price": q.get("regularMarketPrice") or 0,
            "change_percent": q.get("regularMarketChangePercent"),
            "volume": q.get("regularMarketVolume"),
            "market_cap": q.get("marketCap") or 0,
            "pe_ratio": q.get("trailingPE") or 0,
            "pb_ratio": q.get("priceToBook") or 0,
            "dividend_yield": q.get("trailingAnnualDividendYield"),
            "company_name": q.get("longName") or q.get("shortName") or ticker.upper(),
            "instrument_type": q.get("quoteType"),
            # Sector/industry often not present in quote endpoint; keep best-effort.
            "sector": q.get("sector") or "Unknown",
            "industry": q.get("industry") or "Unknown",
            "source": "Yahoo Quote (Fast)",
            "fetched_at": datetime.utcnow().isoformat(),
            "ttl_seconds": 60,
            "is_stale": False,
        }


def _parse_google_news_rss(xml_text: str, ticker: str) -> List[Dict[str, Any]]:
    """Parse Google News RSS payload into normalized article dictionaries."""
    if not xml_text.strip():
        return []

    try:
        root = DefusedET.fromstring(xml_text)
    except DefusedET.ParseError:
        logger.warning("Skipping malformed Google News RSS payload for %s", ticker)
        return []
    items: list[Dict[str, Any]] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        published_at = (item.findtext("pubDate") or "").strip()
        source_name = "Google News"
        source_node = item.find("source")
        if source_node is not None and (source_node.text or "").strip():
            source_name = (source_node.text or "").strip()

        if not title or not link:
            continue

        items.append(
            {
                "title": title,
                "description": None,
                "url": link,
                "publishedAt": published_at or None,
                "source": {"name": source_name},
                "provider": "google_news_rss",
            }
        )
    return items


def _newsapi_key() -> str:
    return (os.getenv("NEWSAPI_KEY") or "").strip()


def _finnhub_api_key() -> str:
    return (os.getenv("FINNHUB_API_KEY") or "").strip()


def _pmp_api_key() -> str:
    # Support both explicit aliases.
    return (os.getenv("PMP_API_KEY") or os.getenv("FMP_API_KEY") or "").strip()


async def _fetch_newsapi_articles(ticker: str, days_back: int) -> List[Dict[str, Any]]:
    api_key = _newsapi_key()
    if not api_key:
        return []

    since = (datetime.utcnow() - timedelta(days=max(1, days_back))).date().isoformat()
    params = {
        "q": f"{ticker} stock",
        "sortBy": "publishedAt",
        "language": "en",
        "pageSize": "25",
        "from": since,
        "apiKey": api_key,
    }
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout
    ) as client:
        res = await client.get("https://newsapi.org/v2/everything", params=params)
        res.raise_for_status()
        payload = res.json() or {}
        rows = payload.get("articles") or []
        articles: list[Dict[str, Any]] = []
        for row in rows:
            title = str(row.get("title") or "").strip()
            url = str(row.get("url") or "").strip()
            if not title or not url:
                continue
            articles.append(
                {
                    "title": title,
                    "description": str(row.get("description") or "").strip(),
                    "url": url,
                    "publishedAt": row.get("publishedAt") or None,
                    "source": {"name": str((row.get("source") or {}).get("name") or "NewsAPI")},
                    "provider": "newsapi",
                    "image_url": row.get("urlToImage"),
                }
            )
        return articles


async def _fetch_google_news_rss(ticker: str, days_back: int) -> List[Dict[str, Any]]:
    query = urllib.parse.quote_plus(f"{ticker} stock when:{max(1, days_back)}d")
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        res = await client.get(url)
        res.raise_for_status()
        return _parse_google_news_rss(res.text or "", ticker)


def _provider_error(provider: str, exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{provider}:http_{exc.response.status_code}"
    return f"{provider}:{type(exc).__name__}"


def _emit_realtime_telemetry(event: str, **fields: Any) -> None:
    """
    Emit structured telemetry for realtime provider reliability.

    This intentionally logs compact JSON-like dictionaries so downstream log sinks
    can aggregate p50/p95 latencies, source failures, and staleness rates.
    """
    payload = {"event": event, **fields}
    logger.info("[RealtimeTelemetry] %s", payload)


async def _fetch_finnhub_quote(ticker: str) -> Dict[str, Any]:
    api_key = _finnhub_api_key()
    if not api_key:
        raise RuntimeError("FINNHUB_API_KEY not configured")

    symbol = ticker.upper().strip()
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        quote_res = await client.get(
            "https://finnhub.io/api/v1/quote", params={"symbol": symbol, "token": api_key}
        )
        quote_res.raise_for_status()
        quote = (quote_res.json() if quote_res.content else {}) or {}

        price = float(quote.get("c") or 0)
        if price <= 0:
            raise ValueError(f"invalid Finnhub quote payload for {symbol}")

        profile = {}
        profile_res = await client.get(
            "https://finnhub.io/api/v1/stock/profile2",
            params={"symbol": symbol, "token": api_key},
        )
        profile_res.raise_for_status()
        profile = (profile_res.json() if profile_res.content else {}) or {}

        market_cap_millions = float(profile.get("marketCapitalization") or 0)
        market_cap = market_cap_millions * 1_000_000 if market_cap_millions > 0 else 0

        return {
            "ticker": symbol,
            "price": price,
            "change_percent": float(quote["dp"]) if quote.get("dp") is not None else None,
            "volume": None,
            "market_cap": market_cap,
            "pe_ratio": 0,
            "pb_ratio": 0,
            "dividend_yield": 0,
            "company_name": str(profile.get("name") or symbol),
            "sector": str(profile.get("finnhubIndustry") or "Unknown"),
            "industry": str(profile.get("finnhubIndustry") or "Unknown"),
            "source": "Finnhub",
            "fetched_at": datetime.utcnow().isoformat(),
            "ttl_seconds": 60,
            "is_stale": False,
        }


async def _fetch_pmp_quote(ticker: str) -> Dict[str, Any]:
    api_key = _pmp_api_key()
    if not api_key:
        raise RuntimeError("PMP_API_KEY/FMP_API_KEY not configured")
    if _provider_in_cooldown("pmp:global"):
        raise RuntimeError("pmp_provider_cooldown")

    symbol = ticker.upper().strip()
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        try:
            quote_res = await client.get(
                "https://financialmodelingprep.com/stable/quote",
                params={"symbol": symbol, "apikey": api_key},
            )
        except httpx.RequestError:
            record_fmp_call(endpoint="/stable/quote", status_code=None)
            raise
        record_fmp_call(endpoint="/stable/quote", status_code=quote_res.status_code)
        if not quote_res.is_success:
            _mark_provider_cooldown("pmp:global", quote_res.status_code)
        quote_res.raise_for_status()
        quote_payload = (quote_res.json() if quote_res.content else []) or []
        row = quote_payload[0] if isinstance(quote_payload, list) and quote_payload else {}
        price = float(row.get("price") or 0)
        if price <= 0:
            raise ValueError(f"invalid PMP/FMP quote payload for {symbol}")

        try:
            details_res = await client.get(
                "https://financialmodelingprep.com/stable/profile",
                params={"symbol": symbol, "apikey": api_key},
            )
        except httpx.RequestError:
            record_fmp_call(endpoint="/stable/profile", status_code=None)
            raise
        record_fmp_call(endpoint="/stable/profile", status_code=details_res.status_code)
        if not details_res.is_success:
            _mark_provider_cooldown("pmp:global", details_res.status_code)
        details_res.raise_for_status()
        details_payload = (details_res.json() if details_res.content else []) or []
        details = (
            details_payload[0] if isinstance(details_payload, list) and details_payload else {}
        )

        return {
            "ticker": symbol,
            "price": price,
            "change_percent": float(row["changePercentage"])
            if row.get("changePercentage") is not None
            else None,
            "volume": int(row["volume"]) if row.get("volume") is not None else None,
            "market_cap": float(row.get("marketCap") or details.get("marketCap") or 0),
            "pe_ratio": 0,
            "pb_ratio": 0,
            "dividend_yield": 0,
            "company_name": str(details.get("companyName") or row.get("name") or symbol),
            "sector": str(details.get("sector") or "Unknown"),
            "industry": str(details.get("industry") or "Unknown"),
            "source": "PMP/FMP",
            "fetched_at": datetime.utcnow().isoformat(),
            "ttl_seconds": 60,
            "is_stale": False,
        }


async def _fetch_finnhub_company_news(ticker: str, days_back: int) -> List[Dict[str, Any]]:
    api_key = _finnhub_api_key()
    if not api_key:
        return []

    end_date = datetime.utcnow().date().isoformat()
    start_date = (datetime.utcnow() - timedelta(days=max(1, days_back))).date().isoformat()
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        res = await client.get(
            "https://finnhub.io/api/v1/company-news",
            params={
                "symbol": ticker.upper(),
                "from": start_date,
                "to": end_date,
                "token": api_key,
            },
        )
        res.raise_for_status()
        rows = res.json() or []
        articles: list[Dict[str, Any]] = []
        for row in rows:
            title = str((row or {}).get("headline") or "").strip()
            url = str((row or {}).get("url") or "").strip()
            if not title or not url:
                continue
            ts = int((row or {}).get("datetime") or 0)
            published_at = (
                datetime.utcfromtimestamp(ts).isoformat() + "Z"
                if ts > 0
                else datetime.utcnow().isoformat()
            )
            articles.append(
                {
                    "title": title,
                    "description": str((row or {}).get("summary") or "").strip(),
                    "url": url,
                    "publishedAt": published_at,
                    "source": {"name": str((row or {}).get("source") or "Finnhub")},
                    "provider": "finnhub",
                    "image_url": (row or {}).get("image"),
                }
            )
        return articles


async def _fetch_pmp_news(ticker: str) -> List[Dict[str, Any]]:
    api_key = _pmp_api_key()
    if not api_key:
        return []
    if _provider_in_cooldown("pmp:global") or is_budget_critical():
        return []

    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        res = await client.get(
            "https://financialmodelingprep.com/stable/news/stock",
            params={
                "symbols": ticker.upper(),
                "limit": "25",
                "apikey": api_key,
            },
        )
        # This is a real FMP request, so include it in the shared daily quota
        # record exactly once. Cached feed pages never reach this function.
        record_fmp_call(endpoint="/stable/news/stock", status_code=res.status_code)
        if not res.is_success:
            _mark_provider_cooldown("pmp:global", res.status_code)
        res.raise_for_status()
        rows = (res.json() if res.content else []) or []
        articles: list[Dict[str, Any]] = []
        for row in rows:
            title = str((row or {}).get("title") or "").strip()
            url = str((row or {}).get("url") or "").strip()
            if not title or not url:
                continue
            articles.append(
                {
                    "title": title,
                    "description": str((row or {}).get("description") or "").strip(),
                    "url": url,
                    "publishedAt": str(
                        (row or {}).get("publishedDate") or datetime.utcnow().isoformat()
                    ),
                    "source": {"name": "PMP/FMP"},
                    "provider": "pmp_fmp",
                    "image_url": (row or {}).get("image"),
                }
            )
        return articles


async def _fetch_finnhub_peers(ticker: str) -> List[str]:
    api_key = _finnhub_api_key()
    if not api_key:
        return []

    timeout = httpx.Timeout(connect=4.0, read=6.0, write=6.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        res = await client.get(
            "https://finnhub.io/api/v1/stock/peers",
            params={"symbol": ticker.upper(), "token": api_key},
        )
        res.raise_for_status()
        rows = res.json() or []
        peers: list[str] = []
        for row in rows:
            symbol = str(row or "").upper().strip()
            if symbol and symbol != ticker.upper() and symbol not in peers:
                peers.append(symbol)
        return peers


async def _fetch_yfinance_quote(ticker: str, *, timeout_seconds: float = 3.5) -> Dict[str, Any]:
    try:
        import yfinance as yf
    except ImportError as exc:
        raise RuntimeError("yfinance_not_installed") from exc

    async def _get_info() -> Dict[str, Any]:
        def _blocking_fetch() -> Dict[str, Any]:
            from hushh_mcp.services.market_provider_telemetry import yahoo_counted_session

            stock = yf.Ticker(ticker, session=yahoo_counted_session())
            return stock.info or {}

        return await asyncio.to_thread(_blocking_fetch)

    try:
        info = await asyncio.wait_for(_get_info(), timeout=timeout_seconds)
    except asyncio.TimeoutError as exc:
        raise RuntimeError("yfinance_timeout") from exc

    if not info:
        raise RuntimeError("yfinance_empty_payload")

    payload = {
        "ticker": ticker.upper(),
        "price": info.get("currentPrice") or info.get("regularMarketPrice", 0),
        "change_percent": info.get("regularMarketChangePercent"),
        "volume": info.get("volume"),
        "market_cap": info.get("marketCap"),
        "pe_ratio": info.get("trailingPE"),
        "pb_ratio": info.get("priceToBook"),
        "forward_pe": info.get("forwardPE"),
        "ps_ratio": info.get("priceToSalesTrailing12Months"),
        "ev_ebitda": info.get("enterpriseToEbitda"),
        "enterprise_value": info.get("enterpriseValue"),
        "52w_low": info.get("fiftyTwoWeekLow"),
        "52w_high": info.get("fiftyTwoWeekHigh"),
        "dividend_yield": info.get("trailingAnnualDividendYield"),
        "company_name": info.get("longName", ticker.upper()),
        "currency": info.get("currency"),
        "instrument_type": info.get("quoteType"),
        "quoted_at": (
            datetime.fromtimestamp(info["regularMarketTime"], tz=timezone.utc).isoformat()
            if isinstance(info.get("regularMarketTime"), (int, float))
            and info["regularMarketTime"] > 0
            else None
        ),
        "sector": info.get("sector", "Unknown"),
        "industry": info.get("industry", "Unknown"),
        "business_summary": info.get("longBusinessSummary"),
        # Yahoo reports debt/equity as a percentage. The Market contract uses a multiple.
        "debt_to_equity": (
            float(info["debtToEquity"]) / 100
            if isinstance(info.get("debtToEquity"), (int, float))
            and math.isfinite(info["debtToEquity"])
            else None
        ),
        "financial_period_end": (
            datetime.fromtimestamp(info["mostRecentQuarter"], tz=timezone.utc).date().isoformat()
            if isinstance(info.get("mostRecentQuarter"), (int, float))
            and info["mostRecentQuarter"] > 0
            else None
        ),
        "source": "yfinance (Real-time)",
        "fetched_at": datetime.utcnow().isoformat(),
        "ttl_seconds": 60,
        "is_stale": False,
    }
    if not payload["price"] or payload["price"] <= 0:
        raise RuntimeError("yfinance_invalid_quote")
    return payload


async def _fetch_yahoo_recommendation_peers(ticker: str) -> List[str]:
    url = f"https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/{ticker.upper()}"
    timeout = httpx.Timeout(connect=4.0, read=6.0, write=6.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        res = await client.get(url)
        res.raise_for_status()
        payload = res.json() or {}
        result = payload.get("finance", {}).get("result") or []
        if not result:
            return []
        symbols = result[0].get("recommendedSymbols") or []
        cleaned: list[str] = []
        for row in symbols:
            symbol = str((row or {}).get("symbol") or "").upper().strip()
            if symbol and symbol != ticker.upper() and symbol not in cleaned:
                cleaned.append(symbol)
        return cleaned


async def _fetch_yahoo_search_peers(ticker: str) -> List[str]:
    url = "https://query1.finance.yahoo.com/v1/finance/search"
    timeout = httpx.Timeout(connect=4.0, read=6.0, write=6.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    params = {"q": ticker.upper(), "quotesCount": 8, "newsCount": 0}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:
        res = await client.get(url, params=params)
        res.raise_for_status()
        payload = res.json() or {}
        quotes = payload.get("quotes") or []
        peers: list[str] = []
        for row in quotes:
            if str((row or {}).get("quoteType") or "").upper() != "EQUITY":
                continue
            symbol = str((row or {}).get("symbol") or "").upper().strip()
            if symbol and symbol != ticker.upper() and symbol not in peers:
                peers.append(symbol)
        return peers


def _parse_yahoo_chart_meta(meta: Dict[str, Any]) -> Dict[str, Any] | None:
    """Map one v8 chart `meta` block onto the row shape the batch fetcher returns."""
    symbol = str(meta.get("symbol") or "").upper().strip()
    if not symbol:
        return None
    price = meta.get("regularMarketPrice")
    if (
        isinstance(price, bool)
        or not isinstance(price, (int, float))
        or not math.isfinite(float(price))
        or price <= 0
    ):
        return None

    # Unknown change is distinct from a measured flat session.
    previous_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    try:
        previous_close = float(previous_close)
    except (TypeError, ValueError):
        previous_close = 0.0
    change_percent = (
        ((float(price) - previous_close) / previous_close) * 100
        if math.isfinite(previous_close) and previous_close > 0
        else None
    )

    now = datetime.now(timezone.utc)
    quoted_at = None
    quote_time = meta.get("regularMarketTime")
    if isinstance(quote_time, (int, float)) and not isinstance(quote_time, bool):
        try:
            quoted_at = datetime.fromtimestamp(quote_time, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            pass
    delay = meta.get("exchangeDataDelayedBy")
    delay = (
        float(delay)
        if isinstance(delay, (int, float)) and math.isfinite(delay) and delay >= 0
        else None
    )
    regular = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    start, end = regular.get("start"), regular.get("end")
    market_state = None
    if isinstance(start, (int, float)) and isinstance(end, (int, float)):
        market_state = "open" if start <= now.timestamp() < end else "closed"
    is_delayed = bool(delay and delay > 0) or bool(
        market_state == "open" and quoted_at and now.timestamp() - quote_time > 10 * 60
    )
    # The shared equity cache still feeds the legacy analysis calculator, which
    # expects numeric placeholders. Keep that contract until analysis is migrated.
    absent_fundamental = None if symbol.startswith("^") else 0

    return {
        "ticker": symbol,
        "instrument_type": meta.get("instrumentType"),
        "price": float(price),
        "change_percent": change_percent,
        "volume": meta.get("regularMarketVolume"),
        "market_cap": absent_fundamental,
        "pe_ratio": absent_fundamental,
        "pb_ratio": absent_fundamental,
        "dividend_yield": absent_fundamental,
        "company_name": str(meta.get("longName") or meta.get("shortName") or symbol).strip(),
        "sector": "Unknown",
        "industry": "Unknown",
        "source": "Yahoo Chart (Batch)",
        "fetched_at": now.isoformat(),
        "quoted_at": quoted_at,
        "quote_delay_minutes": delay,
        "market_state": market_state,
        "is_delayed": is_delayed,
        "ttl_seconds": 60,
        "is_stale": False,
    }


async def _fetch_yahoo_quotes(
    symbols: List[str], *, range_period: str = "1d"
) -> List[Dict[str, Any]]:
    """Free-rung batch quotes, from the chart endpoint rather than the quote endpoint.

    `v7/finance/quote` answers 401 Unauthorized to any client without Yahoo credentials
    ("User is unable to access this feature"), so this rung had been dead: every batch raised,
    `fetch_market_data_batch` swallowed it and returned only what was already cached. Nothing
    surfaced it because Finnhub and FMP sit in front, and both are keyed.

    `v8/finance/chart` is still open to an unauthenticated client and its `meta` block carries the
    price and the previous close. The cost is one symbol per request instead of a list, so the
    fan-out is bounded and the L1/L2 cache in front of it is what keeps that off the provider.
    """
    if not symbols:
        return []

    timeout = httpx.Timeout(connect=4.0, read=_YAHOO_FAST_TIMEOUT_SECONDS, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    semaphore = asyncio.Semaphore(_YAHOO_CHART_CONCURRENCY)

    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, timeout=timeout, headers=headers
    ) as client:

        async def fetch_one(symbol: str) -> Dict[str, Any] | None:
            async with semaphore:
                res = await client.get(
                    f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}",
                    params={
                        "range": range_period,
                        "interval": "5m"
                        if symbol.startswith("^") and range_period == "1d"
                        else "1d",
                    },
                )
                # One delisted or mistyped symbol must not fail the whole batch. A 429 or 5xx is
                # the provider talking, so that one is raised for the caller's cooldown to see.
                if res.status_code == 429 or res.status_code >= 500:
                    res.raise_for_status()
                if res.status_code >= 400:
                    return None
                payload = res.json() or {}
                results = (payload.get("chart") or {}).get("result") or []
                if not results:
                    return None
                chart = results[0]
                row = _parse_yahoo_chart_meta(chart.get("meta") or {})
                if row and (symbol.startswith("^") or range_period != "1d"):
                    quotes = (chart.get("indicators") or {}).get("quote") or [{}]
                    closes = quotes[0].get("close") or []
                    points = [
                        {"t": timestamp, "p": float(close)}
                        for timestamp, close in zip(
                            chart.get("timestamp") or [], closes, strict=False
                        )
                        if isinstance(timestamp, (int, float))
                        and math.isfinite(timestamp)
                        and isinstance(close, (int, float))
                        and not isinstance(close, bool)
                        and math.isfinite(close)
                        and close > 0
                    ]
                    points.sort(key=lambda point: point["t"])
                    if range_period != "1d":
                        # Yahoo can append a second live bar for the same daily
                        # session. Count sessions, not rows, for 1D/1W returns.
                        try:
                            exchange_zone = ZoneInfo(
                                (chart.get("meta") or {}).get("exchangeTimezoneName") or "UTC"
                            )
                        except (ZoneInfoNotFoundError, ValueError):
                            exchange_zone = timezone.utc
                        sessions = {}
                        for point in points:
                            session = datetime.fromtimestamp(point["t"], tz=exchange_zone).date()
                            sessions[session] = point
                        points = list(sessions.values())
                    row["sparkline_points"] = points
                    row["sparkline"] = [point["p"] for point in points]
                    if range_period != "1d":
                        # A multi-session chart's chartPreviousClose is the range
                        # boundary, not yesterday. Keep its quote change honest too.
                        row["change_percent"] = (
                            (points[-1]["p"] / points[-2]["p"] - 1) * 100
                            if len(points) >= 2
                            else None
                        )
                return row

        settled = await asyncio.gather(
            *(fetch_one(symbol) for symbol in symbols), return_exceptions=True
        )

    parsed: list[Dict[str, Any]] = []
    provider_error: BaseException | None = None
    for outcome in settled:
        if isinstance(outcome, BaseException):
            provider_error = provider_error or outcome
            continue
        if outcome:
            parsed.append(outcome)

    # Only raise when the provider said so and nothing at all came back; a partial batch is a
    # better answer than an exception the caller turns into an empty strip.
    if provider_error is not None and not parsed:
        raise provider_error
    return parsed


async def _legacy_fetch_market_company_facts(symbol: str) -> Dict[str, Any]:
    """Public company facts, independent of the price-only quote cache."""
    quote = await _fetch_yfinance_quote(symbol, timeout_seconds=8.0)

    def finite(field: str, *, positive: bool = False) -> float | None:
        value = quote.get(field)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        if positive and value <= 0:
            return None
        return float(value)

    return {
        "symbol": symbol,
        "market_cap": finite("market_cap", positive=True),
        "pe_ratio": finite("pe_ratio", positive=True),
        "pb_ratio": finite("pb_ratio", positive=True),
        "debt_to_equity": finite("debt_to_equity"),
        "summary": str(quote.get("business_summary") or "").strip() or None,
        "financial_period_end": quote.get("financial_period_end"),
        "ratio_basis": "P/E trailing twelve months; P/B latest reported book value; total debt/equity multiple",
        "source": "Yahoo Finance",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


async def _legacy_fetch_market_session_history(
    symbols: List[str],
) -> Dict[str, List[Dict[str, float]]]:
    """Observed daily closes for period comparisons; never stored as spot quotes."""
    rows = await _fetch_yahoo_quotes(symbols, range_period="1mo")
    return {row["ticker"]: row.get("sparkline_points") or [] for row in rows}


async def _legacy_fetch_market_data_batch(
    tickers: List[str],
    user_id: UserID,
    consent_token: str | None = None,
) -> Dict[str, Dict[str, Any]]:
    """Fetch a batch of market quotes using one public Yahoo request before per-symbol fallbacks."""
    if consent_token:
        valid, reason, token = validate_token(
            consent_token,
            ConsentScope("agent.kai.analyze"),
        )

        if not valid:
            logger.error("[Market Data Batch Fetcher] consent_token_check_failed")
            raise PermissionError(f"Market data access denied: {reason}")

        if token.user_id != user_id:
            raise PermissionError("Token user mismatch")

    normalized_symbols = list(
        dict.fromkeys(
            str(symbol or "").strip().upper() for symbol in tickers if str(symbol or "").strip()
        )
    )
    if not normalized_symbols:
        return {}

    finnhub_enabled = bool(_finnhub_api_key())
    pmp_enabled = bool(_pmp_api_key())
    cached: Dict[str, Dict[str, Any]] = {}
    missing: List[str] = []

    for symbol in normalized_symbols:
        cache_key = _market_data_cache_key(
            symbol,
            finnhub_enabled=finnhub_enabled,
            pmp_enabled=pmp_enabled,
        )
        cached_payload = _get_cached_market_data(cache_key)
        if cached_payload and float(cached_payload.get("price") or 0) > 0:
            cached[symbol] = cached_payload
        else:
            missing.append(symbol)

    if not missing:
        return cached

    if _provider_in_cooldown("yahoo_quote_fast:global"):
        _emit_realtime_telemetry(
            "market_data_batch_skipped_cooldown",
            ticker_count=len(missing),
        )
        return cached

    started_at = time.perf_counter()
    requested_at = time.time()
    try:
        batch_rows = await _fetch_yahoo_quotes(missing)
    except Exception as exc:
        if isinstance(exc, httpx.HTTPStatusError):
            _mark_provider_cooldown(
                "yahoo_quote_fast:global",
                exc.response.status_code if exc.response is not None else None,
            )
        _emit_realtime_telemetry(
            "market_data_batch_failure",
            ticker_count=len(missing),
            error=_provider_error("upstream", exc),
            duration_ms=int((time.perf_counter() - started_at) * 1000),
        )
        return cached

    for payload in batch_rows:
        symbol = str(payload.get("ticker") or "").strip().upper()
        if not symbol or float(payload.get("price") or 0) <= 0:
            continue
        cache_key = _market_data_cache_key(
            symbol,
            finnhub_enabled=finnhub_enabled,
            pmp_enabled=pmp_enabled,
        )
        ttl_seconds = provider_quote_cache_ttl_seconds(
            max(int(payload.get("ttl_seconds") or 0), _MARKET_DATA_CACHE_TTL_SECONDS)
        )
        normalized_payload = dict(payload)
        normalized_payload["ticker"] = symbol
        normalized_payload["ttl_seconds"] = ttl_seconds
        normalized_payload["source"] = str(payload.get("source") or "Yahoo Quote (Batch)")
        _set_cached_market_data(cache_key, normalized_payload, ttl_seconds, requested_at)
        cached[symbol] = normalized_payload

    _emit_realtime_telemetry(
        "market_data_batch_success",
        ticker_count=len(normalized_symbols),
        resolved_count=len(cached),
        missing_count=max(0, len(normalized_symbols) - len(cached)),
        duration_ms=int((time.perf_counter() - started_at) * 1000),
    )
    return cached


# ============================================================================
# OPERON: fetch_sec_filings
# ============================================================================


async def fetch_sec_filings(
    ticker: str,
    user_id: UserID,
    consent_token: str,
) -> Dict[str, Any]:
    """Annual SEC facts; cache extracted public measurements, never owner context."""
    _validate_market_invocation(user_id, consent_token)
    if not consent_token:
        raise PermissionError("SEC data access requires an invocation token")
    from hushh_mcp.services.market_provider_cache import cached_public_information
    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)", "Accept": "application/json"}
    async with httpx.AsyncClient(
        event_hooks={"request": [record_provider_request]}, headers=headers
    ) as client:

        async def read_json(url: str) -> dict[str, Any]:
            response = await client.get(url, timeout=25.0)
            response.raise_for_status()
            return response.json()

        mapping = await cached_public_information(
            "sec:tickers:v1",
            fresh=86400,
            stale=86400,
            fetcher=lambda: read_json("https://www.sec.gov/files/company_tickers.json"),
        )
        cik = next(
            (
                str(row["cik_str"]).zfill(10)
                for row in mapping.values()
                if str(row.get("ticker", "")).upper() == ticker.upper()
            ),
            None,
        )
        if cik is None:
            raise ValueError(f"SEC-unavailable: CIK not found for {ticker}")

        async def read_submissions() -> dict[str, Any]:
            raw = await read_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
            return {"cik": raw.get("cik"), "filings": raw.get("filings", {}).get("recent", {})}

        submissions = await cached_public_information(
            f"sec:submissions:{cik}",
            fresh=3600,
            stale=86400,
            fetcher=read_submissions,
        )
        filings = submissions["filings"]
        forms = filings.get("form", [])
        candidates = [i for i, form in enumerate(forms) if form in {"10-K", "10-K/A"}]
        successor_cik = cik
        # SEC Rule 12g-3 successor filing 0002115436-26-000003 documents this
        # exact 1:1 lineage. Never infer lineage from similar company names.
        predecessor = {"0002115436": "0000034088"}.get(cik)
        if not candidates and predecessor:
            cik = predecessor
            submissions = await cached_public_information(
                f"sec:submissions:{cik}",
                fresh=3600,
                stale=86400,
                fetcher=read_submissions,
            )
            filings = submissions["filings"]
            forms = filings.get("form", [])
            candidates = [i for i, form in enumerate(forms) if form in {"10-K", "10-K/A"}]
        if not candidates:
            reason = (
                "20-F filer; US-GAAP 10-K extraction unavailable" if "20-F" in forms else "no 10-K"
            )
            raise ValueError(f"SEC-unavailable: {ticker}: {reason}")
        latest = max(candidates, key=lambda i: filings["filingDate"][i])
        accession = filings["accessionNumber"][latest]

        async def extracted_facts() -> dict[str, Any]:
            raw = await read_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")
            return {"entity_name": raw.get("entityName"), "latest_10k": extract_annual_facts(raw)}

        result = await cached_public_information(
            f"sec:facts:v2:{cik}:{accession}",
            fresh=86400,
            stale=604800,
            fetcher=extracted_facts,
        )
        return {
            **result,
            "ticker": ticker,
            "cik": cik,
            "successor_cik": successor_cik if successor_cik != cik else None,
            "source": "SEC EDGAR",
            "filing_date": filings["filingDate"][latest],
            "latest_10k": {
                **result["latest_10k"],
                "accession_number": accession,
                "filing_date": filings["filingDate"][latest],
            },
        }


# ============================================================================
# OPERON: fetch_market_news
# ============================================================================


async def _legacy_fetch_market_news(
    ticker: str,
    user_id: UserID,
    consent_token: str | None = None,
    days_back: int = 7,
) -> List[Dict[str, Any]]:
    """
    Operon: Fetch recent news articles.

    Invocation scope: agent.kai.analyze. News is public provider data.

    Provider priority:
    - Finnhub (if FINNHUB_API_KEY is configured)
    - PMP/FMP (if PMP_API_KEY or FMP_API_KEY is configured)
    - NewsAPI (if NEWSAPI_KEY is configured)
    - Google News RSS fallback

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        consent_token: Valid consent token
        days_back: How many days of news to fetch

    Returns:
        List of news article dicts with:
        - title: Article headline
        - description: Article summary
        - url: Article URL
        - publishedAt: Publication timestamp
        - source: {"name": "Source Name"}

    Raises:
        PermissionError: If consent token validation fails
    """
    if consent_token:
        # Validate consent token
        valid, reason, token = validate_token(
            consent_token,
            ConsentScope.AGENT_KAI_ANALYZE,
        )

        if not valid:
            logger.error("[News Fetcher] consent_token_check_failed")
            raise PermissionError(f"News data access denied: {reason}")

        if token.user_id != user_id:
            raise PermissionError("Token user mismatch")

    logger.info("[News Fetcher] Fetching news for %s (user=[redacted])", ticker)

    errors: list[str] = []
    providers: list[tuple[str, str, Any]] = [
        (
            "finnhub",
            "finnhub_news",
            lambda: _fetch_finnhub_company_news(ticker, days_back),
        ),
        ("pmp_fmp", "pmp_news", lambda: _fetch_pmp_news(ticker)),
        (
            "newsapi",
            "newsapi",
            lambda: _fetch_newsapi_articles(ticker, days_back),
        ),
        (
            "google_news_rss",
            "google_news_rss",
            lambda: _fetch_google_news_rss(ticker, days_back),
        ),
    ]

    # This really is priority/fallback. A useful first source ends the request;
    # an all-provider aggregation multiplied cold-cache quota usage without
    # improving a paginated feed, whose pages are served from its server cache.
    for provider, error_name, fetcher in providers:
        cooldown_key = f"{provider}:news"
        if _provider_in_cooldown(cooldown_key):
            errors.append(f"{error_name}:cooldown")
            continue
        try:
            articles = await fetcher()
            if not articles:
                errors.append(f"{error_name}:empty")
                continue
            deduped: list[Dict[str, Any]] = []
            seen: set[str] = set()
            for row in articles:
                key = f"{str(row.get('title') or '').strip().lower()}::{str(row.get('url') or '').strip()}"
                if not key or key in seen:
                    continue
                seen.add(key)
                deduped.append(row)
            if not deduped:
                errors.append(f"{error_name}:empty")
                continue
            _emit_realtime_telemetry(
                "news_provider_success",
                ticker=ticker.upper(),
                provider=provider,
                rows=len(deduped[:25]),
            )
            return deduped[:25]
        except Exception as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response is not None:
                _mark_provider_cooldown(cooldown_key, exc.response.status_code)
            errors.append(_provider_error(error_name, exc))
            _emit_realtime_telemetry(
                "news_provider_failure",
                ticker=ticker.upper(),
                provider=provider,
                error=_provider_error("upstream", exc),
            )

    if not errors:
        errors.append("no_news_provider_configured")
    _emit_realtime_telemetry(
        "news_all_providers_failed",
        ticker=ticker.upper(),
        errors=errors,
    )
    raise RealtimeDataUnavailable(
        "news",
        f"No realtime news data available for {ticker}. providers={'; '.join(errors) or 'none'}",
        retryable=True,
    )


# ============================================================================
# OPERON: fetch_market_data
# ============================================================================


async def _legacy_fetch_market_data(
    ticker: str,
    user_id: UserID,
    consent_token: str | None = None,
    *,
    allow_slow_fallbacks: bool = True,
) -> Dict[str, Any]:
    """
    Operon: Fetch current market data (price, volume, metrics).

    Invocation scope: agent.kai.analyze. Market quotes are public provider data.

    Provider priority:
    - Finnhub (if FINNHUB_API_KEY is configured)
    - PMP/FMP (if PMP_API_KEY or FMP_API_KEY is configured)
    - yfinance
    - Yahoo quote fast fallback

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        consent_token: Valid consent token

    Returns:
        Dict with market data:
        - ticker: Stock symbol
        - price: Current price
        - change_percent: Daily change %
        - volume: Trading volume
        - market_cap: Market capitalization
        - pe_ratio: P/E ratio
        - source: Data source name

    Raises:
        PermissionError: If consent token validation fails
    """
    if consent_token:
        # Validate consent token
        valid, reason, token = validate_token(
            consent_token,
            ConsentScope.AGENT_KAI_ANALYZE,
        )

        if not valid:
            logger.error("[Market Data Fetcher] consent_token_check_failed")
            raise PermissionError(f"Market data access denied: {reason}")

        if token.user_id != user_id:
            raise PermissionError("Token user mismatch")

    symbol = ticker.upper().strip()
    finnhub_enabled = bool(_finnhub_api_key())
    pmp_enabled = bool(_pmp_api_key())
    require_yfinance_rescue = not finnhub_enabled and not pmp_enabled
    cache_key = _market_data_cache_key(
        symbol, finnhub_enabled=finnhub_enabled, pmp_enabled=pmp_enabled
    )

    cached_payload = _get_cached_market_data(cache_key)
    if cached_payload and float(cached_payload.get("price") or 0) > 0:
        _emit_realtime_telemetry(
            "market_data_cache_hit",
            ticker=symbol,
            source=cached_payload.get("source"),
            ttl_seconds=cached_payload.get("ttl_seconds"),
        )
        return cached_payload

    lock = _get_market_data_lock(cache_key)
    async with lock:
        cached_payload = _get_cached_market_data(cache_key)
        if cached_payload and float(cached_payload.get("price") or 0) > 0:
            _emit_realtime_telemetry(
                "market_data_cache_hit_after_wait",
                ticker=symbol,
                source=cached_payload.get("source"),
                ttl_seconds=cached_payload.get("ttl_seconds"),
            )
            return cached_payload

        logger.info(
            "[Market Data Fetcher] Fetching market data for %s - user %s (priority: Finnhub -> PMP -> yfinance -> Yahoo)",
            symbol,
            user_id,
        )

        errors: list[str] = []
        providers: list[tuple[str, Any]] = []
        skip_yahoo_fast_for_symbol = False

        # Index symbols are not supported by the equity plans. A rejected index
        # request must never put stock quotes into a global provider cooldown.
        if finnhub_enabled and not symbol.startswith("^"):
            providers.append(("finnhub", _fetch_finnhub_quote))
        if pmp_enabled and not symbol.startswith("^"):
            providers.append(("pmp", _fetch_pmp_quote))
        # In fast-only mode we still use yfinance when rescue is explicitly requested
        # or when no paid providers are configured at all.
        should_include_yfinance = (
            allow_slow_fallbacks
            or require_yfinance_rescue
            or (not finnhub_enabled and not pmp_enabled)
        )
        if should_include_yfinance:
            providers.append(("yfinance", _fetch_yfinance_quote))
        providers.append(("yahoo_quote_fast", _fetch_yahoo_quote_fast))

        for provider_name, provider_fetch in providers:
            if provider_name == "yahoo_quote_fast" and skip_yahoo_fast_for_symbol:
                errors.append("yahoo_quote_fast:skipped_after_yfinance_timeout")
                _emit_realtime_telemetry(
                    "market_data_provider_skipped",
                    ticker=symbol,
                    provider=provider_name,
                    reason="yfinance_timeout_fast_mode",
                )
                continue
            started_at = time.perf_counter()
            provider_cooldown_key = _provider_cooldown_key(provider_name, symbol)
            if provider_cooldown_key and _provider_in_cooldown(provider_cooldown_key):
                errors.append(f"{provider_name}:provider_cooldown")
                _emit_realtime_telemetry(
                    "market_data_provider_skipped_cooldown",
                    ticker=symbol,
                    provider=provider_name,
                )
                continue
            try:
                requested_at = time.time()
                payload = await provider_fetch(symbol)
                if payload and float(payload.get("price") or 0) > 0:
                    fetched_at = payload.get("fetched_at")
                    ttl_seconds = int(payload.get("ttl_seconds") or 0)
                    cache_ttl_seconds = provider_quote_cache_ttl_seconds(
                        max(ttl_seconds, _MARKET_DATA_CACHE_TTL_SECONDS)
                    )
                    is_stale = bool(payload.get("is_stale", False))
                    normalized_payload = dict(payload)
                    normalized_payload["ticker"] = symbol
                    normalized_payload["ttl_seconds"] = cache_ttl_seconds
                    _set_cached_market_data(
                        cache_key, normalized_payload, cache_ttl_seconds, requested_at
                    )
                    _emit_realtime_telemetry(
                        "market_data_provider_success",
                        ticker=symbol,
                        provider=provider_name,
                        source=normalized_payload.get("source"),
                        fetched_at=fetched_at,
                        ttl_seconds=cache_ttl_seconds,
                        is_stale=is_stale,
                        duration_ms=int((time.perf_counter() - started_at) * 1000),
                    )
                    return normalized_payload
                errors.append(f"{provider_name}:invalid_price")
                _emit_realtime_telemetry(
                    "market_data_provider_invalid",
                    ticker=symbol,
                    provider=provider_name,
                    duration_ms=int((time.perf_counter() - started_at) * 1000),
                )
            except Exception as exc:
                if (
                    provider_name == "yfinance"
                    and "yfinance_timeout" in str(exc)
                    and provider_cooldown_key
                ):
                    _mark_provider_cooldown_for_duration(
                        provider_cooldown_key,
                        _YFINANCE_TIMEOUT_COOLDOWN_SECONDS,
                    )
                    if not allow_slow_fallbacks:
                        # Fast-mode requests prefer failing quickly over spending
                        # another network round-trip on Yahoo after yfinance timeout.
                        skip_yahoo_fast_for_symbol = True
                if isinstance(exc, httpx.HTTPStatusError) and provider_cooldown_key:
                    _mark_provider_cooldown(
                        provider_cooldown_key,
                        exc.response.status_code if exc.response is not None else None,
                    )
                errors.append(_provider_error(provider_name, exc))
                _emit_realtime_telemetry(
                    "market_data_provider_failure",
                    ticker=symbol,
                    provider=provider_name,
                    error=_provider_error("upstream", exc),
                    duration_ms=int((time.perf_counter() - started_at) * 1000),
                )

        _emit_realtime_telemetry(
            "market_data_all_providers_failed",
            ticker=symbol,
            errors=errors,
        )
        raise RealtimeDataUnavailable(
            "market_data",
            f"Realtime quote unavailable for {symbol}. providers={'; '.join(errors) or 'none'}",
            retryable=True,
        )


# ============================================================================
# OPERON: fetch_peer_data
# ============================================================================


async def _legacy_fetch_peer_symbols(ticker: str) -> list[str]:
    peers: list[str] = []
    errors: list[str] = []

    if _finnhub_api_key():
        try:
            peers.extend(await _fetch_finnhub_peers(ticker))
        except Exception as exc:
            errors.append(_provider_error("finnhub_peers", exc))

    if not peers:
        try:
            peers.extend(await _fetch_yahoo_recommendation_peers(ticker))
        except Exception as exc:
            errors.append(_provider_error("yahoo_recommendations", exc))

    if not peers:
        try:
            peers.extend(await _fetch_yahoo_search_peers(ticker))
        except Exception as exc:
            errors.append(_provider_error("yahoo_search", exc))

    deduped_peers: list[str] = []
    for peer in peers:
        cleaned = peer.upper().strip()
        if cleaned and cleaned != ticker.upper() and cleaned not in deduped_peers:
            deduped_peers.append(cleaned)

    if not deduped_peers:
        _emit_realtime_telemetry(
            "peer_data_all_providers_failed",
            ticker=ticker.upper(),
            errors=errors,
        )
        raise RealtimeDataUnavailable(
            "peer_data",
            f"No realtime peers available for {ticker}. providers={'; '.join(errors) or 'none'}",
            retryable=True,
        )

    return deduped_peers[:8]


async def fetch_peer_data(
    ticker: str,
    user_id: UserID,
    consent_token: str,
    sector: str = None,
) -> List[Dict[str, Any]]:
    """
    Operon: Fetch peer company data for comparison.

    Invocation scope: agent.kai.analyze. Market quotes are public provider data.

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        consent_token: Valid consent token
        sector: Industry sector (optional, auto-detected if None)

    Returns:
        List of peer company dicts with market data

    Raises:
        PermissionError: If consent token validation fails
    """
    # Validate consent token
    valid, reason, token = validate_token(
        consent_token,
        ConsentScope.AGENT_KAI_ANALYZE,
    )

    if not valid:
        raise PermissionError(f"Market data access denied: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info("[Peer Data Fetcher] Fetching peers for %s (user=[redacted])", ticker)

    from hushh_mcp.services.market_data_provider import MarketDataRequest

    peer_universe = await _fetch_through_market_port(
        MarketDataRequest("peers", (ticker.upper().strip(),)), cached=True
    )
    errors: list[str] = []
    quotes: list[Dict[str, Any]] = []
    for peer_symbol in peer_universe:
        try:
            quote = await fetch_market_data(peer_symbol, user_id, consent_token)
            if quote and str(quote.get("instrument_type") or "").upper() in {
                "EQUITY",
                "COMMON_STOCK",
            }:
                quotes.append(quote)
        except Exception as exc:
            errors.append(_provider_error(f"peer_quote:{peer_symbol}", exc))

    if not quotes:
        _emit_realtime_telemetry(
            "peer_quote_fetch_failed",
            ticker=ticker.upper(),
            peers=peer_universe,
            errors=errors,
        )
        raise RealtimeDataUnavailable(
            "peer_data",
            f"Peer quotes unavailable for {ticker}. peers={','.join(peer_universe)}",
            retryable=True,
        )
    _emit_realtime_telemetry(
        "peer_data_fetch_success",
        ticker=ticker.upper(),
        peer_count=len(quotes),
        requested_peers=len(peer_universe),
    )
    return quotes


async def _fetch_through_market_port(request, *, cached: bool = False):
    from hushh_mcp.services.legacy_market_data_adapter import LegacyMarketDataAdapter
    from hushh_mcp.services.market_data_provider import get_bound_market_data_provider
    from hushh_mcp.services.market_refresh_policy import PRICE_MARKET_OPERATIONS

    provider = get_bound_market_data_provider() or LegacyMarketDataAdapter()
    if (cached or request.operation in PRICE_MARKET_OPERATIONS) and provider.name != "fixture":
        from hushh_mcp.services.market_provider_cache import cached_market_provider_read

        identity = provider.name
        if identity == "legacy":
            identity += f":fh{int(bool(_finnhub_api_key()))}:fmp{int(bool(_pmp_api_key()))}"
        return await cached_market_provider_read(
            request, provider_identity=identity, fetcher=lambda: provider.fetch(request)
        )
    return await provider.fetch(request)


def _validate_market_invocation(user_id: UserID, consent_token: str | None) -> None:
    if consent_token is None:
        return
    valid, reason, token = validate_token(consent_token, ConsentScope.AGENT_KAI_ANALYZE)
    if not valid:
        raise PermissionError(f"Market data access denied: {reason}")
    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")


async def fetch_market_data(
    ticker: str,
    user_id: UserID,
    consent_token: str | None = None,
    *,
    allow_slow_fallbacks: bool = True,
) -> Dict[str, Any]:
    from hushh_mcp.services.market_data_provider import MarketDataRequest

    _validate_market_invocation(user_id, consent_token)
    return await _fetch_through_market_port(
        MarketDataRequest(
            "quote",
            (ticker.upper().strip(),),
            allow_slow_fallbacks=allow_slow_fallbacks,
        ),
        cached=bool(consent_token),
    )


async def fetch_market_data_batch(
    tickers: List[str],
    user_id: UserID,
    consent_token: str | None = None,
) -> Dict[str, Dict[str, Any]]:
    from hushh_mcp.services.market_data_provider import MarketDataRequest

    _validate_market_invocation(user_id, consent_token)
    symbols = tuple(dict.fromkeys(str(s).strip().upper() for s in tickers if str(s).strip()))
    return await _fetch_through_market_port(
        MarketDataRequest("quotes", symbols), cached=bool(consent_token)
    )


async def fetch_market_news(
    ticker: str,
    user_id: UserID,
    consent_token: str | None = None,
    days_back: int = 7,
) -> List[Dict[str, Any]]:
    from hushh_mcp.services.market_data_provider import MarketDataRequest

    _validate_market_invocation(user_id, consent_token)
    return await _fetch_through_market_port(
        MarketDataRequest(
            "news",
            (ticker.upper().strip(),),
            days_back=days_back,
        ),
        cached=bool(consent_token),
    )


async def fetch_market_company_facts(symbol: str) -> Dict[str, Any]:
    from hushh_mcp.services.market_data_provider import MarketDataRequest

    return await _fetch_through_market_port(MarketDataRequest("ratios", (symbol.upper().strip(),)))


async def fetch_price_target_consensus(
    ticker: str, user_id: UserID, consent_token: str
) -> Dict[str, Any]:
    from hushh_mcp.services.market_data_provider import MarketDataRequest

    _validate_market_invocation(user_id, consent_token)
    return await _fetch_through_market_port(
        MarketDataRequest("price_targets", (ticker.upper().strip(),)),
        cached=True,
    )


async def fetch_market_session_history(symbols: List[str]) -> Dict[str, List[Dict[str, float]]]:
    from hushh_mcp.services.market_data_provider import MarketDataRequest

    return await _fetch_through_market_port(MarketDataRequest("session_history", tuple(symbols)))
