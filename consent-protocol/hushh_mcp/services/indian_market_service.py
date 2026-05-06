"""Indian stock market data service.

Data flow
---------
1. L1 — in-process memory (TTL 60s)
2. L2 — MarketCacheStore / Postgres (TTL 15 min fresh, 60 min stale)
3. L3 — yfinance (always available, no API key needed)
4. L3+ — Zerodha Kite / Upstox (live broker data, requires credentials)

yfinance suffix convention
--------------------------
- NSE: RELIANCE.NS
- BSE: RELIANCE.BO
- Indices: ^NSEI (Nifty 50), ^BSESN (Sensex), ^NSEBANK (Bank Nifty)
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from hushh_mcp.services.market_cache_store import get_market_cache_store_service

logger = logging.getLogger(__name__)

_YFINANCE_QUOTE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
_YFINANCE_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"
_YF_TIMEOUT_SECONDS = 8.0
_YF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

_FRESH_TTL_SECONDS = 900   # 15 min
_STALE_TTL_SECONDS = 3600  # 60 min
_L1_TTL_SECONDS = 60

_INDIAN_SUFFIX_RE = re.compile(r"\.(NS|BO)$", re.IGNORECASE)

_INDEX_MAP: dict[str, str] = {
    "nifty": "^NSEI",
    "nifty50": "^NSEI",
    "nifty_50": "^NSEI",
    "nifty 50": "^NSEI",
    "sensex": "^BSESN",
    "bse sensex": "^BSESN",
    "bank nifty": "^NSEBANK",
    "banknifty": "^NSEBANK",
    "nifty bank": "^NSEBANK",
    "nifty midcap": "^NSEMDCP50",
    "midcap": "^NSEMDCP50",
}

_SPOKEN_TO_SYMBOL: dict[str, str] = {
    "reliance": "RELIANCE.NS",
    "ril": "RELIANCE.NS",
    "tcs": "TCS.NS",
    "tata consultancy": "TCS.NS",
    "infosys": "INFY.NS",
    "infy": "INFY.NS",
    "hdfc bank": "HDFCBANK.NS",
    "hdfcbank": "HDFCBANK.NS",
    "icici bank": "ICICIBANK.NS",
    "icicibank": "ICICIBANK.NS",
    "sbi": "SBIN.NS",
    "state bank": "SBIN.NS",
    "wipro": "WIPRO.NS",
    "itc": "ITC.NS",
    "tata motors": "TATAMOTORS.NS",
    "tatamotors": "TATAMOTORS.NS",
    "tata steel": "TATASTEEL.NS",
    "hcl": "HCLTECH.NS",
    "hcl tech": "HCLTECH.NS",
    "bajaj finance": "BAJFINANCE.NS",
    "bajaj finserv": "BAJAJFINSV.NS",
    "airtel": "BHARTIARTL.NS",
    "bharti airtel": "BHARTIARTL.NS",
    "kotak": "KOTAKBANK.NS",
    "kotak bank": "KOTAKBANK.NS",
    "l&t": "LT.NS",
    "larsen": "LT.NS",
    "asian paints": "ASIANPAINT.NS",
    "axis bank": "AXISBANK.NS",
    "maruti": "MARUTI.NS",
    "maruti suzuki": "MARUTI.NS",
    "titan": "TITAN.NS",
    "sun pharma": "SUNPHARMA.NS",
    "sunpharma": "SUNPHARMA.NS",
    "zomato": "ZOMATO.NS",
    "paytm": "PAYTM.NS",
    "nykaa": "NYKAA.NS",
    "lti": "LT.NS",
    "ongc": "ONGC.NS",
    "ntpc": "NTPC.NS",
    "power grid": "POWERGRID.NS",
    "powergrid": "POWERGRID.NS",
    "coal india": "COALINDIA.NS",
    "bpcl": "BPCL.NS",
    "dr reddy": "DRREDDY.NS",
    "dr reddys": "DRREDDY.NS",
    "cipla": "CIPLA.NS",
    "hero": "HEROMOTOCO.NS",
    "hero motocorp": "HEROMOTOCO.NS",
    "eicher": "EICHERMOT.NS",
    "royal enfield": "EICHERMOT.NS",
    "mahindra": "M&M.NS",
    "m&m": "M&M.NS",
    "irctc": "IRCTC.NS",
    "hal": "HAL.NS",
    "bel": "BEL.NS",
    "adani": "ADANIENT.NS",
    "adani enterprises": "ADANIENT.NS",
    "adani ports": "ADANIPORTS.NS",
    "lici": "LICI.NS",
    "lic": "LICI.NS",
}

_DATA_DIR = Path(__file__).parent.parent / "data"


@dataclass
class IndianMarketSettings:
    enabled: bool
    default_exchange: str
    zerodha_configured: bool
    upstox_configured: bool

    @classmethod
    def from_env(cls) -> "IndianMarketSettings":
        from hushh_mcp.adapters.upstox_adapter import UpstoxConfig
        from hushh_mcp.adapters.zerodha_kite_adapter import ZerodhaKiteConfig

        enabled_raw = (os.getenv("INDIAN_MARKET_ENABLED") or "true").strip().lower()
        enabled = enabled_raw not in {"0", "false", "no", "off"}
        default_exchange = (os.getenv("INDIAN_MARKET_DEFAULT_EXCHANGE") or "NSE").strip().upper()
        return cls(
            enabled=enabled,
            default_exchange=default_exchange,
            zerodha_configured=ZerodhaKiteConfig.from_env().configured,
            upstox_configured=UpstoxConfig.from_env().configured,
        )


def normalize_indian_symbol(symbol: str, *, default_exchange: str = "NSE") -> str:
    """Normalise a raw user symbol to a yfinance-compatible ticker.

    Examples
    --------
    >>> normalize_indian_symbol("RELIANCE")   # → "RELIANCE.NS"
    >>> normalize_indian_symbol("RELIANCE.NS")  # → "RELIANCE.NS"
    >>> normalize_indian_symbol("RELIANCE.BO")  # → "RELIANCE.BO"
    >>> normalize_indian_symbol("reliance")   # → "RELIANCE.NS"
    """
    s = symbol.strip().upper()
    if _INDIAN_SUFFIX_RE.search(s):
        return s
    suffix = ".BO" if default_exchange.upper() == "BSE" else ".NS"
    return s + suffix


def is_indian_symbol(symbol: str) -> bool:
    """Return True if the symbol belongs to NSE or BSE."""
    s = (symbol or "").strip().upper()
    return bool(_INDIAN_SUFFIX_RE.search(s))


def resolve_spoken_to_symbol(utterance: str) -> str | None:
    """Map a spoken stock name to its NSE symbol, or None if unrecognised."""
    key = utterance.strip().lower()
    return _SPOKEN_TO_SYMBOL.get(key)


def resolve_index_symbol(name: str) -> str | None:
    """Map an index name to its Yahoo Finance symbol."""
    return _INDEX_MAP.get(name.strip().lower())


class IndianMarketService:
    """Market data service for Indian exchanges (NSE/BSE).

    Uses yfinance (via Yahoo Finance HTTP API) as the primary provider.
    Falls back gracefully; no API key required.
    """

    def __init__(self) -> None:
        self._http: httpx.AsyncClient | None = None
        self._symbol_list: list[dict[str, Any]] | None = None
        self._l1_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                headers=_YF_HEADERS,
                timeout=_YF_TIMEOUT_SECONDS,
                follow_redirects=True,
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ------------------------------------------------------------------
    # Static symbol list
    # ------------------------------------------------------------------

    def _load_symbol_list(self) -> list[dict[str, Any]]:
        if self._symbol_list is not None:
            return self._symbol_list
        path = _DATA_DIR / "indian_symbols.json"
        try:
            with path.open("r", encoding="utf-8") as fh:
                self._symbol_list = json.load(fh)
        except Exception as exc:
            logger.warning("[IndianMarket] could not load symbol list: %s", exc)
            self._symbol_list = []
        return self._symbol_list

    def search_symbol(self, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
        """Search the bundled static NSE/BSE symbol list."""
        q = query.strip().lower()
        if not q:
            return []
        symbols = self._load_symbol_list()
        results: list[dict[str, Any]] = []
        for entry in symbols:
            sym = (entry.get("symbol") or "").lower()
            name = (entry.get("name") or "").lower()
            if q in sym or q in name:
                results.append(entry)
                if len(results) >= limit:
                    break
        return results

    # ------------------------------------------------------------------
    # Quote (yfinance)
    # ------------------------------------------------------------------

    def _l1_get(self, key: str) -> dict[str, Any] | None:
        entry = self._l1_cache.get(key)
        if entry and time.time() < entry[0]:
            return entry[1]
        return None

    def _l1_set(self, key: str, value: dict[str, Any]) -> None:
        self._l1_cache[key] = (time.time() + _L1_TTL_SECONDS, value)

    async def get_quote(self, symbol: str, *, default_exchange: str = "NSE") -> dict[str, Any]:
        """Fetch a live quote for an Indian equity.

        ``symbol`` can be:
        - ``RELIANCE`` (auto-resolved to ``RELIANCE.NS`` for NSE default)
        - ``RELIANCE.NS`` / ``RELIANCE.BO`` (used as-is)

        Returns a dict with keys: symbol, name, price, change, change_pct,
        currency, exchange, high_52w, low_52w, volume, market_cap, source.
        """
        yf_symbol = normalize_indian_symbol(symbol, default_exchange=default_exchange)
        cache_key = f"indian_quote:{yf_symbol}"

        # L1
        cached = self._l1_get(cache_key)
        if cached:
            return cached

        # L2
        cache_svc = get_market_cache_store_service()
        try:
            l2 = await cache_svc.get_entry(cache_key)
            if l2 and l2.is_fresh():
                self._l1_set(cache_key, l2.payload)
                return l2.payload  # type: ignore[return-value]
        except Exception:
            pass

        # L3 — yfinance
        result = await self._fetch_yfinance_quote(yf_symbol)

        # Write back to L2 and L1
        try:
            await cache_svc.set_entry(
                cache_key=cache_key,
                payload=result,
                fresh_ttl_seconds=_FRESH_TTL_SECONDS,
                stale_ttl_seconds=_STALE_TTL_SECONDS,
                provider_status={"provider": result.get("source", "yfinance")},
            )
        except Exception:
            pass
        self._l1_set(cache_key, result)
        return result

    async def _fetch_yfinance_quote(self, yf_symbol: str) -> dict[str, Any]:
        try:
            url = _YFINANCE_QUOTE_URL.format(symbol=yf_symbol)
            resp = await self.http.get(url, params={"interval": "1d", "range": "1d"})
            resp.raise_for_status()
            raw = resp.json()
            meta = raw.get("chart", {}).get("result", [{}])[0].get("meta", {})
            return {
                "symbol": yf_symbol,
                "name": meta.get("longName") or meta.get("shortName") or yf_symbol,
                "price": meta.get("regularMarketPrice"),
                "previous_close": meta.get("chartPreviousClose"),
                "change": (
                    round(
                        (meta.get("regularMarketPrice") or 0)
                        - (meta.get("chartPreviousClose") or 0),
                        2,
                    )
                    if meta.get("regularMarketPrice") and meta.get("chartPreviousClose")
                    else None
                ),
                "change_pct": (
                    round(
                        (
                            (meta.get("regularMarketPrice") or 0)
                            - (meta.get("chartPreviousClose") or 0)
                        )
                        / (meta.get("chartPreviousClose") or 1)
                        * 100,
                        2,
                    )
                    if meta.get("regularMarketPrice") and meta.get("chartPreviousClose")
                    else None
                ),
                "currency": meta.get("currency") or "INR",
                "exchange": meta.get("exchangeName") or (
                    "NSE" if yf_symbol.endswith(".NS") else "BSE"
                ),
                "high_52w": meta.get("fiftyTwoWeekHigh"),
                "low_52w": meta.get("fiftyTwoWeekLow"),
                "volume": meta.get("regularMarketVolume"),
                "market_cap": meta.get("marketCap"),
                "source": "yfinance",
                "fetched_at": time.time(),
            }
        except Exception as exc:
            logger.warning("[IndianMarket] yfinance quote failed for %s: %s", yf_symbol, exc)
            return {
                "symbol": yf_symbol,
                "error": str(exc),
                "currency": "INR",
                "source": "yfinance_error",
                "fetched_at": time.time(),
            }

    # ------------------------------------------------------------------
    # Indices
    # ------------------------------------------------------------------

    async def get_indices(self) -> list[dict[str, Any]]:
        """Fetch Nifty 50, Sensex, and Bank Nifty snapshots."""
        indices = [
            ("Nifty 50", "^NSEI"),
            ("Sensex", "^BSESN"),
            ("Bank Nifty", "^NSEBANK"),
        ]
        results = []
        for display_name, yf_symbol in indices:
            quote = await self._fetch_yfinance_quote(yf_symbol)
            quote["display_name"] = display_name
            results.append(quote)
        return results

    async def get_index_quote(self, name: str) -> dict[str, Any]:
        """Fetch a single index by spoken/written name."""
        yf_symbol = resolve_index_symbol(name) or name
        quote = await self._fetch_yfinance_quote(yf_symbol)
        quote["display_name"] = name
        return quote


_indian_market_service: IndianMarketService | None = None


def get_indian_market_service() -> IndianMarketService:
    global _indian_market_service
    if _indian_market_service is None:
        _indian_market_service = IndianMarketService()
    return _indian_market_service
