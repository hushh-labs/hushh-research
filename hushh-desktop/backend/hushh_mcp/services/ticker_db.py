"""
Ticker Database Service
=======================

Simple service to search and upsert public tickers (imported from SEC company_tickers.json).

Public search endpoints should use this service (no consent required).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from db.db_client import get_db

logger = logging.getLogger(__name__)

_ENRICHED_COLUMNS = (
    "ticker,title,cik,exchange,sic_code,sic_description,"
    "sector_primary,industry_primary,sector_tags,metadata_confidence,tradable"
)
_LEGACY_COLUMNS = "ticker,title,cik,exchange"

_NON_TRADABLE_SYMBOLS = {
    "BUY",
    "SELL",
    "REINVEST",
    "DIVIDEND",
    "INTEREST",
    "TRANSFER",
    "WITHDRAWAL",
    "DEPOSIT",
    "CASH",
    "QACDS",
    "MMF",
    "SWEEP",
}
_TRADABLE_TICKER_PATTERN = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")
_SECTOR_KEYWORDS = {
    "technology": "Technology",
    "semiconductor": "Technology",
    "software": "Technology",
    "cloud": "Technology",
    "internet": "Technology",
    "bank": "Financials",
    "insurance": "Financials",
    "financial": "Financials",
    "trust": "Financials",
    "health": "Healthcare",
    "pharma": "Healthcare",
    "biotech": "Healthcare",
    "medical": "Healthcare",
    "energy": "Energy",
    "oil": "Energy",
    "gas": "Energy",
    "consumer": "Consumer Discretionary",
    "retail": "Consumer Discretionary",
    "telecom": "Communication Services",
    "communication": "Communication Services",
    "media": "Communication Services",
    "industrial": "Industrials",
    "machinery": "Industrials",
    "aerospace": "Industrials",
    "defense": "Industrials",
    "real estate": "Real Estate",
    "reit": "Real Estate",
    "realty": "Real Estate",
    "utility": "Utilities",
    "electric": "Utilities",
    "power": "Utilities",
    "material": "Materials",
    "steel": "Materials",
    "chemical": "Materials",
    "mining": "Materials",
    "gold": "Commodities",
    "silver": "Commodities",
    "commodity": "Commodities",
    "cash": "Cash & Cash Equivalents",
    "money market": "Cash & Cash Equivalents",
    "sweep": "Cash & Cash Equivalents",
    "bond": "Fixed Income Taxable",
    "municipal": "Fixed Income Tax-Exempt",
    "tax free": "Fixed Income Tax-Exempt",
    "tax-exempt": "Fixed Income Tax-Exempt",
}
_INVALID_METADATA_VALUES = {
    "",
    "n/a",
    "na",
    "none",
    "unknown",
    "null",
    "not available",
    "unclassified",
    "other",
    "others",
    "misc",
    "miscellaneous",
}
_CASH_HINTS = ("cash", "sweep", "money market", "core position", "deposit")


def _normalize_ticker_row(row: Dict) -> Dict:
    sector_primary = row.get("sector_primary")
    industry_primary = row.get("industry_primary")
    return {
        "ticker": row.get("ticker"),
        "title": row.get("title"),
        "cik": row.get("cik"),
        "exchange": row.get("exchange"),
        "sic_code": row.get("sic_code"),
        "sic_description": row.get("sic_description"),
        "sector_primary": sector_primary,
        "industry_primary": industry_primary,
        # Additive aliases for lightweight UI consumers.
        "sector": sector_primary,
        "industry": industry_primary,
        "sector_tags": row.get("sector_tags") if isinstance(row.get("sector_tags"), list) else [],
        "metadata_confidence": row.get("metadata_confidence"),
        "tradable": row.get("tradable", True),
    }


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_symbol(raw: Any) -> str:
    text = _clean_text(raw).upper()
    if not text:
        return ""
    sanitized = "".join(ch for ch in text if ch.isalnum() or ch in ".-")
    if not sanitized:
        return ""
    if sanitized in _NON_TRADABLE_SYMBOLS:
        return "CASH" if sanitized in {"CASH", "QACDS", "MMF", "SWEEP"} else ""
    if not _TRADABLE_TICKER_PATTERN.fullmatch(sanitized):
        return ""
    return sanitized


def _normalize_sector(value: Any) -> Optional[str]:
    text = _clean_text(value)
    if not text:
        return None
    lower = text.lower()
    if lower in _INVALID_METADATA_VALUES:
        return None
    for key, normalized in _SECTOR_KEYWORDS.items():
        if key in lower:
            return normalized
    return text[:80]


def _normalize_industry(value: Any) -> Optional[str]:
    text = _clean_text(value)
    if not text:
        return None
    if text.lower() in _INVALID_METADATA_VALUES:
        return None
    return text[:120]


def _is_cash_like_holding(holding: Dict[str, Any]) -> bool:
    normalized_symbol = _normalize_symbol(holding.get("symbol") or holding.get("ticker"))
    if normalized_symbol == "CASH":
        return True

    name = _clean_text(
        holding.get("name") or holding.get("description") or holding.get("title")
    ).lower()
    asset_type = _clean_text(
        holding.get("asset_type") or holding.get("asset_class") or holding.get("instrument_kind")
    ).lower()
    if any(hint in name for hint in _CASH_HINTS):
        return True
    if any(hint in asset_type for hint in _CASH_HINTS):
        return True
    return bool(holding.get("is_cash_equivalent"))


def _infer_sector_from_holding(holding: Dict[str, Any]) -> Optional[str]:
    explicit = _normalize_sector(
        holding.get("sector")
        or holding.get("sector_primary")
        or holding.get("asset_category")
        or holding.get("asset_type")
        or holding.get("instrument_kind")
    )
    if explicit:
        return explicit

    name = _clean_text(holding.get("name") or holding.get("description") or holding.get("title"))
    if not name:
        return None
    return _normalize_sector(name)


def _infer_industry_from_holding(holding: Dict[str, Any]) -> Optional[str]:
    return _normalize_industry(
        holding.get("industry")
        or holding.get("industry_primary")
        or holding.get("sic_description")
        or holding.get("asset_category")
    )


def _build_sector_tags(sector_primary: Optional[str], industry_primary: Optional[str]) -> list[str]:
    out: list[str] = []
    for raw in (sector_primary, industry_primary):
        text = _clean_text(raw)
        if text and text not in out:
            out.append(text)
    return out[:6]


def _confidence_score(*, has_sector: bool, has_industry: bool, has_sic: bool = False) -> float:
    score = 0.2
    if has_sector:
        score += 0.4
    if has_industry:
        score += 0.25
    if has_sic:
        score += 0.15
    return min(1.0, round(score, 3))


class TickerDBService:
    def __init__(self):
        self._db = None
        self._finnhub_rate_lock = asyncio.Lock()
        self._finnhub_next_call_at = 0.0
        self._fmp_rate_lock = asyncio.Lock()
        self._fmp_next_call_at = 0.0

    def _get_db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def search_tickers(self, q: str, limit: int = 10) -> List[Dict]:
        """
        Search tickers by prefix match on ticker symbol or fuzzy match on company title.

        Args:
            q: query string (ticker or company name)
            limit: max results
        Returns:
            List of tickers: { ticker, title, cik, exchange }
        """
        db = self._get_db()

        q_clean = q.strip()
        if not q_clean:
            return []

        # If looks like a ticker (alphanumeric short), prefer ticker prefix search
        ticker_like = bool(re.fullmatch(r"[A-Za-z.]{1,8}", q_clean))
        pattern = f"{q_clean}%" if ticker_like else f"%{q_clean}%"
        field = "ticker" if ticker_like else "title"
        order_field = "ticker" if ticker_like else "title"

        try:
            res = (
                db.table("tickers")
                .select(_ENRICHED_COLUMNS)
                .ilike(field, pattern)
                .order(order_field)
                .limit(limit)
                .execute()
            )
            return [_normalize_ticker_row(row) for row in (res.data or [])]
        except Exception as exc:
            logger.warning(
                "[TickerDB] Enriched ticker columns unavailable, falling back to legacy columns: %s",
                exc,
            )
            legacy_res = (
                db.table("tickers")
                .select(_LEGACY_COLUMNS)
                .ilike(field, pattern)
                .order(order_field)
                .limit(limit)
                .execute()
            )
            return [_normalize_ticker_row(row) for row in (legacy_res.data or [])]

    async def upsert_tickers_bulk(self, rows: List[Dict]) -> int:
        """Upsert a list of ticker rows. Returns count upserted."""
        if not rows:
            return 0

        db = self._get_db()
        # Ensure keys align: ticker, title, cik, exchange, updated_at
        prepared = []
        for r in rows:
            prepared.append(
                {
                    "ticker": (r.get("ticker") or "").upper(),
                    "title": r.get("title"),
                    "cik": r.get("cik"),
                    "exchange": r.get("exchange"),
                    "sic_code": r.get("sic_code"),
                    "sic_description": r.get("sic_description"),
                    "sector_primary": r.get("sector_primary"),
                    "industry_primary": r.get("industry_primary"),
                    "sector_tags": r.get("sector_tags") or [],
                    "metadata_confidence": r.get("metadata_confidence") or 0.0,
                    "tradable": r.get("tradable", True),
                    "last_enriched_at": r.get("last_enriched_at"),
                    "updated_at": r.get("updated_at"),
                }
            )

        result = db.table("tickers").upsert(prepared, on_conflict="ticker").execute()
        return result.count or (len(result.data) if result.data else 0)

    @staticmethod
    def _extract_symbol_seed(holding: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(holding, dict):
            return None

        raw_symbol = (
            holding.get("symbol")
            or holding.get("ticker")
            or holding.get("ticker_symbol")
            or holding.get("display_ticker")
            or holding.get("security_symbol")
        )
        symbol = _normalize_symbol(raw_symbol)
        if not symbol:
            return None

        name = _clean_text(
            holding.get("name")
            or holding.get("description")
            or holding.get("security_name")
            or holding.get("title")
            or holding.get("company_name")
        )
        sector = _infer_sector_from_holding(holding)
        industry = _infer_industry_from_holding(holding)
        is_cash = _is_cash_like_holding(holding)
        if is_cash and not sector:
            sector = "Cash & Cash Equivalents"
        if is_cash and not industry:
            industry = "Cash Management"

        tradable = bool(holding.get("is_investable", True)) and not is_cash
        if symbol == "CASH":
            tradable = False

        return {
            "ticker": symbol,
            "title": name or symbol,
            "sector_primary": sector,
            "industry_primary": industry,
            "tradable": tradable,
            "is_cash_equivalent": is_cash,
        }

    async def _fetch_finnhub_profile(
        self,
        client: httpx.AsyncClient,
        symbol: str,
        finnhub_key: str,
        *,
        attempt: int = 0,
    ) -> Dict[str, Any]:
        if not finnhub_key:
            return {}
        calls_per_minute = max(1, int(os.getenv("FINNHUB_CALLS_PER_MINUTE", "55")))
        min_interval = 60.0 / float(calls_per_minute)
        try:
            async with self._finnhub_rate_lock:
                now = time.monotonic()
                wait = self._finnhub_next_call_at - now
                if wait > 0:
                    await asyncio.sleep(wait)
                    now = time.monotonic()
                self._finnhub_next_call_at = now + min_interval

            response = await client.get(
                "https://finnhub.io/api/v1/stock/profile2",
                params={"symbol": symbol, "token": finnhub_key},
            )
            if response.status_code == 429:
                if attempt >= 2:
                    return {}
                reset_epoch = int(response.headers.get("x-ratelimit-reset", "0") or 0)
                wait_seconds = max(1.0, float(reset_epoch - int(time.time())))
                await asyncio.sleep(min(wait_seconds, 30.0))
                return await self._fetch_finnhub_profile(
                    client, symbol, finnhub_key, attempt=attempt + 1
                )
            if not response.is_success:
                return {}
            payload = response.json() or {}
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    async def _fetch_fmp_profile(
        self,
        client: httpx.AsyncClient,
        symbol: str,
        fmp_key: str,
        *,
        attempt: int = 0,
    ) -> Dict[str, Any]:
        if not fmp_key:
            return {}
        try:
            calls_per_minute = max(1, int(os.getenv("FMP_CALLS_PER_MINUTE", "240")))
            min_interval = 60.0 / float(calls_per_minute)
            async with self._fmp_rate_lock:
                now = time.monotonic()
                wait = self._fmp_next_call_at - now
                if wait > 0:
                    await asyncio.sleep(wait)
                    now = time.monotonic()
                self._fmp_next_call_at = now + min_interval

            response = await client.get(
                "https://financialmodelingprep.com/stable/profile",
                params={"symbol": symbol, "apikey": fmp_key},
            )
            if response.status_code == 429:
                if attempt >= 2:
                    return {}
                retry_after = response.headers.get("retry-after", "").strip()
                try:
                    wait_seconds = float(retry_after)
                except ValueError:
                    wait_seconds = 2.0 * (attempt + 1)
                await asyncio.sleep(min(max(wait_seconds, 1.0), 30.0))
                return await self._fetch_fmp_profile(client, symbol, fmp_key, attempt=attempt + 1)
            if not response.is_success:
                return {}
            payload = response.json() or []
            if isinstance(payload, list) and payload:
                first = payload[0] or {}
                return first if isinstance(first, dict) else {}
            return {}
        except Exception:
            return {}

    async def enrich_symbols(
        self,
        symbols: List[str],
        *,
        refresh_cache: bool = True,
    ) -> Dict[str, int]:
        cleaned_symbols = []
        seen: set[str] = set()
        for raw in symbols:
            symbol = _normalize_symbol(raw)
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            cleaned_symbols.append(symbol)

        if not cleaned_symbols:
            return {"attempted": 0, "updated": 0}

        finnhub_key = _clean_text(os.getenv("FINNHUB_API_KEY"))
        fmp_key = _clean_text(os.getenv("PMP_API_KEY") or os.getenv("FMP_API_KEY"))
        if not finnhub_key and not fmp_key:
            return {"attempted": len(cleaned_symbols), "updated": 0}

        timeout = httpx.Timeout(connect=4.0, read=7.0, write=7.0, pool=4.0)
        rows_to_upsert: list[Dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=timeout) as client:
            for symbol in cleaned_symbols:
                fmp_profile = await self._fetch_fmp_profile(client, symbol, fmp_key)
                needs_finnhub = bool(finnhub_key) and (
                    not _clean_text(
                        fmp_profile.get("sector")
                        or fmp_profile.get("industry")
                        or fmp_profile.get("exchangeShortName")
                        or fmp_profile.get("exchange")
                    )
                )
                finnhub_profile = (
                    await self._fetch_finnhub_profile(client, symbol, finnhub_key)
                    if needs_finnhub
                    else {}
                )
                sector = _normalize_sector(
                    fmp_profile.get("sector")
                    or finnhub_profile.get("gicsSector")
                    or finnhub_profile.get("gics_sector")
                    or finnhub_profile.get("finnhubIndustry")
                )
                industry = _normalize_industry(
                    fmp_profile.get("industry")
                    or finnhub_profile.get("gicsSubIndustry")
                    or finnhub_profile.get("gics_sub_industry")
                    or finnhub_profile.get("finnhubIndustry")
                )
                exchange = (
                    _clean_text(
                        fmp_profile.get("exchangeShortName") or finnhub_profile.get("exchange")
                    )
                    or None
                )

                if not sector and not industry and not exchange:
                    continue

                rows_to_upsert.append(
                    {
                        "ticker": symbol,
                        "sector_primary": sector,
                        "industry_primary": industry,
                        "sector_tags": _build_sector_tags(sector, industry),
                        "metadata_confidence": _confidence_score(
                            has_sector=bool(sector), has_industry=bool(industry)
                        ),
                        "exchange": exchange,
                        "last_enriched_at": datetime.now(timezone.utc).isoformat(),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                )

        updated = 0
        if rows_to_upsert:
            updated = await self.upsert_tickers_bulk(rows_to_upsert)

        if updated > 0 and refresh_cache:
            try:
                from hushh_mcp.services.ticker_cache import ticker_cache

                ticker_cache.load_from_db()
            except Exception as exc:
                logger.warning("Ticker cache refresh after enrichment failed: %s", exc)

        return {"attempted": len(cleaned_symbols), "updated": updated}

    async def sync_holdings_symbols(
        self,
        holdings: List[Dict[str, Any]],
        *,
        max_symbols: int = 200,
        enrich_missing: bool = True,
        refresh_cache: bool = True,
    ) -> Dict[str, Any]:
        if not isinstance(holdings, list) or not holdings:
            return {
                "symbols_seen": 0,
                "seeded_rows": 0,
                "seed_updates": 0,
                "enrichment_attempted": 0,
                "enrichment_updated": 0,
            }

        seeds_by_symbol: Dict[str, Dict[str, Any]] = {}
        for holding in holdings:
            seed = self._extract_symbol_seed(holding)
            if not seed:
                continue
            symbol = seed["ticker"]
            if symbol in seeds_by_symbol:
                existing = seeds_by_symbol[symbol]
                if not existing.get("sector_primary") and seed.get("sector_primary"):
                    existing["sector_primary"] = seed["sector_primary"]
                if not existing.get("industry_primary") and seed.get("industry_primary"):
                    existing["industry_primary"] = seed["industry_primary"]
                if not existing.get("title") and seed.get("title"):
                    existing["title"] = seed["title"]
                existing["tradable"] = bool(existing.get("tradable", True)) and bool(
                    seed.get("tradable", True)
                )
            else:
                seeds_by_symbol[symbol] = seed
            if len(seeds_by_symbol) >= max(1, max_symbols):
                break

        symbols = sorted(seeds_by_symbol.keys())
        if not symbols:
            return {
                "symbols_seen": 0,
                "seeded_rows": 0,
                "seed_updates": 0,
                "enrichment_attempted": 0,
                "enrichment_updated": 0,
            }

        db = self._get_db()
        existing_rows_raw = (
            db.table("tickers")
            .select("ticker,title,sector_primary,industry_primary,metadata_confidence,tradable")
            .in_("ticker", symbols)
            .execute()
            .data
            or []
        )
        existing_rows: Dict[str, Dict[str, Any]] = {
            _clean_text(row.get("ticker")).upper(): row
            for row in existing_rows_raw
            if row.get("ticker")
        }

        rows_to_seed: list[Dict[str, Any]] = []
        rows_to_update: list[Dict[str, Any]] = []
        symbols_to_enrich: list[str] = []

        now_iso = datetime.now(timezone.utc).isoformat()
        for symbol in symbols:
            seed = seeds_by_symbol[symbol]
            current = existing_rows.get(symbol)
            if not current:
                sector = seed.get("sector_primary")
                industry = seed.get("industry_primary")
                rows_to_seed.append(
                    {
                        "ticker": symbol,
                        "title": seed.get("title") or symbol,
                        "sector_primary": sector,
                        "industry_primary": industry,
                        "sector_tags": _build_sector_tags(sector, industry),
                        "metadata_confidence": _confidence_score(
                            has_sector=bool(sector), has_industry=bool(industry)
                        ),
                        "tradable": bool(seed.get("tradable", True)),
                        "last_enriched_at": now_iso if sector or industry else None,
                        "updated_at": now_iso,
                    }
                )
                if not sector or not industry:
                    symbols_to_enrich.append(symbol)
                continue

            current_sector = _normalize_sector(current.get("sector_primary"))
            current_industry = _normalize_industry(current.get("industry_primary"))
            seed_sector = seed.get("sector_primary")
            seed_industry = seed.get("industry_primary")

            needs_update = False
            update_row: Dict[str, Any] = {"ticker": symbol}
            if not current_sector and seed_sector:
                update_row["sector_primary"] = seed_sector
                needs_update = True
            if not current_industry and seed_industry:
                update_row["industry_primary"] = seed_industry
                needs_update = True
            if needs_update:
                final_sector = update_row.get("sector_primary") or current_sector
                final_industry = update_row.get("industry_primary") or current_industry
                update_row["sector_tags"] = _build_sector_tags(final_sector, final_industry)
                update_row["metadata_confidence"] = _confidence_score(
                    has_sector=bool(final_sector), has_industry=bool(final_industry)
                )
                update_row["last_enriched_at"] = now_iso
                update_row["updated_at"] = now_iso
                rows_to_update.append(update_row)

            if not current_sector or not current_industry:
                symbols_to_enrich.append(symbol)

        seeded_rows = await self.upsert_tickers_bulk(rows_to_seed) if rows_to_seed else 0
        seed_updates = await self.upsert_tickers_bulk(rows_to_update) if rows_to_update else 0

        enrichment_attempted = 0
        enrichment_updated = 0
        if enrich_missing and symbols_to_enrich:
            enrich_result = await self.enrich_symbols(
                symbols_to_enrich,
                refresh_cache=refresh_cache,
            )
            enrichment_attempted = int(enrich_result.get("attempted") or 0)
            enrichment_updated = int(enrich_result.get("updated") or 0)
        elif (seeded_rows > 0 or seed_updates > 0) and refresh_cache:
            try:
                from hushh_mcp.services.ticker_cache import ticker_cache

                ticker_cache.load_from_db()
            except Exception as exc:
                logger.warning("Ticker cache refresh after seed sync failed: %s", exc)

        return {
            "symbols_seen": len(symbols),
            "seeded_rows": seeded_rows,
            "seed_updates": seed_updates,
            "enrichment_attempted": enrichment_attempted,
            "enrichment_updated": enrichment_updated,
        }
