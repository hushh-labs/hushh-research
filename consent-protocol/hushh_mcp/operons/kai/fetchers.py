# hushh_mcp/operons/kai/fetchers.py

"""
Kai Fetcher Operons

External data retrieval with per-source consent validation.
Each fetcher requires specific TrustLink for the data source.

Runtime provider priority (for realtime market/news flows):
1) Finnhub
2) PMP (Financial Modeling Prep)
3) Existing free/public fallbacks (NewsAPI/Google RSS, yfinance/Yahoo)
"""

import asyncio
import logging
import os
import threading
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timedelta
from typing import Any, Dict, List

import httpx
from defusedxml import ElementTree as DefusedET

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import UserID

logger = logging.getLogger(__name__)
_PROVIDER_COOLDOWNS: dict[str, float] = {}
_PROVIDER_COOLDOWN_BY_STATUS: dict[int, int] = {
    401: 15 * 60,
    402: 15 * 60,
    403: 10 * 60,
    404: 20 * 60,
    429: 5 * 60,
}
_MARKET_DATA_CACHE: dict[str, tuple[float, Dict[str, Any]]] = {}
_MARKET_DATA_LOCKS: dict[str, asyncio.Lock] = {}
_MARKET_DATA_CACHE_LOCK = threading.RLock()
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


def _provider_in_cooldown(key: str) -> bool:
    now = time.time()
    until = _PROVIDER_COOLDOWNS.get(key)
    if until is None:
        return False
    if until <= now:
        _PROVIDER_COOLDOWNS.pop(key, None)
        return False
    return True


def _mark_provider_cooldown(key: str, status_code: int | None) -> None:
    if status_code is None:
        return
    duration = _PROVIDER_COOLDOWN_BY_STATUS.get(int(status_code))
    if not duration:
        return
    _PROVIDER_COOLDOWNS[key] = time.time() + duration


def _mark_provider_cooldown_for_duration(key: str, duration_seconds: int) -> None:
    if duration_seconds <= 0:
        return
    _PROVIDER_COOLDOWNS[key] = time.time() + int(duration_seconds)


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
            lock = asyncio.Lock()
            _MARKET_DATA_LOCKS[cache_key] = lock
        return lock


def _get_cached_market_data(cache_key: str) -> Dict[str, Any] | None:
    now = time.time()
    with _MARKET_DATA_CACHE_LOCK:
        cached = _MARKET_DATA_CACHE.get(cache_key)
        if not cached:
            return None
        expires_at, payload = cached
        if expires_at <= now:
            _MARKET_DATA_CACHE.pop(cache_key, None)
            return None
        return dict(payload)


def _set_cached_market_data(cache_key: str, payload: Dict[str, Any], ttl_seconds: int) -> None:
    ttl = max(60, int(ttl_seconds))
    with _MARKET_DATA_CACHE_LOCK:
        _MARKET_DATA_CACHE[cache_key] = (time.time() + ttl, dict(payload))


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
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
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
            "change_percent": q.get("regularMarketChangePercent") or 0,
            "volume": q.get("regularMarketVolume") or 0,
            "market_cap": q.get("marketCap") or 0,
            "pe_ratio": q.get("trailingPE") or 0,
            "pb_ratio": q.get("priceToBook") or 0,
            "dividend_yield": q.get("trailingAnnualDividendYield") or 0,
            "company_name": q.get("longName") or q.get("shortName") or ticker.upper(),
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
                "description": f"Realtime market coverage for {ticker}",
                "url": link,
                "publishedAt": published_at or datetime.utcnow().isoformat(),
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
    async with httpx.AsyncClient(timeout=timeout) as client:
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
                    "publishedAt": str(row.get("publishedAt") or datetime.utcnow().isoformat()),
                    "source": {"name": str((row.get("source") or {}).get("name") or "NewsAPI")},
                    "provider": "newsapi",
                }
            )
        return articles


async def _fetch_google_news_rss(ticker: str, days_back: int) -> List[Dict[str, Any]]:
    query = urllib.parse.quote_plus(f"{ticker} stock when:{max(1, days_back)}d")
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        res = await client.get(url)
        res.raise_for_status()
        return _parse_google_news_rss(res.text or "", ticker)


def _provider_error(provider: str, exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code if exc.response is not None else "unknown"
        detail = ""
        if exc.response is not None:
            try:
                detail = str(exc.response.text or "").strip()
            except Exception:
                detail = ""
        if detail:
            detail = detail.replace("\n", " ")[:180]
            return f"{provider}:{status_code}:{detail}"
        return f"{provider}:{status_code}:{exc}"
    return f"{provider}:{exc}"


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
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
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
            "change_percent": float(quote.get("dp") or 0),
            "volume": 0,
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
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        quote_res = await client.get(
            "https://financialmodelingprep.com/stable/quote",
            params={"symbol": symbol, "apikey": api_key},
        )
        if not quote_res.is_success:
            _mark_provider_cooldown("pmp:global", quote_res.status_code)
        quote_res.raise_for_status()
        quote_payload = (quote_res.json() if quote_res.content else []) or []
        row = quote_payload[0] if isinstance(quote_payload, list) and quote_payload else {}
        price = float(row.get("price") or 0)
        if price <= 0:
            raise ValueError(f"invalid PMP/FMP quote payload for {symbol}")

        details_res = await client.get(
            "https://financialmodelingprep.com/stable/profile",
            params={"symbol": symbol, "apikey": api_key},
        )
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
            "change_percent": float(row.get("changePercentage") or 0),
            "volume": int(row.get("volume") or 0),
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
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
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
                }
            )
        return articles


async def _fetch_pmp_news(ticker: str) -> List[Dict[str, Any]]:
    api_key = _pmp_api_key()
    if not api_key:
        return []
    if _provider_in_cooldown("pmp:global"):
        return []

    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        res = await client.get(
            "https://financialmodelingprep.com/stable/news/stock",
            params={
                "symbols": ticker.upper(),
                "limit": "25",
                "apikey": api_key,
            },
        )
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
                }
            )
        return articles


async def _fetch_finnhub_peers(ticker: str) -> List[str]:
    api_key = _finnhub_api_key()
    if not api_key:
        return []

    timeout = httpx.Timeout(connect=4.0, read=6.0, write=6.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
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


async def _fetch_yfinance_quote(ticker: str) -> Dict[str, Any]:
    try:
        import yfinance as yf
    except ImportError as exc:
        raise RuntimeError("yfinance_not_installed") from exc

    async def _get_info() -> Dict[str, Any]:
        def _blocking_fetch() -> Dict[str, Any]:
            stock = yf.Ticker(ticker)
            return stock.info or {}

        return await asyncio.to_thread(_blocking_fetch)

    try:
        info = await asyncio.wait_for(_get_info(), timeout=3.5)
    except asyncio.TimeoutError as exc:
        raise RuntimeError("yfinance_timeout") from exc

    if not info:
        raise RuntimeError("yfinance_empty_payload")

    payload = {
        "ticker": ticker.upper(),
        "price": info.get("currentPrice") or info.get("regularMarketPrice", 0),
        "change_percent": info.get("regularMarketChangePercent", 0),
        "volume": info.get("volume", 0),
        "market_cap": info.get("marketCap", 0),
        "pe_ratio": info.get("trailingPE", 0),
        "pb_ratio": info.get("priceToBook", 0),
        "dividend_yield": info.get("dividendYield", 0) or 0,
        "company_name": info.get("longName", ticker.upper()),
        "sector": info.get("sector", "Unknown"),
        "industry": info.get("industry", "Unknown"),
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
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
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
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        res = await client.get(url, params=params)
        res.raise_for_status()
        payload = res.json() or {}
        quotes = payload.get("quotes") or []
        peers: list[str] = []
        for row in quotes:
            symbol = str((row or {}).get("symbol") or "").upper().strip()
            if symbol and symbol != ticker.upper() and symbol not in peers:
                peers.append(symbol)
        return peers


async def _fetch_yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    if not symbols:
        return []

    url = "https://query1.finance.yahoo.com/v7/finance/quote"
    params = {"symbols": ",".join(symbols)}
    timeout = httpx.Timeout(connect=4.0, read=8.0, write=8.0, pool=4.0)
    headers = {"User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        res = await client.get(url, params=params)
        res.raise_for_status()
        payload = res.json() or {}
        rows = payload.get("quoteResponse", {}).get("result") or []
        parsed: list[Dict[str, Any]] = []
        for row in rows:
            symbol = str(row.get("symbol") or "").upper().strip()
            if not symbol:
                continue
            parsed.append(
                {
                    "ticker": symbol,
                    "price": row.get("regularMarketPrice") or 0,
                    "change_percent": row.get("regularMarketChangePercent") or 0,
                    "volume": row.get("regularMarketVolume") or 0,
                    "market_cap": row.get("marketCap") or 0,
                    "pe_ratio": row.get("trailingPE") or 0,
                    "pb_ratio": row.get("priceToBook") or 0,
                    "dividend_yield": row.get("trailingAnnualDividendYield") or 0,
                    "company_name": row.get("longName") or row.get("shortName") or symbol,
                    "sector": row.get("sector") or "Unknown",
                    "industry": row.get("industry") or "Unknown",
                    "source": "Yahoo Quote (Peers)",
                    "fetched_at": datetime.utcnow().isoformat(),
                    "ttl_seconds": 60,
                    "is_stale": False,
                }
            )
        return parsed


async def fetch_market_data_batch(
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
            logger.error(f"[Market Data Batch Fetcher] TrustLink validation failed: {reason}")
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
            error=str(exc)[:200],
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
        ttl_seconds = max(int(payload.get("ttl_seconds") or 0), _MARKET_DATA_CACHE_TTL_SECONDS)
        normalized_payload = dict(payload)
        normalized_payload["ticker"] = symbol
        normalized_payload["ttl_seconds"] = ttl_seconds
        normalized_payload["source"] = str(payload.get("source") or "Yahoo Quote (Batch)")
        _set_cached_market_data(cache_key, normalized_payload, ttl_seconds)
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
    """
    Operon: Fetch SEC filings from EDGAR (free, public API).

    TrustLink Required: external.sec.filings

    This requires EXPLICIT consent for external data access.
    SEC EDGAR is 100% free and requires no API key.

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        consent_token: Valid consent token with external.sec.filings scope

    Returns:
        Dict with SEC filing data:
        - ticker: Stock symbol
        - cik: Central Index Key
        - latest_10k: Parsed 10-K data
        - latest_10q: Parsed 10-Q data
        - filing_date: Date of latest filing
        - source: "SEC EDGAR"

    Raises:
        PermissionError: If TrustLink validation fails
    """
    # Validate TrustLink for Kai analysis
    # Note: agent.kai.analyze scope covers all data fetching needs for Kai
    valid, reason, token = validate_token(
        consent_token,
        ConsentScope("agent.kai.analyze"),  # Changed from external.sec.filings
    )

    if not valid:
        logger.error(f"[SEC Fetcher] TrustLink validation failed: {reason}")
        raise PermissionError(f"SEC data access denied: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info(f"[SEC Fetcher] Fetching filings for {ticker} - user {user_id}")

    # SEC EDGAR API Implementation
    # Reference: https://www.sec.gov/edgar/sec-api-documentation
    # Note: Different base URLs for different endpoints

    EDGAR_DATA_URL = "https://data.sec.gov"  # For submissions
    EDGAR_WWW_URL = "https://www.sec.gov"  # For company tickers
    HEADERS = {
        "User-Agent": "Hushh-Research/1.0 (eng@hush1one.com)",  # Required by SEC
        "Accept": "application/json",
    }

    # Step 1: Get CIK from ticker
    async with httpx.AsyncClient() as client:
        # Get ticker-to-CIK mapping
        logger.info(f"[SEC Fetcher] Looking up CIK for {ticker}...")
        tickers_response = await client.get(
            f"{EDGAR_WWW_URL}/files/company_tickers.json", headers=HEADERS, timeout=10.0
        )
        tickers_response.raise_for_status()
        tickers_data = tickers_response.json()

        # Find CIK for ticker
        cik = None
        for entry in tickers_data.values():
            if entry.get("ticker", "").upper() == ticker.upper():
                cik = str(entry["cik_str"]).zfill(10)
                break

        if not cik:
            raise ValueError(f"CIK not found for ticker: {ticker}")

        logger.info(f"[SEC Fetcher] Found CIK {cik} for {ticker}")

        # Step 2: Get submissions (filings list)
        logger.info(f"[SEC Fetcher] Fetching submissions for CIK {cik}...")
        submissions_response = await client.get(
            f"{EDGAR_DATA_URL}/submissions/CIK{cik}.json", headers=HEADERS, timeout=10.0
        )
        submissions_response.raise_for_status()
        submissions = submissions_response.json()

        # Step 3: Find latest 10-K
        filings = submissions.get("filings", {}).get("recent", {})
        forms = filings.get("form", [])
        accession_numbers = filings.get("accessionNumber", [])
        filing_dates = filings.get("filingDate", [])

        latest_10k_idx = None
        for i, form in enumerate(forms):
            if form == "10-K":
                latest_10k_idx = i
                break

        if latest_10k_idx is None:
            raise ValueError(f"No 10-K filing found for ticker: {ticker} (CIK: {cik})")

        logger.info(
            f"[SEC Fetcher] Found 10-K: {accession_numbers[latest_10k_idx]} dated {filing_dates[latest_10k_idx]}"
        )

        # Step 4: Fetch Company Facts for actual financial data
        logger.info(f"[SEC Fetcher] Fetching company facts (financial metrics) for CIK {cik}...")
        try:
            facts_url = f"{EDGAR_DATA_URL}/api/xbrl/companyfacts/CIK{cik}.json"
            # NVDA and other large filers can have very large payloads; allow a bit more time + retry.
            # We still keep a firm ceiling so the overall Kai analysis doesn't stall.
            facts_response = None
            for attempt in range(1, 3):
                try:
                    facts_response = await client.get(facts_url, headers=HEADERS, timeout=25.0)
                    facts_response.raise_for_status()
                    break
                except Exception as e:
                    if attempt >= 2:
                        raise
                    logger.warning(
                        f"[SEC Fetcher] companyfacts attempt {attempt} failed: {e}; retrying once..."
                    )
                    await asyncio.sleep(0.5)

            facts_data = (facts_response.json() if facts_response is not None else {}) or {}

            # Extract financial metrics from US-GAAP taxonomy
            us_gaap = facts_data.get("facts", {}).get("us-gaap", {})

            def get_latest_annual_value(metric_names: List[str]) -> int:
                """Extract the most recent annual (10-K) value from a prioritized list of tags."""
                for metric_name in metric_names:
                    if metric_name not in us_gaap:
                        continue

                    metric_data = us_gaap[metric_name]
                    usd_data = metric_data.get("units", {}).get("USD", [])

                    # Filter for 10-K filings only
                    annual_data = [d for d in usd_data if d.get("form") == "10-K"]

                    if not annual_data:
                        continue

                    # Get most recent by end date
                    latest = sorted(annual_data, key=lambda x: x.get("end", ""), reverse=True)[0]
                    return int(latest.get("val", 0))
                return 0

            def get_historical_annual_values(
                metric_names: List[str], years: int = 4
            ) -> List[Dict[str, Any]]:
                """Extract historical annual values for a prioritized list of tags."""
                for metric_name in metric_names:
                    if metric_name not in us_gaap:
                        continue

                    metric_data = us_gaap[metric_name]
                    usd_data = metric_data.get("units", {}).get("USD", [])

                    # Filter for 10-K filings only
                    annual_data = [d for d in usd_data if d.get("form") == "10-K"]

                    if not annual_data:
                        continue

                    # Get most recent years by end date
                    sorted_data = sorted(annual_data, key=lambda x: x.get("end", ""), reverse=True)

                    # Dedup by year (sometimes multiple entries for same year)
                    seen_years = set()
                    historical = []
                    for d in sorted_data:
                        year = d.get("fy") or d.get("end", "")[:4]
                        if year not in seen_years:
                            historical.append(
                                {"year": year, "value": int(d.get("val", 0)), "end": d.get("end")}
                            )
                            seen_years.add(year)
                        if len(historical) >= years:
                            break
                    return historical[::-1]  # Chronological order
                return []

            # Extract key financial metrics using prioritized US-GAAP tags
            revenue = get_latest_annual_value(
                [
                    "Revenues",
                    "RevenueFromContractWithCustomerExcludingAssessedTax",
                    "SalesRevenueNet",
                ]
            )
            net_income = get_latest_annual_value(
                ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]
            )
            total_assets = get_latest_annual_value(["Assets"])
            total_liabilities = get_latest_annual_value(["Liabilities"])

            # --- NEW: Expanded Fundamental Metrics ---
            # Cash Flow tags
            ocf = get_latest_annual_value(["NetCashProvidedByUsedInOperatingActivities"])
            capex = get_latest_annual_value(
                ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]
            )
            fcf = ocf - capex if ocf else 0

            # Balance Sheet & Efficiency tags
            long_term_debt = get_latest_annual_value(["LongTermDebtNoncurrent", "LongTermDebt"])
            equity = get_latest_annual_value(
                [
                    "StockholdersEquity",
                    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
                ]
            )
            op_income = get_latest_annual_value(["OperatingIncomeLoss"])
            rnd = get_latest_annual_value(
                [
                    "ResearchAndDevelopmentExpense",
                    "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
                ]
            )

            # --- NEW: Historical Trends for Quant Analysis ---
            revenue_trend = get_historical_annual_values(
                [
                    "Revenues",
                    "RevenueFromContractWithCustomerExcludingAssessedTax",
                    "SalesRevenueNet",
                ]
            )
            net_income_trend = get_historical_annual_values(
                ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]
            )
            ocf_trend = get_historical_annual_values(["NetCashProvidedByUsedInOperatingActivities"])
            rnd_trend = get_historical_annual_values(
                [
                    "ResearchAndDevelopmentExpense",
                    "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
                ]
            )

            logger.info(
                f"[SEC Fetcher] Extracted Deep Metrics for {ticker} - Trends for Revenue, Net Income, OCF, R&D available."
            )

        except Exception as facts_error:
            logger.warning(f"[SEC Fetcher] Could not fetch company facts: {facts_error}")
            raise RealtimeDataUnavailable(
                "sec_filings",
                f"SEC companyfacts unavailable for {ticker}: {facts_error}",
                retryable=True,
            ) from facts_error

        # Return structured filing data with EXPANDED financial metrics
        return {
            "ticker": ticker,
            "cik": cik,
            "entity_name": facts_data.get("entityName", ticker)
            if "facts_data" in locals()
            else ticker,
            "latest_10k": {
                "accession_number": accession_numbers[latest_10k_idx],
                "filing_date": filing_dates[latest_10k_idx],
                "revenue": revenue,
                "net_income": net_income,
                "total_assets": total_assets,
                "total_liabilities": total_liabilities,
                # Deep Metrics
                "operating_cash_flow": ocf,
                "free_cash_flow": fcf,
                "long_term_debt": long_term_debt,
                "equity": equity,
                "operating_income": op_income,
                "research_and_development": rnd,
                # Trends
                "revenue_trend": revenue_trend,
                "net_income_trend": net_income_trend,
                "ocf_trend": ocf_trend,
                "rnd_trend": rnd_trend,
            },
            "filing_date": filing_dates[latest_10k_idx],
            "source": "SEC EDGAR (Institutional Trend Extract)",
            "fetched_at": datetime.utcnow().isoformat(),
        }


# ============================================================================
# OPERON: fetch_market_news
# ============================================================================


async def fetch_market_news(
    ticker: str,
    user_id: UserID,
    consent_token: str | None = None,
    days_back: int = 7,
) -> List[Dict[str, Any]]:
    """
    Operon: Fetch recent news articles.

    TrustLink Required: external.news.api

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
        PermissionError: If TrustLink validation fails
    """
    if consent_token:
        # Validate TrustLink
        valid, reason, token = validate_token(
            consent_token,
            ConsentScope("agent.kai.analyze"),  # Changed from external.news.api
        )

        if not valid:
            logger.error(f"[News Fetcher] TrustLink validation failed: {reason}")
            raise PermissionError(f"News data access denied: {reason}")

        if token.user_id != user_id:
            raise PermissionError("Token user mismatch")

    logger.info(f"[News Fetcher] Fetching news for {ticker} - user {user_id}")

    errors: list[str] = []
    articles: list[Dict[str, Any]] = []

    # Provider priority: 1) Finnhub, 2) PMP (FMP), then existing fallbacks.
    if _finnhub_api_key():
        try:
            articles.extend(await _fetch_finnhub_company_news(ticker, days_back))
            _emit_realtime_telemetry(
                "news_provider_success",
                ticker=ticker.upper(),
                provider="finnhub",
                rows=len(articles),
            )
        except Exception as exc:
            errors.append(_provider_error("finnhub_news", exc))
            _emit_realtime_telemetry(
                "news_provider_failure",
                ticker=ticker.upper(),
                provider="finnhub",
                error=str(exc)[:200],
            )

    if _pmp_api_key():
        try:
            articles.extend(await _fetch_pmp_news(ticker))
            _emit_realtime_telemetry(
                "news_provider_success",
                ticker=ticker.upper(),
                provider="pmp_fmp",
                rows=len(articles),
            )
        except Exception as exc:
            errors.append(_provider_error("pmp_news", exc))
            _emit_realtime_telemetry(
                "news_provider_failure",
                ticker=ticker.upper(),
                provider="pmp_fmp",
                error=str(exc)[:200],
            )

    try:
        articles.extend(await _fetch_newsapi_articles(ticker, days_back))
    except Exception as exc:
        errors.append(_provider_error("newsapi", exc))

    try:
        articles.extend(await _fetch_google_news_rss(ticker, days_back))
    except Exception as exc:
        errors.append(_provider_error("google_news_rss", exc))

    deduped: list[Dict[str, Any]] = []
    seen: set[str] = set()
    for row in articles:
        key = f"{str(row.get('title') or '').strip().lower()}::{str(row.get('url') or '').strip()}"
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(row)

    if not deduped:
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

    provider_counts = Counter(str(row.get("provider") or "unknown") for row in deduped)
    _emit_realtime_telemetry(
        "news_fetch_success",
        ticker=ticker.upper(),
        providers=dict(provider_counts),
        returned_rows=len(deduped[:25]),
    )
    return deduped[:25]


# ============================================================================
# OPERON: fetch_market_data
# ============================================================================


async def fetch_market_data(
    ticker: str,
    user_id: UserID,
    consent_token: str | None = None,
    *,
    allow_slow_fallbacks: bool = True,
) -> Dict[str, Any]:
    """
    Operon: Fetch current market data (price, volume, metrics).

    TrustLink Required: external.market.data

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
        PermissionError: If TrustLink validation fails
    """
    if consent_token:
        # Validate TrustLink
        valid, reason, token = validate_token(
            consent_token,
            ConsentScope("agent.kai.analyze"),  # Changed from external.market.data
        )

        if not valid:
            logger.error(f"[Market Data Fetcher] TrustLink validation failed: {reason}")
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

        if finnhub_enabled:
            providers.append(("finnhub", _fetch_finnhub_quote))
        if pmp_enabled:
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
                payload = await provider_fetch(symbol)
                if payload and float(payload.get("price") or 0) > 0:
                    fetched_at = payload.get("fetched_at")
                    ttl_seconds = int(payload.get("ttl_seconds") or 0)
                    cache_ttl_seconds = max(ttl_seconds, _MARKET_DATA_CACHE_TTL_SECONDS)
                    is_stale = bool(payload.get("is_stale", False))
                    normalized_payload = dict(payload)
                    normalized_payload["ticker"] = symbol
                    normalized_payload["ttl_seconds"] = cache_ttl_seconds
                    _set_cached_market_data(cache_key, normalized_payload, cache_ttl_seconds)
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
                    error=str(exc)[:200],
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


async def fetch_peer_data(
    ticker: str,
    user_id: UserID,
    consent_token: str,
    sector: str = None,
) -> List[Dict[str, Any]]:
    """
    Operon: Fetch peer company data for comparison.

    TrustLink Required: external.market.data

    Args:
        ticker: Stock ticker symbol
        user_id: User ID for audit
        consent_token: Valid consent token
        sector: Industry sector (optional, auto-detected if None)

    Returns:
        List of peer company dicts with market data

    Raises:
        PermissionError: If TrustLink validation fails
    """
    # Validate TrustLink
    valid, reason, token = validate_token(
        consent_token,
        ConsentScope("agent.kai.analyze"),  # Changed from external.market.data
    )

    if not valid:
        raise PermissionError(f"Market data access denied: {reason}")

    if token.user_id != user_id:
        raise PermissionError("Token user mismatch")

    logger.info(f"[Peer Data Fetcher] Fetching peers for {ticker} - user {user_id}")

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

    peer_universe = deduped_peers[:8]
    quotes: list[Dict[str, Any]] = []
    for peer_symbol in peer_universe:
        try:
            quote = await fetch_market_data(peer_symbol, user_id, consent_token)
            if quote:
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
