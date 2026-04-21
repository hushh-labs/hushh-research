"""Kai market insights route for /kai home revamp.

Provides cached, provider-backed market overview data with graceful degradation.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from datetime import datetime, timezone
from time import time
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.encoders import jsonable_encoder

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from hushh_mcp.operons.kai.fetchers import (
    fetch_market_data,
    fetch_market_data_batch,
    fetch_market_news,
)
from hushh_mcp.services.market_cache_store import get_market_cache_store_service
from hushh_mcp.services.market_insights_cache import market_insights_cache
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service
from hushh_mcp.services.renaissance_service import TIER_WEIGHTS, get_renaissance_service
from hushh_mcp.services.ria_iam_service import RIAIAMService
from hushh_mcp.services.symbol_master_service import get_symbol_master_service

logger = logging.getLogger(__name__)

router = APIRouter()

HOME_FRESH_TTL_SECONDS = 600
HOME_STALE_TTL_SECONDS = 1800

QUOTES_FRESH_TTL_SECONDS = 600
QUOTES_STALE_TTL_SECONDS = 1800
MOVERS_FRESH_TTL_SECONDS = 600
MOVERS_STALE_TTL_SECONDS = 1800
SECTORS_FRESH_TTL_SECONDS = 600
SECTORS_STALE_TTL_SECONDS = 1800
NEWS_FRESH_TTL_SECONDS = 600
NEWS_STALE_TTL_SECONDS = 1800
RECOMMENDATION_FRESH_TTL_SECONDS = 600
RECOMMENDATION_STALE_TTL_SECONDS = 1800
FINANCIAL_SUMMARY_FRESH_TTL_SECONDS = 600
FINANCIAL_SUMMARY_STALE_TTL_SECONDS = 1800

DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]
DEFAULT_PICK_SOURCE_ID = "default"
QUOTE_SYMBOL_ALIASES: dict[str, str] = {
    "BRKA": "BRK-A",
    "BRKB": "BRK-B",
    "CMCS1": "CMCSA",
}
WATCHLIST_MAX = 8
NEWS_SYMBOL_MAX = 3
NEWS_ROWS_MAX = 12
QUOTE_FANOUT_CONCURRENCY = 4
RECOMMENDATION_FANOUT_CONCURRENCY = 4
NEWS_FANOUT_CONCURRENCY = 2
PROVIDER_COOLDOWN_BY_STATUS: dict[int, int] = {
    400: 20 * 60,
    401: 15 * 60,
    402: 15 * 60,
    403: 10 * 60,
    404: 20 * 60,
    429: 5 * 60,
}
FMP_GLOBAL_COOLDOWN_KEY = "fmp:global"
VIX_SERIES_KEY = "macro:vix"
VIX_SERIES_MAX_AGE_SECONDS = 24 * 60 * 60

SECTOR_ETF_MAP: dict[str, str] = {
    "Technology": "XLK",
    "Financials": "XLF",
    "Energy": "XLE",
    "Consumer Discretionary": "XLY",
    "Industrials": "XLI",
    "Health Care": "XLV",
    "Consumer Staples": "XLP",
    "Utilities": "XLU",
    "Materials": "XLB",
    "Real Estate": "XLRE",
    "Communication Services": "XLC",
}
_MARKET_REFRESH_TASK: asyncio.Task | None = None
_MARKET_REFRESH_LOCK_KEY = 8_625_401


def _empty_market_home_payload(
    *,
    user_id: str,
    requested_watchlist_symbols: list[str],
    filtered_symbols: list[dict[str, Any]],
    stale_reason: str,
    provider_status: dict[str, str] | None = None,
    market_mode: str = "personalized",
) -> dict[str, Any]:
    status_map = provider_status or {"home": "failed"}
    generated_at = _now_iso()
    is_personalized = market_mode == "personalized"
    return {
        "layout_version": "kai_home_v2",
        "user_id": user_id,
        "generated_at": generated_at,
        "stale": True,
        "stale_reason": stale_reason,
        "cache_age_seconds": 0,
        "provider_status": status_map,
        "hero": {
            "total_value": None,
            "day_change_value": None,
            "day_change_pct": None,
            "sparkline_points": [],
            "as_of": generated_at,
            "source_tags": ["Unavailable"],
            "degraded": True,
            "holdings_count": 0 if is_personalized else None,
            "portfolio_value_bucket": None,
        },
        "watchlist": [],
        "pick_sources": [_default_pick_source()],
        "active_pick_source": DEFAULT_PICK_SOURCE_ID,
        "pick_rows": [],
        "renaissance_list": [],
        "movers": {
            "gainers": [],
            "losers": [],
            "active": [],
            "as_of": generated_at,
            "source_tags": ["Unavailable"],
            "degraded": True,
        },
        "sector_rotation": [],
        "news_tape": [],
        "signals": [],
        "meta": {
            "stale": True,
            "stale_reason": stale_reason,
            "provider_status": status_map,
            "cache_age_seconds": 0,
            "cache_tier": "live",
            "cache_hit": False,
            "warm_source": "request",
            "market_mode": market_mode,
            "baseline_cache_tier": "live" if not is_personalized else None,
            "personalized_cache_tier": "live" if is_personalized else None,
            "provider_cooldowns": market_insights_cache.provider_cooldown_snapshot(),
            "symbol_quality": {
                "requested_count": len(requested_watchlist_symbols),
                "accepted_count": 0,
                "filtered_count": len(filtered_symbols),
            },
            "filtered_symbols": filtered_symbols,
        },
        # Backward compatibility fields.
        "market_overview": [],
        "spotlights": [],
        "themes": [],
    }


def _default_pick_source() -> dict[str, Any]:
    return {
        "id": DEFAULT_PICK_SOURCE_ID,
        "label": "Default list",
        "kind": "default",
        "state": "ready",
        "is_default": True,
        "share_status": None,
        "share_origin": "default",
        "share_granted_at": None,
    }


def _normalize_pick_source(value: str | None) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return DEFAULT_PICK_SOURCE_ID
    if normalized.lower() == DEFAULT_PICK_SOURCE_ID:
        return DEFAULT_PICK_SOURCE_ID
    if normalized.startswith("ria:"):
        return normalized
    return DEFAULT_PICK_SOURCE_ID


def _repair_quote_symbol(symbol: str | None) -> tuple[str, bool]:
    normalized = str(symbol or "").strip().upper()
    if not normalized:
        return "", False

    alias_target = QUOTE_SYMBOL_ALIASES.get(normalized)
    if alias_target:
        return alias_target, True

    dotted = normalized.replace(".", "-")
    if dotted != normalized:
        return dotted, True

    return normalized, False


def _pick_source_roster_signature(ria_sources: list[dict[str, Any]]) -> str:
    if not ria_sources:
        return "none"

    parts: list[str] = []
    for item in ria_sources:
        artifact_identity = (
            str(item.get("artifact_id") or "").strip() or str(item.get("upload_id") or "").strip()
        )
        parts.append(
            ":".join(
                [
                    str(item.get("id") or "").strip(),
                    str(item.get("state") or "").strip(),
                    str(item.get("share_status") or "").strip(),
                    artifact_identity,
                    str(item.get("source_data_version") or "").strip(),
                    str(item.get("artifact_updated_at") or "").strip(),
                ]
            )
        )
    return "|".join(sorted(parts))


def _market_home_cache_key(
    *,
    user_id: str,
    canonical_watchlist_key: str,
    days_back: int,
    active_pick_source: str,
    roster_signature: str,
    personalized: bool,
) -> str:
    if not personalized:
        return f"home:baseline:{canonical_watchlist_key}:{days_back}:{DEFAULT_PICK_SOURCE_ID}"
    return (
        f"home:{user_id}:{canonical_watchlist_key}:{days_back}:{active_pick_source}:"
        f"{roster_signature}"
    )


async def _resolve_pick_source_rows(
    user_id: str,
    active_pick_source: str,
    *,
    ria_sources: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    renaissance_service = get_renaissance_service()
    default_rows = await renaissance_service.get_all_investable()
    sources = [_default_pick_source()]

    if ria_sources is None:
        try:
            ria_sources = await RIAIAMService().list_investor_pick_sources(user_id)
        except Exception as exc:
            logger.debug("[Kai Market] investor pick sources unavailable for %s: %s", user_id, exc)
            ria_sources = []

    if ria_sources:
        sources.extend(ria_sources)

    if active_pick_source != DEFAULT_PICK_SOURCE_ID:
        try:
            ria_rows = await RIAIAMService().get_pick_rows_for_source(user_id, active_pick_source)
            if ria_rows:
                return ria_rows, sources, active_pick_source
        except Exception as exc:
            logger.debug(
                "[Kai Market] pick source %s unavailable for %s: %s",
                active_pick_source,
                user_id,
                exc,
            )

    return default_rows, sources, DEFAULT_PICK_SOURCE_ID


def _finnhub_api_key() -> str:
    return (os.getenv("FINNHUB_API_KEY") or "").strip()


def _pmp_api_key() -> str:
    return (os.getenv("PMP_API_KEY") or os.getenv("FMP_API_KEY") or "").strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        out = float(value)
        return out
    try:
        text = str(value).strip().replace(",", "")
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def _safe_int(value: Any) -> int | None:
    out = _safe_float(value)
    if out is None:
        return None
    try:
        return int(out)
    except Exception:
        return None


def _pick_row_value(row: Any, key: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        value = row.get(key, default)
        return default if value is None else value
    value = getattr(row, key, default)
    return default if value is None else value


def _count_screening_rows(screening_sections: list[dict[str, Any]] | None) -> int:
    if not isinstance(screening_sections, list):
        return 0
    total = 0
    for section in screening_sections:
        if not isinstance(section, dict):
            continue
        rows = section.get("rows")
        if isinstance(rows, list):
            total += len(rows)
    return total


def _is_recommendation_gap_text(detail: str | None) -> bool:
    text = str(detail or "").strip().lower()
    if not text:
        return True
    return text in {
        "no live recommendation feed available.",
        "recommendation unavailable.",
        "target consensus unavailable.",
    }


def _fallback_recommendation_from_quote(
    symbol: str, quote: dict[str, Any] | None
) -> dict[str, Any]:
    change_pct = _safe_float((quote or {}).get("change_percent"))
    if change_pct is None:
        return {
            "signal": "HOLD",
            "detail": "Using a neutral stance while analyst consensus refreshes.",
            "source": "Momentum Fallback",
            "degraded": True,
        }
    if change_pct >= 1.5:
        return {
            "signal": "BUY",
            "detail": f"{symbol} is showing positive momentum today while analyst consensus refreshes.",
            "source": "Momentum Fallback",
            "degraded": True,
        }
    if change_pct <= -1.5:
        return {
            "signal": "REDUCE",
            "detail": f"{symbol} is under pressure today while analyst consensus refreshes.",
            "source": "Momentum Fallback",
            "degraded": True,
        }
    return {
        "signal": "HOLD",
        "detail": f"{symbol} is trading near a neutral range while analyst consensus refreshes.",
        "source": "Momentum Fallback",
        "degraded": True,
    }


def _recommendation_bias_from_tier(tier: str | None) -> str:
    normalized = str(tier or "").strip().upper()
    if normalized == "ACE":
        return "STRONG_BUY"
    if normalized == "KING":
        return "BUY"
    if normalized == "QUEEN":
        return "HOLD_TO_BUY"
    if normalized == "JACK":
        return "HOLD"
    return "NEUTRAL"


def _spotlight_rank(row: dict[str, Any]) -> tuple[int, float]:
    score = 0
    if not bool(row.get("degraded")):
        score += 3
    recommendation = str(row.get("recommendation") or "").upper().strip()
    if recommendation == "BUY":
        score += 3
    elif recommendation == "REDUCE":
        score += 2
    elif recommendation == "HOLD":
        score += 1

    detail = str(row.get("recommendation_detail") or "").strip()
    if detail and not _is_recommendation_gap_text(detail):
        score += 2

    headline = str(row.get("headline") or "").strip()
    if headline:
        score += 2

    if _safe_float(row.get("price")) is not None:
        score += 1

    return score, abs(_safe_float(row.get("change_pct")) or 0.0)


def _spotlight_confidence(row: dict[str, Any]) -> float:
    confidence = 0.45
    if not bool(row.get("degraded")):
        confidence += 0.2

    recommendation = str(row.get("recommendation") or "").upper().strip()
    if recommendation == "BUY":
        confidence += 0.12
    elif recommendation == "REDUCE":
        confidence += 0.1
    elif recommendation == "HOLD":
        confidence += 0.06

    detail = str(row.get("recommendation_detail") or "").strip()
    if detail and not _is_recommendation_gap_text(detail):
        confidence += 0.08

    if str(row.get("headline") or "").strip():
        confidence += 0.06

    change_abs = abs(_safe_float(row.get("change_pct")) or 0.0)
    if change_abs >= 2.5:
        confidence += 0.08
    elif change_abs >= 1.0:
        confidence += 0.04

    return round(max(0.35, min(0.95, confidence)), 2)


def _spotlight_story(row: dict[str, Any]) -> str:
    recommendation = str(row.get("recommendation") or "HOLD").upper().strip()
    detail = str(row.get("recommendation_detail") or "").strip()
    if detail and not _is_recommendation_gap_text(detail):
        return detail

    symbol = str(row.get("symbol") or "This name").strip() or "This name"
    change_pct = _safe_float(row.get("change_pct"))
    momentum = (
        f" ({change_pct:+.2f}% today)"
        if isinstance(change_pct, float) and not (change_pct != change_pct)
        else ""
    )

    if recommendation == "BUY":
        return f"{symbol} shows positive momentum{momentum} while consensus updates refresh."
    if recommendation == "REDUCE":
        return f"{symbol} is showing downside pressure{momentum}; monitor risk closely."
    return f"{symbol} is range-bound{momentum} with a neutral near-term setup."


def _scheduled_market_status_fallback() -> dict[str, Any]:
    try:
        ny_now = datetime.now(ZoneInfo("America/New_York"))
        weekday = ny_now.weekday()
        minutes_now = ny_now.hour * 60 + ny_now.minute
        open_minutes = 9 * 60 + 30
        close_minutes = 16 * 60

        if weekday >= 5:
            value = "Closed (weekend)"
        elif minutes_now < open_minutes:
            value = "Closed (pre-market)"
        elif minutes_now >= close_minutes:
            value = "Closed (after-hours)"
        else:
            value = "Open (regular hours)"

        as_of = ny_now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return {
            "label": "Market Status",
            "value": value,
            "delta_pct": None,
            "as_of": as_of,
            "source": "US Session Schedule",
            "degraded": True,
        }
    except Exception:
        return {
            "label": "Market Status",
            "value": "Status delayed",
            "delta_pct": None,
            "as_of": None,
            "source": "Unavailable",
            "degraded": True,
        }


def _normalize_symbols(raw: str | None) -> list[str]:
    if not raw:
        return DEFAULT_SYMBOLS
    parts = [part.strip().upper() for part in raw.split(",")]
    out: list[str] = []
    for part in parts:
        if not part:
            continue
        if len(part) > 10:
            continue
        if part not in out:
            out.append(part)
        if len(out) >= WATCHLIST_MAX:
            break
    return out or DEFAULT_SYMBOLS


def _provider_status_from_exception(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code if exc.response is not None else 0
        if code in {401, 402, 403, 429}:
            return "partial"
    return "failed"


def _provider_cooldown_seconds(status_code: int | None) -> int:
    if status_code is None:
        return 0
    return PROVIDER_COOLDOWN_BY_STATUS.get(int(status_code), 0)


def _coerce_consent_token(raw: Any) -> str:
    if isinstance(raw, str):
        token = raw.strip()
        if token:
            return token
    token_attr = getattr(raw, "token", None)
    if isinstance(token_attr, str) and token_attr.strip():
        return token_attr.strip()
    if isinstance(raw, dict):
        nested = raw.get("token")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    return ""


def _summary_count(summary: dict[str, Any] | None) -> int:
    if not isinstance(summary, dict):
        return 0
    for key in ("attribute_count", "holdings_count", "item_count"):
        value = summary.get(key)
        parsed = _safe_int(value)
        if parsed is not None:
            return max(0, parsed)
    return 0


def _cache_tier_rank(value: str) -> int:
    if value == "live":
        return 3
    if value == "postgres":
        return 2
    return 1


def _merge_cache_tier(current: str, candidate: str) -> str:
    if _cache_tier_rank(candidate) > _cache_tier_rank(current):
        return candidate
    return current


async def _get_or_refresh_public_module(
    *,
    key: str,
    fresh_ttl_seconds: int,
    stale_ttl_seconds: int,
    fetcher: Any,
    warm_source: str = "request",
    serve_stale_while_revalidate: bool = True,
) -> tuple[Any, bool, int, str, bool]:
    """
    Read order:
    1) L1 memory cache (MarketInsightsCache)
    2) L2 Postgres cache (kai_market_cache_entries)
    3) Live fetch (external providers) + write-through to L1 + L2
    """
    now_ts = time()

    def has_recoverable_degradation(payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        provider_status = payload.get("provider_status")
        applies_to_key = (
            key.startswith("quotes:")
            or key.startswith("home:")
            or key.startswith("home:baseline:")
            or key.startswith("home:personalized:")
        )
        if not applies_to_key:
            return False
        if isinstance(provider_status, dict) and any(
            str(value or "partial") != "ok" for value in provider_status.values()
        ):
            return True
        if key.startswith("home:"):
            for row_key in ("pick_rows", "watchlist", "spotlights"):
                rows = payload.get(row_key)
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    if str(row.get("filtered_out_reason") or "").strip():
                        continue
                    if str(row.get("quote_status") or "").strip().lower() == "unsupported":
                        continue
                    if row.get("degraded") and _safe_float(row.get("price")) is None:
                        return True
        return False

    existing_l1 = market_insights_cache.peek(key)
    if (
        existing_l1
        and (now_ts - existing_l1.fetched_at) <= fresh_ttl_seconds
        and not has_recoverable_degradation(existing_l1.value)
    ):
        return (
            existing_l1.value,
            False,
            max(0, int(now_ts - existing_l1.fetched_at)),
            "memory",
            True,
        )

    store = None
    l2_entry = None
    try:
        store = get_market_cache_store_service()
        l2_entry = await store.get_entry(key)
    except Exception as exc:
        # L2 is optional. Never fail the request path when Postgres cache is unavailable.
        logger.warning("[Kai Market] L2 cache read skipped for %s: %s", key, exc)
        store = None
        l2_entry = None
    if l2_entry and l2_entry.is_fresh(now_ts) and not has_recoverable_degradation(l2_entry.payload):
        market_insights_cache.seed_entry(key, l2_entry.payload, l2_entry.updated_at_ts)
        return (l2_entry.payload, False, l2_entry.age_seconds(now_ts), "postgres", True)

    # Seed stale L2 into L1 so L1 stale-on-error can serve fallback.
    if l2_entry and l2_entry.is_stale_servable(now_ts):
        market_insights_cache.seed_entry(key, l2_entry.payload, l2_entry.updated_at_ts)

    async def wrapped_fetcher() -> Any:
        value = await fetcher()
        provider_status = {}
        if isinstance(value, dict) and isinstance(value.get("provider_status"), dict):
            provider_status = value.get("provider_status") or {}
        if store is not None:
            try:
                await store.set_entry(
                    cache_key=key,
                    payload=value,
                    fresh_ttl_seconds=fresh_ttl_seconds,
                    stale_ttl_seconds=stale_ttl_seconds,
                    provider_status=provider_status,
                )
            except Exception as exc:
                logger.warning("[Kai Market] L2 cache write skipped for %s: %s", key, exc)
        return value

    result = await market_insights_cache.get_or_refresh(
        key,
        fresh_ttl_seconds=fresh_ttl_seconds,
        stale_ttl_seconds=stale_ttl_seconds,
        fetcher=wrapped_fetcher,
        serve_stale_while_revalidate=serve_stale_while_revalidate,
    )
    tier = "live"
    cache_hit = False
    if result.stale:
        if l2_entry and l2_entry.is_stale_servable(now_ts):
            tier = "postgres"
            cache_hit = True
        else:
            tier = "memory"
            cache_hit = True
    logger.debug(
        "[Kai Market] module=%s warm_source=%s tier=%s hit=%s stale=%s age=%ss",
        key,
        warm_source,
        tier,
        cache_hit,
        result.stale,
        result.age_seconds,
    )
    return (result.value, result.stale, result.age_seconds, tier, cache_hit)


def _recommendation_from_counts(payload: dict[str, Any]) -> tuple[str, str]:
    buy = int(payload.get("buy") or 0) + int(payload.get("strongBuy") or 0)
    sell = int(payload.get("sell") or 0) + int(payload.get("strongSell") or 0)
    hold = int(payload.get("hold") or 0)
    if buy > max(sell, hold):
        return "BUY", "Analyst momentum currently skews bullish."
    if sell > max(buy, hold):
        return "REDUCE", "Analyst revisions currently lean defensive."
    return "HOLD", "Analyst distribution is mixed to neutral."


async def _fetch_market_status() -> dict[str, Any]:
    api_key = _finnhub_api_key()
    if not api_key:
        return _scheduled_market_status_fallback()

    url = "https://finnhub.io/api/v1/stock/market-status"
    timeout = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        res = await client.get(url, params={"exchange": "US", "token": api_key})
        res.raise_for_status()
        payload = res.json() or {}
        is_open = bool(payload.get("isOpen"))
        session = str(payload.get("session") or "").strip() or "unknown"
        ts = payload.get("t")
        as_of = None
        if isinstance(ts, (int, float)) and ts > 0:
            as_of = (
                datetime.fromtimestamp(float(ts), tz=timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        session_lc = session.lower()
        if session_lc in {"regular", "regular hours"}:
            session_label = "regular hours"
        elif session_lc in {"premarket", "pre-market"}:
            session_label = "pre-market"
        elif session_lc in {"postmarket", "post-market"}:
            session_label = "after-hours"
        else:
            session_label = "regular hours" if is_open else "off-hours"
        value = f"{'Open' if is_open else 'Closed'} ({session_label})"
        return {
            "label": "Market Status",
            "value": value,
            "delta_pct": None,
            "as_of": as_of,
            "source": "Finnhub",
            "degraded": False,
        }


async def _fetch_vix_signal() -> dict[str, Any]:
    pmp_key = _pmp_api_key()
    if market_insights_cache.is_provider_in_cooldown(FMP_GLOBAL_COOLDOWN_KEY):
        pmp_key = ""
    if pmp_key:
        timeout = httpx.Timeout(connect=3.0, read=6.0, write=6.0, pool=3.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.get(
                "https://financialmodelingprep.com/stable/quote",
                params={"symbol": "^VIX", "apikey": pmp_key},
            )
            if not res.is_success:
                cooldown_seconds = _provider_cooldown_seconds(res.status_code)
                if cooldown_seconds > 0:
                    market_insights_cache.mark_provider_cooldown(
                        "fmp:quote:^VIX",
                        cooldown_seconds,
                    )
                    if res.status_code in {401, 402, 403, 429}:
                        market_insights_cache.mark_provider_cooldown(
                            FMP_GLOBAL_COOLDOWN_KEY,
                            cooldown_seconds,
                        )
            if res.is_success:
                payload = res.json() or []
                if isinstance(payload, list) and payload:
                    row = payload[0] or {}
                    price = _safe_float(row.get("price"))
                    if price is not None:
                        market_insights_cache.append_series_point(VIX_SERIES_KEY, price)
                    return {
                        "label": "Volatility",
                        "value": price,
                        "delta_pct": _safe_float(row.get("changePercentage")),
                        "as_of": None,
                        "source": "PMP/FMP",
                        "degraded": False,
                    }

    cached_vix_points = market_insights_cache.get_series_points(
        VIX_SERIES_KEY,
        max_age_seconds=VIX_SERIES_MAX_AGE_SECONDS,
    )
    if cached_vix_points:
        _, last_price = cached_vix_points[-1]
        return {
            "label": "Volatility",
            "value": float(last_price),
            "delta_pct": None,
            "as_of": None,
            "source": "Cache (VIX)",
            "degraded": True,
        }

    return {
        "label": "Volatility",
        "value": None,
        "delta_pct": None,
        "as_of": None,
        "source": "Unavailable",
        "degraded": True,
    }


async def _fetch_macro_bundle() -> dict[str, Any]:
    statuses: dict[str, str] = {}

    async def safe_vix() -> tuple[dict[str, Any], str]:
        try:
            vix = await _fetch_vix_signal()
            return vix, "partial" if vix.get("degraded") else "ok"
        except Exception as exc:
            logger.warning("[Kai Market] volatility failed: %s", exc)
            fallback = {
                "label": "Volatility",
                "value": None,
                "delta_pct": None,
                "as_of": None,
                "source": "Unavailable",
                "degraded": True,
            }
            return fallback, _provider_status_from_exception(exc)

    async def safe_market_status() -> tuple[dict[str, Any], str]:
        try:
            market_status = await _fetch_market_status()
            return market_status, "partial" if market_status.get("degraded") else "ok"
        except Exception as exc:
            logger.warning("[Kai Market] market status failed: %s", exc)
            return _scheduled_market_status_fallback(), _provider_status_from_exception(exc)

    (vix, vix_status), (market_status, ms_status) = await asyncio.gather(
        safe_vix(), safe_market_status()
    )
    statuses["volatility"] = vix_status
    statuses["market_status"] = ms_status

    return {
        "vix": vix,
        "market_status": market_status,
        "provider_status": statuses,
    }


async def _fetch_recommendation(symbol: str, quote_price: float | None) -> dict[str, Any]:
    finnhub_key = _finnhub_api_key()
    if finnhub_key:
        finnhub_cooldown_key = f"finnhub:recommendation:{symbol.upper()}"
        if market_insights_cache.is_provider_in_cooldown(finnhub_cooldown_key):
            finnhub_key = ""
    if finnhub_key:
        try:
            timeout = httpx.Timeout(connect=3.0, read=6.0, write=6.0, pool=3.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.get(
                    "https://finnhub.io/api/v1/stock/recommendation",
                    params={"symbol": symbol, "token": finnhub_key},
                )
                if not res.is_success:
                    cooldown_seconds = _provider_cooldown_seconds(res.status_code)
                    if cooldown_seconds > 0:
                        market_insights_cache.mark_provider_cooldown(
                            f"finnhub:recommendation:{symbol.upper()}",
                            cooldown_seconds,
                        )
                if res.is_success:
                    rows = res.json() or []
                    if isinstance(rows, list) and rows:
                        latest = rows[0] or {}
                        signal, detail = _recommendation_from_counts(latest)
                        return {
                            "signal": signal,
                            "detail": detail,
                            "source": "Finnhub",
                            "degraded": False,
                        }
        except Exception as exc:
            logger.warning("[Kai Market] recommendation(Finnhub) failed for %s: %r", symbol, exc)
            if isinstance(exc, httpx.HTTPStatusError):
                cooldown_seconds = _provider_cooldown_seconds(
                    exc.response.status_code if exc.response is not None else None
                )
                if cooldown_seconds > 0:
                    market_insights_cache.mark_provider_cooldown(
                        f"finnhub:recommendation:{symbol.upper()}",
                        cooldown_seconds,
                    )

    pmp_key = _pmp_api_key()
    if market_insights_cache.is_provider_in_cooldown(FMP_GLOBAL_COOLDOWN_KEY):
        pmp_key = ""
    if pmp_key and quote_price and quote_price > 0:
        pmp_cooldown_key = f"fmp:price-target-consensus:{symbol.upper()}"
        if market_insights_cache.is_provider_in_cooldown(pmp_cooldown_key):
            pmp_key = ""
    if pmp_key and quote_price and quote_price > 0:
        try:
            timeout = httpx.Timeout(connect=3.0, read=6.0, write=6.0, pool=3.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.get(
                    "https://financialmodelingprep.com/stable/price-target-consensus",
                    params={"symbol": symbol, "apikey": pmp_key},
                )
                if not res.is_success:
                    cooldown_seconds = _provider_cooldown_seconds(res.status_code)
                    if cooldown_seconds > 0:
                        market_insights_cache.mark_provider_cooldown(
                            pmp_cooldown_key,
                            cooldown_seconds,
                        )
                        if res.status_code in {401, 402, 403, 429}:
                            market_insights_cache.mark_provider_cooldown(
                                FMP_GLOBAL_COOLDOWN_KEY,
                                cooldown_seconds,
                            )
                if res.is_success:
                    rows = res.json() or []
                    if isinstance(rows, list) and rows:
                        target = _safe_float((rows[0] or {}).get("targetConsensus"))
                        if target is None:
                            return {
                                "signal": "NEUTRAL",
                                "detail": "Target consensus unavailable.",
                                "source": "PMP/FMP",
                                "degraded": True,
                            }
                        if target >= quote_price * 1.08:
                            return {
                                "signal": "BUY",
                                "detail": "Target consensus is above current price range.",
                                "source": "PMP/FMP",
                                "degraded": False,
                            }
                        if target <= quote_price * 0.92:
                            return {
                                "signal": "REDUCE",
                                "detail": "Target consensus is below current price range.",
                                "source": "PMP/FMP",
                                "degraded": False,
                            }
                        return {
                            "signal": "HOLD",
                            "detail": "Target consensus is near the current price range.",
                            "source": "PMP/FMP",
                            "degraded": False,
                        }
        except Exception as exc:
            logger.warning("[Kai Market] recommendation(PMP/FMP) failed for %s: %r", symbol, exc)
            if isinstance(exc, httpx.HTTPStatusError):
                cooldown_seconds = _provider_cooldown_seconds(
                    exc.response.status_code if exc.response is not None else None
                )
                if cooldown_seconds > 0:
                    market_insights_cache.mark_provider_cooldown(
                        pmp_cooldown_key,
                        cooldown_seconds,
                    )
                    if (exc.response.status_code if exc.response is not None else None) in {
                        401,
                        402,
                        403,
                        429,
                    }:
                        market_insights_cache.mark_provider_cooldown(
                            FMP_GLOBAL_COOLDOWN_KEY,
                            cooldown_seconds,
                        )

    return {
        "signal": "HOLD",
        "detail": "Using a neutral stance while analyst consensus refreshes.",
        "source": "Fallback",
        "degraded": True,
    }


async def _fetch_finnhub_candles(symbol: str) -> list[dict[str, float]]:
    api_key = _finnhub_api_key()
    if not api_key:
        return []
    cooldown_key = f"finnhub:candles:{symbol.upper()}"
    if market_insights_cache.is_provider_in_cooldown(cooldown_key):
        return []

    now_ts = int(time())
    since = now_ts - (5 * 24 * 60 * 60)
    timeout = httpx.Timeout(connect=3.0, read=6.0, write=6.0, pool=3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            res = await client.get(
                "https://finnhub.io/api/v1/stock/candle",
                params={
                    "symbol": symbol,
                    "resolution": "60",
                    "from": since,
                    "to": now_ts,
                    "token": api_key,
                },
            )
            res.raise_for_status()
            payload = res.json() or {}
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            cooldown_seconds = _provider_cooldown_seconds(status_code)
            if cooldown_seconds > 0:
                market_insights_cache.mark_provider_cooldown(cooldown_key, cooldown_seconds)
            if status_code in {401, 403, 429}:
                # Expected quota/plan constraints for candle data; fall back to cached/derived sparkline.
                logger.debug(
                    "[Kai Market] sparkline candles unavailable for %s (status=%s)",
                    symbol,
                    status_code,
                )
                return []
            raise

    status_code = str(payload.get("s") or "")
    if status_code.lower() != "ok":
        return []

    closes = payload.get("c") or []
    times = payload.get("t") or []
    out: list[dict[str, float]] = []
    for ts, close in zip(times, closes, strict=False):
        price = _safe_float(close)
        if price is None:
            continue
        out.append({"t": float(ts), "p": float(price)})

    if len(out) > 60:
        out = out[-60:]
    return out


async def _fetch_pmp_json(paths: list[str], params: dict[str, Any]) -> list[dict[str, Any]]:
    key = _pmp_api_key()
    if market_insights_cache.is_provider_in_cooldown(FMP_GLOBAL_COOLDOWN_KEY):
        key = ""
    if not key:
        return []

    timeout = httpx.Timeout(connect=3.0, read=6.0, write=6.0, pool=3.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for path in paths:
            cooldown_key = f"fmp:{path}"
            if market_insights_cache.is_provider_in_cooldown(cooldown_key):
                continue
            url = f"https://financialmodelingprep.com{path}"
            req_params = {**params, "apikey": key}
            try:
                res = await client.get(url, params=req_params)
                if not res.is_success:
                    cooldown_seconds = _provider_cooldown_seconds(res.status_code)
                    if cooldown_seconds > 0:
                        market_insights_cache.mark_provider_cooldown(cooldown_key, cooldown_seconds)
                        if res.status_code in {401, 402, 403, 429}:
                            market_insights_cache.mark_provider_cooldown(
                                FMP_GLOBAL_COOLDOWN_KEY,
                                cooldown_seconds,
                            )
                            return []
                    continue
                payload = res.json() or []
                if isinstance(payload, list) and payload:
                    rows = [row for row in payload if isinstance(row, dict)]
                    if rows:
                        return rows
            except Exception as exc:
                logger.warning("[Kai Market] FMP endpoint failed: %s (%s)", path, exc)
                if isinstance(exc, httpx.HTTPStatusError):
                    cooldown_seconds = _provider_cooldown_seconds(
                        exc.response.status_code if exc.response is not None else None
                    )
                    if cooldown_seconds > 0:
                        market_insights_cache.mark_provider_cooldown(cooldown_key, cooldown_seconds)
                        if (exc.response.status_code if exc.response is not None else None) in {
                            401,
                            402,
                            403,
                            429,
                        }:
                            market_insights_cache.mark_provider_cooldown(
                                FMP_GLOBAL_COOLDOWN_KEY,
                                cooldown_seconds,
                            )
                            return []
                continue
    return []


def _normalize_mover_row(row: dict[str, Any], source: str) -> dict[str, Any] | None:
    symbol = str(row.get("symbol") or row.get("ticker") or "").strip().upper()
    if not symbol:
        return None

    return {
        "symbol": symbol,
        "company_name": str(row.get("name") or row.get("companyName") or symbol),
        "price": _safe_float(row.get("price")),
        "change_pct": _safe_float(
            row.get("changesPercentage")
            or row.get("changePercentage")
            or row.get("change_percent")
            or row.get("changes")
        ),
        "volume": _safe_int(row.get("volume")),
        "source_tags": [source],
        "degraded": False,
        "as_of": None,
    }


async def _fetch_movers_from_fmp() -> tuple[dict[str, Any], dict[str, str]]:
    status_map: dict[str, str] = {}

    gainers_task = _fetch_pmp_json(
        ["/stable/biggest-gainers", "/stable/market-gainers", "/stable/market/gainers"], {}
    )
    losers_task = _fetch_pmp_json(
        ["/stable/biggest-losers", "/stable/market-losers", "/stable/market/losers"], {}
    )
    active_task = _fetch_pmp_json(
        ["/stable/most-actives", "/stable/market-most-actives", "/stable/market/actives"], {}
    )
    gainers_rows, losers_rows, active_rows = await asyncio.gather(
        gainers_task, losers_task, active_task
    )

    gainers = [row for row in (_normalize_mover_row(r, "PMP/FMP") for r in gainers_rows) if row]
    losers = [row for row in (_normalize_mover_row(r, "PMP/FMP") for r in losers_rows) if row]
    active = [row for row in (_normalize_mover_row(r, "PMP/FMP") for r in active_rows) if row]

    status_map["movers:gainers"] = "ok" if gainers else "partial"
    status_map["movers:losers"] = "ok" if losers else "partial"
    status_map["movers:active"] = "ok" if active else "partial"

    return {
        "gainers": gainers[:8],
        "losers": losers[:8],
        "active": active[:8],
        "as_of": _now_iso(),
        "source_tags": ["PMP/FMP"] if (gainers or losers or active) else ["Fallback"],
        "degraded": not (gainers and losers and active),
    }, status_map


async def _fetch_sector_rotation_from_fmp() -> tuple[list[dict[str, Any]], str]:
    rows = await _fetch_pmp_json(
        [
            "/stable/sector-performance-snapshot",
        ],
        {},
    )

    out: list[dict[str, Any]] = []
    for row in rows:
        sector = str(row.get("sector") or row.get("name") or "").strip()
        if not sector:
            continue
        out.append(
            {
                "sector": sector,
                "change_pct": _safe_float(
                    row.get("changesPercentage") or row.get("changePercentage") or row.get("change")
                ),
                "as_of": None,
                "source_tags": ["PMP/FMP"],
                "degraded": False,
            }
        )

    return out[:10], ("ok" if out else "partial")


async def _fetch_sector_rotation_from_etf_quotes(
    user_id: str, consent_token: str | None
) -> tuple[list[dict[str, Any]], str]:
    rows: list[dict[str, Any]] = []
    failures = 0
    semaphore = asyncio.Semaphore(4)

    async def fetch_sector_quote(
        sector_name: str, etf_symbol: str
    ) -> tuple[str, dict[str, Any] | None]:
        async with semaphore:
            try:
                quote = await fetch_market_data(
                    etf_symbol,
                    user_id,
                    consent_token,
                    allow_slow_fallbacks=False,
                )
                return sector_name, quote or {}
            except Exception as exc:
                logger.debug(
                    "[Kai Market] sector ETF quote unavailable for %s (%s): %r",
                    sector_name,
                    etf_symbol,
                    exc,
                )
                return sector_name, None

    results = await asyncio.gather(
        *(fetch_sector_quote(sector, etf) for sector, etf in SECTOR_ETF_MAP.items())
    )
    for sector_name, quote in results:
        if not quote:
            failures += 1
            continue
        change_pct = _safe_float((quote or {}).get("change_percent"))
        if change_pct is None:
            failures += 1
            continue
        rows.append(
            {
                "sector": sector_name,
                "change_pct": change_pct,
                "as_of": (quote or {}).get("fetched_at")
                if isinstance((quote or {}).get("fetched_at"), str)
                else None,
                "source_tags": [str((quote or {}).get("source") or "Market ETF")],
                "degraded": False,
            }
        )

    rows.sort(key=lambda item: abs(float(item.get("change_pct") or 0)), reverse=True)
    if not rows:
        return [], "partial"

    # Mark partial when a material portion of sector feeds are missing.
    status = "ok" if failures <= max(1, len(SECTOR_ETF_MAP) // 3) else "partial"
    return rows[:10], status


async def _fetch_sector_rotation_snapshot(
    user_id: str, consent_token: str | None
) -> tuple[list[dict[str, Any]], str]:
    rows, status = await _fetch_sector_rotation_from_etf_quotes(user_id, consent_token)
    if rows:
        return rows, status
    return await _fetch_sector_rotation_from_fmp()


def _fallback_movers_from_watchlist(watchlist: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [row for row in watchlist if row.get("symbol")]

    by_change = [row for row in rows if isinstance(row.get("change_pct"), (int, float))]
    by_volume = [row for row in rows if isinstance(row.get("volume"), int)]

    gainers = sorted(by_change, key=lambda item: float(item.get("change_pct") or 0), reverse=True)
    losers = sorted(by_change, key=lambda item: float(item.get("change_pct") or 0))
    active = sorted(by_volume, key=lambda item: int(item.get("volume") or 0), reverse=True)

    return {
        "gainers": [
            {
                "symbol": item.get("symbol"),
                "company_name": item.get("company_name") or item.get("symbol"),
                "price": item.get("price"),
                "change_pct": item.get("change_pct"),
                "volume": item.get("volume"),
                "source_tags": ["Watchlist Fallback"],
                "degraded": True,
                "as_of": item.get("as_of"),
            }
            for item in gainers[:6]
        ],
        "losers": [
            {
                "symbol": item.get("symbol"),
                "company_name": item.get("company_name") or item.get("symbol"),
                "price": item.get("price"),
                "change_pct": item.get("change_pct"),
                "volume": item.get("volume"),
                "source_tags": ["Watchlist Fallback"],
                "degraded": True,
                "as_of": item.get("as_of"),
            }
            for item in losers[:6]
        ],
        "active": [
            {
                "symbol": item.get("symbol"),
                "company_name": item.get("company_name") or item.get("symbol"),
                "price": item.get("price"),
                "change_pct": item.get("change_pct"),
                "volume": item.get("volume"),
                "source_tags": ["Watchlist Fallback"],
                "degraded": True,
                "as_of": item.get("as_of"),
            }
            for item in active[:6]
        ],
        "as_of": _now_iso(),
        "source_tags": ["Watchlist Fallback"],
        "degraded": True,
    }


def _fallback_sector_rotation_from_watchlist(
    watchlist: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    buckets: dict[str, list[float]] = {}
    for row in watchlist:
        sector = str(row.get("sector") or "").strip()
        change = _safe_float(row.get("change_pct"))
        if not sector or change is None:
            continue
        buckets.setdefault(sector, []).append(change)

    out: list[dict[str, Any]] = []
    for sector, values in buckets.items():
        if not values:
            continue
        avg = sum(values) / len(values)
        out.append(
            {
                "sector": sector,
                "change_pct": round(avg, 3),
                "as_of": _now_iso(),
                "source_tags": ["Watchlist Fallback"],
                "degraded": True,
            }
        )

    out.sort(key=lambda item: abs(float(item.get("change_pct") or 0)), reverse=True)
    return out[:8]


def _build_market_overview(
    spy_quote: dict[str, Any] | None,
    qqq_quote: dict[str, Any] | None,
    vix_payload: dict[str, Any],
    status_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    def metric_from_quote(
        label: str, symbol: str, quote: dict[str, Any] | None, degraded: bool
    ) -> dict[str, Any]:
        quote = quote or {}
        return {
            "id": symbol.lower(),
            "label": label,
            "symbol": symbol,
            "value": _safe_float(quote.get("price")),
            "delta_pct": _safe_float(quote.get("change_percent")),
            "as_of": quote.get("fetched_at") if isinstance(quote.get("fetched_at"), str) else None,
            "source": str(quote.get("source") or "Unavailable"),
            "degraded": degraded,
        }

    out = [
        metric_from_quote("S&P 500", "SPY", spy_quote, degraded=not bool(spy_quote)),
        metric_from_quote("NASDAQ 100", "QQQ", qqq_quote, degraded=not bool(qqq_quote)),
        {
            "id": "volatility",
            "label": vix_payload["label"],
            "value": vix_payload["value"],
            "delta_pct": vix_payload["delta_pct"],
            "as_of": vix_payload["as_of"],
            "source": vix_payload["source"],
            "degraded": bool(vix_payload.get("degraded")),
        },
        {
            "id": "market_status",
            "label": status_payload["label"],
            "value": status_payload["value"],
            "delta_pct": status_payload["delta_pct"],
            "as_of": status_payload["as_of"],
            "source": status_payload["source"],
            "degraded": bool(status_payload.get("degraded")),
        },
    ]
    return out


def _build_signals(
    *,
    watchlist: list[dict[str, Any]],
    movers: dict[str, Any],
    vix_payload: dict[str, Any],
    source_tags: list[str],
) -> list[dict[str, Any]]:
    signals: list[dict[str, Any]] = []

    gainers = movers.get("gainers") or []
    losers = movers.get("losers") or []
    if gainers or losers:
        gainers_count = len(gainers)
        losers_count = len(losers)
        if gainers_count > losers_count:
            summary = "Breadth currently favors gainers over losers."
            title = "Positive Breadth"
        elif losers_count > gainers_count:
            summary = "Losses are dominating gainers across tracked names."
            title = "Defensive Breadth"
        else:
            summary = "Breadth is mixed across tracked names."
            title = "Mixed Breadth"
        signals.append(
            {
                "id": "breadth",
                "title": title,
                "summary": summary,
                "confidence": 0.68,
                "source_tags": source_tags,
                "degraded": bool(movers.get("degraded")),
            }
        )

    vix_value = _safe_float(vix_payload.get("value"))
    if vix_value is not None:
        if vix_value >= 25:
            summary = "Volatility regime is elevated; sizing discipline is critical."
            title = "High Volatility"
        elif vix_value <= 15:
            summary = "Volatility regime is relatively calm versus stress thresholds."
            title = "Calmer Volatility"
        else:
            summary = "Volatility is in a mid-range regime."
            title = "Moderate Volatility"
        signals.append(
            {
                "id": "volatility-regime",
                "title": title,
                "summary": summary,
                "confidence": 0.73,
                "source_tags": [str(vix_payload.get("source") or "Unknown")],
                "degraded": bool(vix_payload.get("degraded")),
            }
        )

    recommendation_counts: dict[str, int] = {"BUY": 0, "HOLD": 0, "REDUCE": 0, "NEUTRAL": 0}
    for row in watchlist:
        rec = str(row.get("recommendation") or "NEUTRAL").upper().strip()
        if rec in recommendation_counts:
            recommendation_counts[rec] += 1

    if watchlist:
        dominant = max(recommendation_counts.items(), key=lambda item: item[1])
        if dominant[1] > 0:
            supporting_rows = [
                row
                for row in watchlist
                if str(row.get("recommendation") or "NEUTRAL").upper().strip() == dominant[0]
            ]
            supporting_rows.sort(
                key=lambda row: (
                    0 if not bool(row.get("degraded")) else 1,
                    -abs(_safe_float(row.get("change_pct")) or 0),
                    str(row.get("symbol") or ""),
                )
            )
            supporting_items = [
                {
                    "symbol": str(row.get("symbol") or "").strip().upper(),
                    "company_name": str(
                        row.get("company_name") or row.get("symbol") or "Unknown"
                    ).strip(),
                }
                for row in supporting_rows[:4]
                if str(row.get("symbol") or "").strip()
            ]
            signals.append(
                {
                    "id": "recommendation-consensus",
                    "title": f"{dominant[0]} Tilt",
                    "summary": (
                        f"Watchlist consensus is {dominant[0].lower()} "
                        f"({dominant[1]}/{len(watchlist)} names)."
                    ),
                    "confidence": 0.64,
                    "source_tags": ["Finnhub", "PMP/FMP", "Fallback"],
                    "supporting_items": supporting_items,
                    "degraded": any(bool(row.get("degraded")) for row in watchlist),
                }
            )

    return signals[:4]


async def _build_sparkline_points(
    spy_quote: dict[str, Any] | None,
) -> tuple[list[dict[str, float]], bool, list[str]]:
    try:
        candles = await _fetch_finnhub_candles("SPY")
        if candles:
            for point in candles[-12:]:
                market_insights_cache.append_series_point(
                    "sparkline:SPY", point["p"], timestamp=point["t"]
                )
            return candles, False, ["Finnhub"]
    except Exception as exc:
        logger.warning("[Kai Market] sparkline candles failed: %s", exc)

    history = market_insights_cache.get_series_points(
        "sparkline:SPY", max_age_seconds=5 * 24 * 60 * 60
    )
    if history:
        points = [{"t": ts, "p": price} for ts, price in history[-60:]]
        return points, True, ["Cache"]

    price = _safe_float((spy_quote or {}).get("price"))
    delta = _safe_float((spy_quote or {}).get("change_percent"))
    if price is not None and delta is not None:
        prev = price / (1 + (delta / 100.0)) if delta != -100 else price
        ts_now = time()
        points = [{"t": ts_now - 86400, "p": prev}, {"t": ts_now, "p": price}]
        return points, True, ["Derived from Quote"]

    return [], True, ["Unavailable"]


async def _get_financial_summary(user_id: str) -> dict[str, Any]:
    try:
        pkm_service = get_pkm_service()
        index = await pkm_service.get_index_v2(user_id)
        if index is None:
            return {}
        return dict((index.domain_summaries or {}).get("financial") or {})
    except Exception as exc:
        logger.warning("[Kai Market] financial summary unavailable for %s: %s", user_id, exc)
        return {}


def _market_refresh_enabled() -> bool:
    return str(os.getenv("KAI_MARKET_BACKGROUND_REFRESH", "true")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _market_refresh_interval_seconds() -> int:
    raw = str(os.getenv("KAI_MARKET_REFRESH_INTERVAL_SECONDS", "600")).strip()
    try:
        value = int(raw)
        return max(120, value)
    except ValueError:
        return 600


def _market_startup_warm_timeout_seconds() -> float:
    raw = str(os.getenv("KAI_MARKET_STARTUP_WARM_TIMEOUT_SECONDS", "20")).strip()
    try:
        value = float(raw)
    except ValueError:
        return 20.0
    return min(120.0, max(1.0, value))


async def _refresh_public_market_modules_once() -> None:
    refresh_summary: list[str] = []

    try:
        _, stale, age_seconds, tier, cache_hit = await _get_or_refresh_public_module(
            key="macro:us",
            fresh_ttl_seconds=QUOTES_FRESH_TTL_SECONDS,
            stale_ttl_seconds=QUOTES_STALE_TTL_SECONDS,
            fetcher=_fetch_macro_bundle,
            warm_source="startup",
            serve_stale_while_revalidate=False,
        )
        refresh_summary.append(
            f"macro:tier={tier},hit={str(cache_hit).lower()},stale={str(stale).lower()},age={age_seconds}s"
        )
    except Exception as exc:
        logger.warning("[Kai Market] background macro refresh failed: %s", exc)

    try:
        _, stale, age_seconds, tier, cache_hit = await _get_or_refresh_public_module(
            key="movers:us",
            fresh_ttl_seconds=MOVERS_FRESH_TTL_SECONDS,
            stale_ttl_seconds=MOVERS_STALE_TTL_SECONDS,
            fetcher=_fetch_movers_from_fmp,
            warm_source="startup",
            serve_stale_while_revalidate=False,
        )
        refresh_summary.append(
            f"movers:tier={tier},hit={str(cache_hit).lower()},stale={str(stale).lower()},age={age_seconds}s"
        )
    except Exception as exc:
        logger.warning("[Kai Market] background movers refresh failed: %s", exc)

    try:
        _, stale, age_seconds, tier, cache_hit = await _get_or_refresh_public_module(
            key="sectors:us",
            fresh_ttl_seconds=SECTORS_FRESH_TTL_SECONDS,
            stale_ttl_seconds=SECTORS_STALE_TTL_SECONDS,
            fetcher=lambda: _fetch_sector_rotation_from_fmp(),
            warm_source="startup",
            serve_stale_while_revalidate=False,
        )
        refresh_summary.append(
            f"sectors:tier={tier},hit={str(cache_hit).lower()},stale={str(stale).lower()},age={age_seconds}s"
        )
    except Exception as exc:
        logger.warning("[Kai Market] background sectors refresh failed: %s", exc)
    finally:
        try:
            await get_market_cache_store_service().delete_expired(max_rows=250)
        except Exception as exc:
            logger.debug("[Kai Market] L2 cleanup skipped: %s", exc)

    if refresh_summary:
        logger.debug("[Kai Market] warm refresh %s", " | ".join(refresh_summary))


async def _run_refresh_with_advisory_lock() -> None:
    try:
        acquired = await get_market_cache_store_service().try_with_advisory_lock(
            lock_key=_MARKET_REFRESH_LOCK_KEY,
            callback=_refresh_public_market_modules_once,
        )
        if not acquired:
            return
    except Exception as exc:
        logger.warning("[Kai Market] advisory lock unavailable; falling back: %s", exc)
        await _refresh_public_market_modules_once()


async def _warm_shared_baseline_market_home_once() -> None:
    payload = await _get_market_insights_payload(
        user_id="startup",
        requested_watchlist_symbols=list(DEFAULT_SYMBOLS),
        filtered_symbols=[],
        watchlist_symbols=list(DEFAULT_SYMBOLS),
        days_back=7,
        active_pick_source=DEFAULT_PICK_SOURCE_ID,
        consent_token=None,
        personalized=False,
        warm_source="startup",
    )
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    logger.debug(
        "[Kai Market] shared baseline warm tier=%s stale=%s age=%ss",
        meta.get("cache_tier") or "unknown",
        meta.get("stale"),
        meta.get("cache_age_seconds"),
    )


async def _market_refresh_loop() -> None:
    interval = _market_refresh_interval_seconds()
    logger.info("[Kai Market] background refresh loop started (interval=%ss)", interval)
    while True:
        await _run_refresh_with_advisory_lock()
        jitter_max = max(5.0, interval * 0.12)
        jitter_ms = int(jitter_max * 1000)
        cycle_jitter = (secrets.randbelow(jitter_ms + 1) / 1000.0) if jitter_ms > 0 else 0.0
        await asyncio.sleep(interval + cycle_jitter)


def start_market_insights_background_refresh() -> None:
    global _MARKET_REFRESH_TASK
    if not _market_refresh_enabled():
        logger.info("[Kai Market] background refresh disabled by env")
        return
    if _MARKET_REFRESH_TASK and not _MARKET_REFRESH_TASK.done():
        return
    _MARKET_REFRESH_TASK = asyncio.create_task(_market_refresh_loop())


async def warm_market_insights_startup_once() -> None:
    if not _market_refresh_enabled():
        logger.info("[Kai Market] startup warm disabled by env")
        return
    timeout_seconds = _market_startup_warm_timeout_seconds()
    try:
        await asyncio.wait_for(_run_refresh_with_advisory_lock(), timeout=timeout_seconds)
    except TimeoutError:
        logger.warning(
            "[Kai Market] startup public module warm timed out after %ss", timeout_seconds
        )
    except Exception as exc:
        logger.warning("[Kai Market] startup public module warm failed: %s", exc)

    try:
        await asyncio.wait_for(_warm_shared_baseline_market_home_once(), timeout=timeout_seconds)
    except TimeoutError:
        logger.warning(
            "[Kai Market] startup baseline home warm timed out after %ss", timeout_seconds
        )
    except Exception as exc:
        logger.warning("[Kai Market] startup baseline home warm failed: %s", exc)


async def _get_market_insights_payload(
    *,
    user_id: str,
    requested_watchlist_symbols: list[str],
    filtered_symbols: list[dict[str, Any]],
    watchlist_symbols: list[str],
    days_back: int,
    active_pick_source: str,
    consent_token: str | None,
    personalized: bool,
    warm_source: str = "request",
) -> dict[str, Any]:
    effective_pick_source = active_pick_source if personalized else DEFAULT_PICK_SOURCE_ID
    canonical_watchlist_key = ",".join(sorted(set(watchlist_symbols)))
    if personalized:
        try:
            ria_source_roster = await RIAIAMService().list_investor_pick_sources(user_id)
        except Exception as exc:
            logger.debug("[Kai Market] source roster unavailable for %s: %s", user_id, exc)
            ria_source_roster = []
    else:
        ria_source_roster = []
    roster_signature = _pick_source_roster_signature(ria_source_roster)
    home_key = _market_home_cache_key(
        user_id=user_id,
        canonical_watchlist_key=canonical_watchlist_key,
        days_back=days_back,
        active_pick_source=effective_pick_source,
        roster_signature=roster_signature,
        personalized=personalized,
    )

    async def build_payload() -> dict[str, Any]:
        provider_status: dict[str, str] = {}
        stale = False
        aggregated_cache_tier = "memory"
        aggregated_cache_hit = True

        (
            renaissance_rows_source,
            pick_sources,
            resolved_pick_source,
        ) = await _resolve_pick_source_rows(
            user_id,
            effective_pick_source,
            ria_sources=ria_source_roster if personalized else [],
        )
        symbol_master = get_symbol_master_service()
        visible_pick_rows_source: list[dict[str, Any]] = []
        hidden_pick_symbols: list[dict[str, Any]] = []
        for stock in renaissance_rows_source:
            input_symbol = str(_pick_row_value(stock, "ticker", "") or "").strip().upper()
            if not input_symbol:
                continue
            quote_symbol, alias_repaired = _repair_quote_symbol(input_symbol)
            classification = symbol_master.classify(quote_symbol)
            if not classification.tradable:
                hidden_pick_symbols.append(
                    {
                        "input_symbol": input_symbol,
                        "normalized_symbol": classification.symbol,
                        "reason": classification.reason,
                        "trust_tier": classification.trust_tier,
                        "filtered_out_reason": "unsupported_quote_symbol",
                    }
                )
                continue
            visible_pick_rows_source.append(
                {
                    "row": stock,
                    "input_symbol": input_symbol,
                    "quote_symbol": classification.symbol,
                    "alias_repaired": alias_repaired or classification.symbol != input_symbol,
                }
            )

        renaissance_symbols = [
            item["quote_symbol"]
            for item in visible_pick_rows_source
            if str(item.get("quote_symbol") or "").strip()
        ]

        core_symbols = ["SPY", "QQQ"]
        symbol_set = sorted({*watchlist_symbols, *core_symbols, *renaissance_symbols})
        quotes_key = f"quotes:{','.join(symbol_set)}"

        async def fetch_quotes_bundle() -> dict[str, Any]:
            quotes_by_symbol: dict[str, dict[str, Any]] = {}
            statuses: dict[str, str] = {}
            unresolved_symbols = list(symbol_set)

            try:
                batch_quotes = await fetch_market_data_batch(symbol_set, user_id, consent_token)
            except Exception as exc:
                logger.debug("[Kai Market] quote batch failed: %s", exc)
                batch_quotes = {}

            if batch_quotes:
                next_unresolved: list[str] = []
                for symbol in unresolved_symbols:
                    payload = batch_quotes.get(symbol) if isinstance(batch_quotes, dict) else None
                    price = _safe_float((payload or {}).get("price"))
                    if price is None:
                        next_unresolved.append(symbol)
                        continue
                    quotes_by_symbol[symbol] = payload or {}
                    statuses[f"quote:{symbol}"] = "ok"
                    market_insights_cache.append_series_point(f"quote:{symbol}", price)
                    if symbol == "SPY":
                        market_insights_cache.append_series_point("sparkline:SPY", price)
                unresolved_symbols = next_unresolved

            semaphore = asyncio.Semaphore(QUOTE_FANOUT_CONCURRENCY)

            async def fetch_symbol_quote(symbol: str) -> tuple[str, dict[str, Any], str]:
                async with semaphore:
                    last_exc: Exception | None = None
                    for allow_slow_fallbacks in (False, True):
                        try:
                            quote = await fetch_market_data(
                                symbol,
                                user_id,
                                consent_token,
                                allow_slow_fallbacks=allow_slow_fallbacks,
                            )
                            payload = quote or {}
                            price = _safe_float(payload.get("price"))
                            if price is None:
                                continue
                            market_insights_cache.append_series_point(f"quote:{symbol}", price)
                            if symbol == "SPY":
                                market_insights_cache.append_series_point("sparkline:SPY", price)
                            return symbol, payload, "ok"
                        except Exception as exc:
                            last_exc = exc
                            logger.debug(
                                "[Kai Market] quote failed for %s (allow_slow=%s): %s",
                                symbol,
                                allow_slow_fallbacks,
                                exc,
                            )
                    return symbol, {}, _provider_status_from_exception(last_exc or RuntimeError())

            results = await asyncio.gather(
                *(fetch_symbol_quote(symbol) for symbol in unresolved_symbols)
            )
            degraded_quotes: list[str] = []
            for symbol, payload, status_value in results:
                quotes_by_symbol[symbol] = payload
                statuses[f"quote:{symbol}"] = status_value
                if status_value != "ok":
                    degraded_quotes.append(f"{symbol}:{status_value}")
            if degraded_quotes:
                logger.warning(
                    "[Kai Market] quote bundle degraded for %s symbols: %s",
                    len(degraded_quotes),
                    ", ".join(degraded_quotes[:6]),
                )
            return {
                "quotes": quotes_by_symbol,
                "provider_status": statuses,
                "generated_at": _now_iso(),
            }

        # ⚡️ CONCURRENCY REFACTOR

        quotes_task = _get_or_refresh_public_module(
            key=quotes_key,
            fresh_ttl_seconds=QUOTES_FRESH_TTL_SECONDS,
            stale_ttl_seconds=QUOTES_STALE_TTL_SECONDS,
            fetcher=fetch_quotes_bundle,
            warm_source=warm_source,
        )

        macro_task = _get_or_refresh_public_module(
            key="macro:us",
            fresh_ttl_seconds=QUOTES_FRESH_TTL_SECONDS,
            stale_ttl_seconds=QUOTES_STALE_TTL_SECONDS,
            fetcher=_fetch_macro_bundle,
            warm_source=warm_source,
        )
        movers_task = _get_or_refresh_public_module(
            key="movers:us",
            fresh_ttl_seconds=MOVERS_FRESH_TTL_SECONDS,
            stale_ttl_seconds=MOVERS_STALE_TTL_SECONDS,
            fetcher=_fetch_movers_from_fmp,
            warm_source=warm_source,
        )
        sectors_task = _get_or_refresh_public_module(
            key="sectors:us",
            fresh_ttl_seconds=SECTORS_FRESH_TTL_SECONDS,
            stale_ttl_seconds=SECTORS_STALE_TTL_SECONDS,
            fetcher=lambda: _fetch_sector_rotation_snapshot(user_id, consent_token),
            warm_source=warm_source,
        )
        (
            (quotes_value, quotes_stale, _quotes_age, quotes_cache_tier, quotes_cache_hit),
            (macro_value, macro_stale, _macro_age, macro_cache_tier, macro_cache_hit),
            (movers_value, movers_stale, _movers_age, movers_cache_tier, movers_cache_hit),
            (sectors_value, sectors_stale, _sectors_age, sectors_cache_tier, sectors_cache_hit),
        ) = await asyncio.gather(quotes_task, macro_task, movers_task, sectors_task)
        quote_bundle = quotes_value if isinstance(quotes_value, dict) else {}
        quote_map = (
            quote_bundle.get("quotes") if isinstance(quote_bundle.get("quotes"), dict) else {}
        )
        provider_status.update(
            {str(k): str(v) for k, v in (quote_bundle.get("provider_status") or {}).items()}
        )
        stale = stale or quotes_stale
        aggregated_cache_tier = _merge_cache_tier(aggregated_cache_tier, quotes_cache_tier)
        aggregated_cache_hit = aggregated_cache_hit and quotes_cache_hit
        spy_quote = quote_map.get("SPY") if isinstance(quote_map, dict) else None
        qqq_quote = quote_map.get("QQQ") if isinstance(quote_map, dict) else None
        quoted_watchlist_symbols = [
            s
            for s in watchlist_symbols
            if _safe_float((quote_map.get(s) or {}).get("price")) is not None
        ]
        watchlist_symbols_for_cards = (
            quoted_watchlist_symbols if quoted_watchlist_symbols else watchlist_symbols
        )
        macro_bundle = macro_value if isinstance(macro_value, dict) else {}
        vix_payload = (
            macro_bundle.get("vix")
            if isinstance(macro_bundle.get("vix"), dict)
            else {
                "label": "Volatility",
                "value": None,
                "delta_pct": None,
                "as_of": None,
                "source": "Unavailable",
                "degraded": True,
            }
        )
        status_payload = (
            macro_bundle.get("market_status")
            if isinstance(macro_bundle.get("market_status"), dict)
            else {
                "label": "Market Status",
                "value": "Unknown",
                "delta_pct": None,
                "as_of": None,
                "source": "Unavailable",
                "degraded": True,
            }
        )
        provider_status.update(
            {str(k): str(v) for k, v in (macro_bundle.get("provider_status") or {}).items()}
        )
        stale = stale or macro_stale
        aggregated_cache_tier = _merge_cache_tier(aggregated_cache_tier, macro_cache_tier)
        aggregated_cache_hit = aggregated_cache_hit and macro_cache_hit
        watchlist_rows: list[dict[str, Any]] = []
        renaissance_rows: list[dict[str, Any]] = []
        rec_semaphore = asyncio.Semaphore(RECOMMENDATION_FANOUT_CONCURRENCY)

        async def build_watchlist_row(
            symbol: str,
        ) -> tuple[dict[str, Any], dict[str, str], bool, str, bool]:
            quote = quote_map.get(symbol) if isinstance(quote_map, dict) else None
            quote_price = _safe_float((quote or {}).get("price"))
            rec_key = f"recommendation:{symbol}"

            async def fetch_recommendation_bundle() -> dict[str, Any]:
                async with rec_semaphore:
                    recommendation = await _fetch_recommendation(symbol, quote_price)
                    status_value = "partial" if recommendation.get("degraded") else "ok"
                    return {
                        "recommendation": recommendation,
                        "status": status_value,
                        "provider_status": {f"recommendation:{symbol}": status_value},
                    }

            (
                rec_value,
                rec_stale,
                _rec_age_seconds,
                rec_cache_tier,
                rec_cache_hit,
            ) = await _get_or_refresh_public_module(
                key=rec_key,
                fresh_ttl_seconds=RECOMMENDATION_FRESH_TTL_SECONDS,
                stale_ttl_seconds=RECOMMENDATION_STALE_TTL_SECONDS,
                fetcher=fetch_recommendation_bundle,
                warm_source=warm_source,
            )
            rec_bundle = rec_value if isinstance(rec_value, dict) else {}
            recommendation = (
                rec_bundle.get("recommendation")
                if isinstance(rec_bundle.get("recommendation"), dict)
                else _fallback_recommendation_from_quote(symbol, quote)
            )
            if _is_recommendation_gap_text(recommendation.get("detail")):
                recommendation = _fallback_recommendation_from_quote(symbol, quote)
            row = {
                "symbol": symbol,
                "symbol_quality": "tradable_ticker",
                "company_name": str((quote or {}).get("company_name") or symbol),
                "price": quote_price,
                "change_pct": _safe_float((quote or {}).get("change_percent")),
                "volume": _safe_int((quote or {}).get("volume")),
                "market_cap": _safe_float((quote or {}).get("market_cap")),
                "sector": str((quote or {}).get("sector") or "").strip() or None,
                "recommendation": str(recommendation.get("signal") or "NEUTRAL"),
                "recommendation_detail": str(recommendation.get("detail") or "").strip() or None,
                "recommendation_source": str(recommendation.get("source") or "Fallback"),
                "source_tags": sorted(
                    set(
                        [
                            str((quote or {}).get("source") or "Unknown"),
                            str(recommendation.get("source") or "Fallback"),
                        ]
                    )
                ),
                "degraded": bool(not quote or recommendation.get("degraded") or rec_stale),
                "as_of": (quote or {}).get("fetched_at")
                if isinstance((quote or {}).get("fetched_at"), str)
                else None,
            }
            return (
                row,
                {f"recommendation:{symbol}": str(rec_bundle.get("status") or "partial")},
                rec_stale,
                rec_cache_tier,
                rec_cache_hit,
            )

        watchlist_results = await asyncio.gather(
            *(build_watchlist_row(symbol) for symbol in watchlist_symbols_for_cards)
        )

        for row, status_map, row_stale, row_cache_tier, row_cache_hit in watchlist_results:
            watchlist_rows.append(row)
            provider_status.update(status_map)
            stale = stale or row_stale
            aggregated_cache_tier = _merge_cache_tier(aggregated_cache_tier, row_cache_tier)
            aggregated_cache_hit = aggregated_cache_hit and row_cache_hit

        for pick_row in visible_pick_rows_source:
            stock = pick_row["row"]
            input_symbol = str(pick_row.get("input_symbol") or "").strip().upper()
            quote_symbol = str(pick_row.get("quote_symbol") or input_symbol).strip().upper()
            alias_repaired = bool(pick_row.get("alias_repaired"))
            tier = str(_pick_row_value(stock, "tier", "") or "").strip().upper() or None
            quote = quote_map.get(quote_symbol) if isinstance(quote_map, dict) else None
            quote_source = str((quote or {}).get("source") or "").strip() or "Unknown"
            quote_status = str(provider_status.get(f"quote:{quote_symbol}") or "partial")
            if not quote and quote_symbol and quote_status != "unsupported":
                try:
                    rescued_quote = await fetch_market_data(
                        quote_symbol, user_id, consent_token, allow_slow_fallbacks=True
                    )
                except Exception as rescue_error:
                    logger.debug(
                        "[Kai Market] row rescue quote failed for %s: %s",
                        quote_symbol,
                        rescue_error,
                    )
                else:
                    rescued_price = _safe_float((rescued_quote or {}).get("price"))
                    if rescued_price is not None:
                        quote = rescued_quote or {}
                        quote_source = str((quote or {}).get("source") or "").strip() or "Unknown"
                        quote_status = "ok"
                        provider_status[f"quote:{quote_symbol}"] = "ok"
                        if isinstance(quote_map, dict):
                            quote_map[quote_symbol] = quote
                        market_insights_cache.append_series_point(
                            f"quote:{quote_symbol}", rescued_price
                        )
            renaissance_rows.append(
                {
                    "symbol": quote_symbol or input_symbol,
                    "input_symbol": input_symbol or None,
                    "quote_symbol": quote_symbol or None,
                    "company_name": str(
                        _pick_row_value(stock, "company_name", quote_symbol) or quote_symbol
                    ),
                    "sector": str(_pick_row_value(stock, "sector", "") or "").strip() or None,
                    "tier": tier,
                    "tier_rank": int(_pick_row_value(stock, "tier_rank", 0) or 0),
                    "conviction_weight": float(TIER_WEIGHTS.get(tier or "", 0.5)),
                    "recommendation_bias": _recommendation_bias_from_tier(tier),
                    "investment_thesis": str(
                        _pick_row_value(stock, "investment_thesis", "") or ""
                    ).strip()
                    or None,
                    "fcf_billions": _safe_float(_pick_row_value(stock, "fcf_billions")),
                    "price": _safe_float((quote or {}).get("price")),
                    "change_pct": _safe_float((quote or {}).get("change_percent")),
                    "volume": _safe_int((quote or {}).get("volume")),
                    "market_cap": _safe_float((quote or {}).get("market_cap")),
                    "source_tags": sorted(set(["Renaissance", quote_source])),
                    "degraded": bool(not quote),
                    "alias_repaired": alias_repaired,
                    "quote_provider": quote_source,
                    "quote_status": "ok" if quote else quote_status,
                    "filtered_out_reason": None,
                    "as_of": (quote or {}).get("fetched_at")
                    if isinstance((quote or {}).get("fetched_at"), str)
                    else None,
                }
            )

        movers_pair = movers_value if isinstance(movers_value, (tuple, list)) else ({}, {})
        movers_payload = (
            movers_pair[0] if len(movers_pair) > 0 and isinstance(movers_pair[0], dict) else {}
        )
        movers_status = (
            movers_pair[1] if len(movers_pair) > 1 and isinstance(movers_pair[1], dict) else {}
        )
        if not movers_payload.get("gainers") and not movers_payload.get("losers"):
            movers_payload = _fallback_movers_from_watchlist(watchlist_rows)
            movers_status = {
                "movers:gainers": "partial",
                "movers:losers": "partial",
                "movers:active": "partial",
            }
        provider_status.update({str(k): str(v) for k, v in movers_status.items()})

        stale = stale or movers_stale
        aggregated_cache_tier = _merge_cache_tier(aggregated_cache_tier, movers_cache_tier)
        aggregated_cache_hit = aggregated_cache_hit and movers_cache_hit

        sectors_pair = (
            sectors_value if isinstance(sectors_value, (tuple, list)) else ([], "partial")
        )
        sector_rotation = (
            sectors_pair[0] if len(sectors_pair) > 0 and isinstance(sectors_pair[0], list) else []
        )
        sector_status = (
            str(sectors_pair[1])
            if len(sectors_pair) > 1 and isinstance(sectors_pair[1], str)
            else "partial"
        )

        if not sector_rotation:
            sector_rotation = _fallback_sector_rotation_from_watchlist(watchlist_rows)
            sector_status = "partial"
        provider_status["sectors"] = sector_status

        stale = stale or sectors_stale
        aggregated_cache_tier = _merge_cache_tier(aggregated_cache_tier, sectors_cache_tier)
        aggregated_cache_hit = aggregated_cache_hit and sectors_cache_hit

        news_symbols = [
            str(row.get("symbol") or "").strip().upper()
            for row in watchlist_rows
            if str(row.get("symbol") or "").strip()
        ][:NEWS_SYMBOL_MAX]
        if not news_symbols:
            news_symbols = watchlist_symbols_for_cards[:NEWS_SYMBOL_MAX]
        news_key = f"news:{','.join(news_symbols)}:{days_back}"

        async def fetch_news_bundle() -> dict[str, Any]:
            rows: list[dict[str, Any]] = []
            statuses: dict[str, str] = {}
            semaphore = asyncio.Semaphore(NEWS_FANOUT_CONCURRENCY)

            async def fetch_symbol_news(symbol: str) -> tuple[str, list[dict[str, Any]], str]:
                async with semaphore:
                    try:
                        articles = await fetch_market_news(
                            symbol, user_id, consent_token, days_back=days_back
                        )
                        return symbol, (articles or []), ("ok" if articles else "partial")
                    except Exception as exc:
                        logger.debug("[Kai Market] news failed for %s: %s", symbol, exc)
                        return symbol, [], _provider_status_from_exception(exc)

            news_results = await asyncio.gather(
                *(fetch_symbol_news(symbol) for symbol in news_symbols)
            )
            degraded_news: list[str] = []
            for symbol, articles, status_value in news_results:
                statuses[f"news:{symbol}"] = status_value
                if status_value not in {"ok", "partial"}:
                    degraded_news.append(f"{symbol}:{status_value}")
                for article in articles[:4]:
                    rows.append(
                        {
                            "symbol": symbol,
                            "title": str(article.get("title") or "").strip(),
                            "url": str(article.get("url") or "").strip(),
                            "published_at": str(article.get("publishedAt") or _now_iso()),
                            "source_name": str(
                                (
                                    (article.get("source") or {})
                                    if isinstance(article.get("source"), dict)
                                    else {}
                                ).get("name")
                                or "Unknown"
                            ),
                            "provider": str(article.get("provider") or "unknown"),
                            "sentiment_hint": None,
                            "degraded": False,
                        }
                    )
            if degraded_news:
                logger.warning(
                    "[Kai Market] news bundle degraded for %s symbols: %s",
                    len(degraded_news),
                    ", ".join(degraded_news[:6]),
                )

            deduped: list[dict[str, Any]] = []
            seen: set[str] = set()
            for row in rows:
                key = f"{row.get('title')}::{row.get('url')}"
                if not row.get("title") or not row.get("url") or key in seen:
                    continue
                seen.add(key)
                deduped.append(row)

            deduped.sort(key=lambda item: str(item.get("published_at") or ""), reverse=True)
            return {"rows": deduped[:NEWS_ROWS_MAX], "provider_status": statuses}

        (
            news_value,
            news_stale,
            _news_age_seconds,
            news_cache_tier,
            news_cache_hit,
        ) = await _get_or_refresh_public_module(
            key=news_key,
            fresh_ttl_seconds=NEWS_FRESH_TTL_SECONDS,
            stale_ttl_seconds=NEWS_STALE_TTL_SECONDS,
            fetcher=fetch_news_bundle,
            warm_source="request",
        )
        news_bundle = news_value if isinstance(news_value, dict) else {}
        news_tape = news_bundle.get("rows") if isinstance(news_bundle.get("rows"), list) else []
        provider_status.update(
            {str(k): str(v) for k, v in (news_bundle.get("provider_status") or {}).items()}
        )
        stale = stale or news_stale
        aggregated_cache_tier = _merge_cache_tier(aggregated_cache_tier, news_cache_tier)
        aggregated_cache_hit = aggregated_cache_hit and news_cache_hit

        news_by_symbol: dict[str, dict[str, Any]] = {}
        for news in news_tape:
            if not isinstance(news, dict):
                continue
            symbol = str(news.get("symbol") or "").strip().upper()
            title = str(news.get("title") or "").strip()
            if not symbol or not title or symbol in news_by_symbol:
                continue
            news_by_symbol[symbol] = news

        market_overview = _build_market_overview(spy_quote, qqq_quote, vix_payload, status_payload)

        sparkline_points, sparkline_degraded, sparkline_sources = await _build_sparkline_points(
            spy_quote
        )

        financial_summary: dict[str, Any] = {}
        total_value = None
        holdings_count: int | None = None
        hero_degraded = False
        if personalized:
            financial_summary_cache = await market_insights_cache.get_or_refresh(
                f"financial-summary:{user_id}",
                fresh_ttl_seconds=FINANCIAL_SUMMARY_FRESH_TTL_SECONDS,
                stale_ttl_seconds=FINANCIAL_SUMMARY_STALE_TTL_SECONDS,
                fetcher=lambda: _get_financial_summary(user_id),
                serve_stale_while_revalidate=True,
            )
            financial_summary = (
                financial_summary_cache.value
                if isinstance(financial_summary_cache.value, dict)
                else {}
            )
            stale = stale or financial_summary_cache.stale
            total_value = _safe_float(
                financial_summary.get("total_value")
                or financial_summary.get("portfolio_total_value")
            )
            holdings_count = _summary_count(financial_summary)
            if holdings_count == 0:
                holdings_count = len([row for row in watchlist_rows if row.get("symbol")])
            hero_degraded = total_value is None

        hero = {
            "total_value": total_value,
            "day_change_value": None,
            "day_change_pct": None,
            "sparkline_points": sparkline_points,
            "as_of": (spy_quote or {}).get("fetched_at")
            if isinstance((spy_quote or {}).get("fetched_at"), str)
            else _now_iso(),
            "source_tags": sorted(
                set([*(sparkline_sources or []), *(["PKM"] if personalized else [])])
            ),
            "degraded": bool(hero_degraded or sparkline_degraded),
            "holdings_count": holdings_count,
            "portfolio_value_bucket": (
                financial_summary.get("portfolio_value_bucket") if personalized else None
            ),
        }

        signals = _build_signals(
            watchlist=watchlist_rows,
            movers=movers_payload,
            vix_payload=vix_payload,
            source_tags=["PMP/FMP", "Finnhub", "Fallback"],
        )

        spotlight_candidates: list[dict[str, Any]] = []
        for row in watchlist_rows:
            symbol = str(row.get("symbol") or "").strip().upper()
            related_news = news_by_symbol.get(symbol) or {}
            spotlight_candidates.append(
                {
                    **row,
                    "headline": str(related_news.get("title") or "").strip() or None,
                    "headline_url": str(related_news.get("url") or "").strip() or None,
                    "headline_source": str(related_news.get("source_name") or "").strip() or None,
                }
            )
        spotlight_candidates.sort(key=_spotlight_rank, reverse=True)
        spotlights = [
            {
                "symbol": row.get("symbol"),
                "company_name": row.get("company_name"),
                "price": row.get("price"),
                "change_pct": row.get("change_pct"),
                "recommendation": row.get("recommendation"),
                "recommendation_detail": row.get("recommendation_detail"),
                "recommendation_source": row.get("recommendation_source"),
                "story": _spotlight_story(row),
                "confidence": _spotlight_confidence(row),
                "headline": row.get("headline"),
                "headline_url": row.get("headline_url"),
                "headline_source": row.get("headline_source"),
                "source_tags": row.get("source_tags") or [],
                "as_of": row.get("as_of"),
                "degraded": bool(row.get("degraded")),
            }
            for row in spotlight_candidates[:2]
        ]

        themes = [
            {
                "title": str(item.get("sector") or "Unknown"),
                "subtitle": "Sector rotation",
                "symbol": str(item.get("sector") or "").upper()[:6],
                "change_pct": item.get("change_pct"),
                "headline": None,
                "source_tags": item.get("source_tags") or ["Fallback"],
                "degraded": bool(item.get("degraded")),
            }
            for item in sector_rotation[:3]
        ]

        generated_at = _now_iso()
        if any(value != "ok" for value in provider_status.values()):
            stale = True
        provider_cooldowns = market_insights_cache.provider_cooldown_snapshot()
        if provider_cooldowns:
            stale = True

        payload: dict[str, Any] = {
            "layout_version": "kai_home_v2",
            "user_id": user_id,
            "generated_at": generated_at,
            "stale": stale,
            "provider_status": provider_status,
            "hero": hero,
            "watchlist": watchlist_rows,
            "pick_sources": pick_sources,
            "active_pick_source": resolved_pick_source,
            "pick_rows": renaissance_rows,
            "renaissance_list": renaissance_rows,
            "movers": movers_payload,
            "sector_rotation": sector_rotation,
            "news_tape": news_tape,
            "signals": signals,
            "meta": {
                "stale": stale,
                "provider_status": provider_status,
                "cache_age_seconds": 0,
                "cache_tier": aggregated_cache_tier,
                "cache_hit": aggregated_cache_hit,
                "warm_source": warm_source,
                "market_mode": "personalized" if personalized else "baseline",
                "baseline_cache_tier": None if personalized else aggregated_cache_tier,
                "personalized_cache_tier": aggregated_cache_tier if personalized else None,
                "provider_cooldowns": provider_cooldowns,
                "symbol_quality": {
                    "requested_count": len(requested_watchlist_symbols),
                    "accepted_count": len(watchlist_symbols),
                    "filtered_count": len(filtered_symbols) + len(hidden_pick_symbols),
                },
                "filtered_symbols": [*filtered_symbols, *hidden_pick_symbols],
            },
            # Backward compatibility fields.
            "market_overview": market_overview,
            "spotlights": spotlights,
            "themes": themes,
        }
        return jsonable_encoder(payload)

    try:
        (
            home_value,
            home_stale,
            home_age_seconds,
            home_cache_tier,
            home_cache_hit,
        ) = await _get_or_refresh_public_module(
            key=home_key,
            fresh_ttl_seconds=HOME_FRESH_TTL_SECONDS,
            stale_ttl_seconds=HOME_STALE_TTL_SECONDS,
            fetcher=build_payload,
            warm_source=warm_source,
            serve_stale_while_revalidate=True,
        )
    except Exception as exc:
        logger.exception("[Kai Market] home payload build failed for %s: %s", user_id, exc)
        return _empty_market_home_payload(
            user_id=user_id,
            requested_watchlist_symbols=requested_watchlist_symbols,
            filtered_symbols=filtered_symbols,
            stale_reason="home_payload_build_failed",
            provider_status={"home": _provider_status_from_exception(exc)},
            market_mode="personalized" if personalized else "baseline",
        )

    payload = home_value if isinstance(home_value, dict) else {}
    payload["stale"] = bool(payload.get("stale")) or home_stale
    if home_stale:
        payload["stale_reason"] = "served_stale_cache"
    payload["cache_age_seconds"] = home_age_seconds

    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    meta["stale"] = bool(payload.get("stale"))
    meta["cache_age_seconds"] = home_age_seconds
    meta["cache_tier"] = str(meta.get("cache_tier") or home_cache_tier)
    meta["cache_hit"] = bool(meta.get("cache_hit")) or home_cache_hit
    meta["warm_source"] = str(meta.get("warm_source") or warm_source)
    meta["market_mode"] = str(
        meta.get("market_mode") or ("personalized" if personalized else "baseline")
    )
    meta["baseline_cache_tier"] = (
        home_cache_tier if meta["market_mode"] == "baseline" else meta.get("baseline_cache_tier")
    )
    meta["personalized_cache_tier"] = (
        home_cache_tier
        if meta["market_mode"] == "personalized"
        else meta.get("personalized_cache_tier")
    )
    cooldown_snapshot = market_insights_cache.provider_cooldown_snapshot()
    if cooldown_snapshot:
        meta["provider_cooldowns"] = cooldown_snapshot
    if payload.get("stale_reason"):
        meta["stale_reason"] = payload.get("stale_reason")
    if payload.get("provider_status"):
        meta["provider_status"] = payload.get("provider_status")
    payload["meta"] = meta

    logger.debug(
        "[Kai Market] home tier=%s stale=%s age=%ss watchlist=%s picks=%s headlines=%s source=%s",
        meta["cache_tier"],
        meta["stale"],
        home_age_seconds,
        len(payload.get("watchlist") or []),
        len(payload.get("pick_rows") or []),
        len(payload.get("news_tape") or []),
        payload.get("active_pick_source") or "default",
    )

    return payload


@router.get("/market/insights/baseline/{user_id}")
async def get_market_insights_baseline(
    user_id: str,
    days_back: int = Query(default=7, ge=1, le=14),
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    verify_user_id_match(firebase_uid, user_id)

    requested_watchlist_symbols = list(DEFAULT_SYMBOLS)
    filtered_symbols: list[dict[str, Any]] = []
    watchlist_symbols = list(DEFAULT_SYMBOLS)

    return await _get_market_insights_payload(
        user_id=user_id,
        requested_watchlist_symbols=requested_watchlist_symbols,
        filtered_symbols=filtered_symbols,
        watchlist_symbols=watchlist_symbols,
        days_back=days_back,
        active_pick_source=DEFAULT_PICK_SOURCE_ID,
        consent_token=None,
        personalized=False,
    )


@router.get("/market/insights/{user_id}")
async def get_market_insights(
    user_id: str,
    symbols: str | None = Query(default=None, description="CSV list of symbols, max 8"),
    days_back: int = Query(default=7, ge=1, le=14),
    pick_source: str | None = Query(
        default=None,
        description="Active market picks source. Only the default source is live today.",
    ),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )

    symbol_master = get_symbol_master_service()
    requested_watchlist_symbols = _normalize_symbols(symbols)
    filtered_symbols: list[dict[str, Any]] = []
    watchlist_symbols: list[str] = []
    for raw_symbol in requested_watchlist_symbols:
        classification = symbol_master.classify(raw_symbol)
        if classification.tradable:
            watchlist_symbols.append(classification.symbol)
            continue
        filtered_symbols.append(
            {
                "input_symbol": raw_symbol,
                "normalized_symbol": classification.symbol,
                "reason": classification.reason,
                "trust_tier": classification.trust_tier,
            }
        )
    if watchlist_symbols:
        watchlist_symbols = list(dict.fromkeys(watchlist_symbols))
    if not watchlist_symbols:
        watchlist_symbols = DEFAULT_SYMBOLS
    active_pick_source = _normalize_pick_source(pick_source)
    consent_token = _coerce_consent_token(token_data.get("token"))
    if not consent_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid consent token",
        )

    return await _get_market_insights_payload(
        user_id=user_id,
        requested_watchlist_symbols=requested_watchlist_symbols,
        filtered_symbols=filtered_symbols,
        watchlist_symbols=watchlist_symbols,
        days_back=days_back,
        active_pick_source=active_pick_source,
        consent_token=consent_token,
        personalized=True,
    )


@router.get("/stock-preview/{user_id}")
async def get_stock_preview(
    user_id: str,
    symbol: str = Query(..., min_length=1, description="Ticker symbol"),
    pick_source: str | None = Query(default=None),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )

    consent_token = _coerce_consent_token(token_data.get("token"))
    if not consent_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid consent token",
        )

    repaired_symbol, _ = _repair_quote_symbol(symbol)
    classification = get_symbol_master_service().classify(repaired_symbol)
    normalized_symbol = classification.symbol
    active_pick_source = _normalize_pick_source(pick_source)
    selected_pick_source = active_pick_source
    pick_rows_source, pick_sources, resolved_pick_source = await _resolve_pick_source_rows(
        user_id,
        active_pick_source,
    )
    selected_source_meta = next(
        (
            source
            for source in pick_sources
            if str(source.get("id") or "").strip() == selected_pick_source
        ),
        None,
    )

    quote_payload: dict[str, Any]
    try:
        quote_payload = await fetch_market_data(normalized_symbol, user_id, consent_token) or {}
    except Exception as exc:
        logger.warning("[Kai Market] stock preview quote failed for %s: %s", normalized_symbol, exc)
        quote_payload = {}

    matched_row: dict[str, Any] | None = None
    for row in pick_rows_source:
        candidate_symbol, _ = _repair_quote_symbol(_pick_row_value(row, "ticker", ""))
        if isinstance(row, dict):
            row_symbol = candidate_symbol
            if row_symbol != normalized_symbol:
                continue
            matched_row = row
            break

        row_symbol = candidate_symbol
        if row_symbol != normalized_symbol:
            continue
        matched_row = {
            "ticker": getattr(row, "ticker", None),
            "company_name": getattr(row, "company_name", None),
            "sector": getattr(row, "sector", None),
            "tier": getattr(row, "tier", None),
            "tier_rank": getattr(row, "tier_rank", None),
            "conviction_weight": getattr(row, "conviction_weight", None),
            "recommendation_bias": getattr(row, "recommendation_bias", None),
            "investment_thesis": getattr(row, "investment_thesis", None),
            "fcf_billions": getattr(row, "fcf_billions", None),
        }
        break

    advisor_summary: dict[str, Any] | None = None
    if selected_pick_source.startswith("ria:"):
        ria_package = await RIAIAMService().get_pick_package_for_source(
            user_id, selected_pick_source
        )
        top_picks = ria_package.get("top_picks") if isinstance(ria_package, dict) else []
        avoid_rows = ria_package.get("avoid_rows") if isinstance(ria_package, dict) else []
        screening_sections = (
            ria_package.get("screening_sections") if isinstance(ria_package, dict) else []
        )
        matched_avoid_row = (
            next(
                (
                    row
                    for row in avoid_rows
                    if _repair_quote_symbol(_pick_row_value(row, "ticker", ""))[0]
                    == normalized_symbol
                ),
                None,
            )
            if isinstance(avoid_rows, list)
            else None
        )
        has_screening_rows = _count_screening_rows(screening_sections) > 0
        selected_state = (
            str((selected_source_meta or {}).get("state") or "unavailable").strip() or "unavailable"
        )
        ticker_status = "not_listed"
        if selected_state == "pending":
            ticker_status = "pending"
        elif selected_state == "unavailable":
            ticker_status = "unavailable"
        elif matched_row:
            ticker_status = "included"
        elif matched_avoid_row:
            ticker_status = "excluded"
        elif has_screening_rows:
            ticker_status = "screened"
        advisor_summary = {
            "source_id": selected_pick_source,
            "source_label": str((selected_source_meta or {}).get("label") or "Advisor list"),
            "kind": "ria",
            "state": selected_state,
            "package_note": str(ria_package.get("package_note") or "").strip() or None,
            "top_pick_count": len(top_picks) if isinstance(top_picks, list) else 0,
            "avoid_count": len(avoid_rows) if isinstance(avoid_rows, list) else 0,
            "screening_section_count": len(screening_sections)
            if isinstance(screening_sections, list)
            else 0,
            "screening_row_count": _count_screening_rows(screening_sections),
            "ticker_status": ticker_status,
            "avoid_reason": str(_pick_row_value(matched_avoid_row, "reason", "") or "").strip()
            or None,
            "resolved_with_fallback": resolved_pick_source != selected_pick_source,
        }

    quote_price = _safe_float(quote_payload.get("price"))
    quote_change_pct = _safe_float(quote_payload.get("change_percent"))
    quote_as_of = (
        quote_payload.get("fetched_at")
        if isinstance(quote_payload.get("fetched_at"), str)
        else _now_iso()
    )

    return {
        "symbol": normalized_symbol,
        "active_pick_source": resolved_pick_source,
        "pick_sources": pick_sources,
        "quote": {
            "price": quote_price,
            "change_pct": quote_change_pct,
            "as_of": quote_as_of,
            "company_name": str(quote_payload.get("company_name") or normalized_symbol),
            "sector": str(quote_payload.get("sector") or "").strip() or None,
            "market_cap": _safe_float(quote_payload.get("market_cap")),
            "volume": _safe_int(quote_payload.get("volume")),
            "source_tags": [str(quote_payload.get("source") or "Unknown")],
            "degraded": quote_price is None,
        },
        "list_match": {
            "in_list": bool(matched_row),
            "source_id": resolved_pick_source,
            "label": "On selected list" if matched_row else "Not on selected list",
            "company_name": matched_row.get("company_name") if matched_row else None,
            "sector": matched_row.get("sector") if matched_row else None,
            "tier": matched_row.get("tier") if matched_row else None,
            "tier_rank": matched_row.get("tier_rank") if matched_row else None,
            "conviction_weight": matched_row.get("conviction_weight") if matched_row else None,
            "recommendation_bias": matched_row.get("recommendation_bias") if matched_row else None,
            "investment_thesis": matched_row.get("investment_thesis") if matched_row else None,
            "fcf_billions": matched_row.get("fcf_billions") if matched_row else None,
        },
        "advisor_summary": advisor_summary,
    }
