"""Pure Market response presentation, independent of provider access."""

from typing import Any


def recommendation_from_target(rows, quote_price, safe_float) -> dict[str, Any]:
    target = safe_float((rows[0] or {}).get("targetConsensus"))
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


def market_home_response(
    home_value,
    home_stale,
    home_age_seconds,
    home_cache_tier,
    home_cache_hit,
    warm_source,
    personalized,
    prices_paused,
    scheduled_status,
    cooldowns,
    logger,
) -> dict[str, Any]:
    payload = dict(home_value) if isinstance(home_value, dict) else {}
    if prices_paused:
        market_overview = list(payload.get("market_overview") or [])
        scheduled = scheduled_status()
        market_overview = [row for row in market_overview if row.get("label") != "Market Status"]
        payload["market_overview"] = [*market_overview, scheduled]
    payload["stale"] = bool(payload.get("stale")) or home_stale or prices_paused
    if prices_paused:
        payload["stale_reason"] = "market_closed"
    elif home_stale:
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
    cooldown_snapshot = cooldowns()
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


def stock_preview_quote(
    quote_payload, normalized_symbol, _safe_float, _safe_int, _now_iso
) -> dict[str, Any]:
    quote_price = _safe_float(quote_payload.get("price"))
    quote_change_pct = _safe_float(quote_payload.get("change_percent"))
    quote_as_of = (
        quote_payload.get("fetched_at")
        if isinstance(quote_payload.get("fetched_at"), str)
        else _now_iso()
    )

    return {
        "price": quote_price,
        "change_pct": quote_change_pct,
        "as_of": quote_as_of,
        "company_name": str(quote_payload.get("company_name") or normalized_symbol),
        "sector": str(quote_payload.get("sector") or "").strip() or None,
        "market_cap": _safe_float(quote_payload.get("market_cap")),
        "volume": _safe_int(quote_payload.get("volume")),
        "source_tags": [str(quote_payload.get("source") or "Unknown")],
        "degraded": quote_price is None,
    }


async def resolve_public_module(
    name, task, fallback_factory, status_from_exception, logger
) -> tuple[Any, bool, int, str, bool]:
    try:
        return await task
    except Exception as exc:
        status_value = status_from_exception(exc)
        logger.warning(
            "[Kai Market] %s module failed during concurrent refresh: %s",
            name,
            type(exc).__name__,
        )
        return (fallback_factory(status_value), True, 0, "live", False)
