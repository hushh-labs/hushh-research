"""Public Market cache orchestration with request-resolved dependencies."""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from hushh_mcp.services.market_history_policy import daily_history_cache_window
from hushh_mcp.services.market_refresh_policy import (
    MarketPriceRefreshPaused,
    closed_price_snapshot_usable,
    market_price_refresh_scope,
    price_cache_retention_seconds,
    us_market_session_opened_at,
)

logger = logging.getLogger(__name__)


@dataclass
class PublicModuleCache:
    cache: Any
    get_store: Callable
    clock: Callable
    is_open: Callable
    fresh_ttl: Callable
    safe_float: Callable
    refresh_prefixes: tuple[str, ...]
    sensitive_prefixes: tuple[str, ...]

    async def read(
        self,
        *,
        key: str,
        fresh_ttl_seconds: int,
        stale_ttl_seconds: int,
        fetcher: Any,
        warm_source: str = "request",
        serve_stale_while_revalidate: bool = True,
    ) -> tuple[Any, bool, int, str, bool]:
        now_ts = self.clock()
        moment = datetime.fromtimestamp(now_ts, tz=timezone.utc)
        price_module = key.startswith(self.refresh_prefixes)
        closed = price_module and not self.is_open()
        if key.startswith(self.sensitive_prefixes):
            stale_ttl_seconds = price_cache_retention_seconds(stale_ttl_seconds, moment)
        # Tighten the fresh window during US market hours and relax it when closed,
        # for price-sensitive modules. Stale TTL is preserved so degradation and
        # serve-stale-while-revalidate behavior are unchanged.
        fresh_ttl_seconds = self.fresh_ttl(key, fresh_ttl_seconds)
        fresh_after_ts = (
            us_market_session_opened_at(datetime.fromtimestamp(now_ts, tz=timezone.utc))
            if key.startswith(self.sensitive_prefixes)
            else None
        )
        if key.startswith("stock_history:"):
            fresh_ttl_seconds, fresh_after_ts = daily_history_cache_window(moment)

        hit, store, l2_entry = await self.lookup(
            key, now_ts, moment, closed, fresh_ttl_seconds, fresh_after_ts
        )
        if hit is not None:
            return hit

        result = await self.cache.get_or_refresh(
            key,
            fresh_ttl_seconds=fresh_ttl_seconds,
            stale_ttl_seconds=stale_ttl_seconds,
            fetcher=lambda: self.refresh(
                key, price_module, fetcher, store, fresh_ttl_seconds, stale_ttl_seconds
            ),
            # The client keeps the old view while awaiting this request. Return the
            # refreshed prices during the session; retain stale-on-error fallback.
            serve_stale_while_revalidate=serve_stale_while_revalidate and fresh_after_ts is None,
            fresh_after_ts=fresh_after_ts,
            should_refresh=lambda value: self.has_recoverable_degradation(key, value),
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

    def has_recoverable_degradation(self, key: str, payload: Any) -> bool:
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
                    if row.get("degraded") and self.safe_float(row.get("price")) is None:
                        return True
        return False

    async def lookup(self, key, now_ts, moment, closed, fresh_ttl_seconds, fresh_after_ts):
        existing_l1 = self.cache.peek(key)
        if (
            not closed
            and existing_l1
            and (now_ts - existing_l1.fetched_at) <= fresh_ttl_seconds
            and (fresh_after_ts is None or existing_l1.fetched_at >= fresh_after_ts)
            and not self.has_recoverable_degradation(key, existing_l1.value)
        ):
            return (
                (
                    existing_l1.value,
                    False,
                    max(0, int(now_ts - existing_l1.fetched_at)),
                    "memory",
                    True,
                ),
                None,
                None,
            )

        store = None
        l2_entry = None
        try:
            store = self.get_store()
            l2_entry = await store.get_entry(key)
        except Exception as exc:
            # L2 is optional. Never fail the request path when Postgres cache is unavailable.
            logger.warning("[Kai Market] L2 cache read skipped for %s: %s", key, type(exc).__name__)
            store = None
            l2_entry = None
        if (
            not closed
            and l2_entry
            and l2_entry.is_fresh(now_ts)
            and now_ts - l2_entry.updated_at_ts <= fresh_ttl_seconds
            and (fresh_after_ts is None or l2_entry.updated_at_ts >= fresh_after_ts)
            and not self.has_recoverable_degradation(key, l2_entry.payload)
        ):
            self.cache.seed_entry(key, l2_entry.payload, l2_entry.updated_at_ts)
            return (
                (l2_entry.payload, False, l2_entry.age_seconds(now_ts), "postgres", True),
                store,
                l2_entry,
            )

        # Seed stale L2 into L1 so L1 stale-on-error can serve fallback.
        if (
            l2_entry
            and (
                l2_entry.is_stale_servable(now_ts)
                or (closed and closed_price_snapshot_usable(l2_entry.updated_at_ts, moment))
            )
            and (existing_l1 is None or l2_entry.updated_at_ts > existing_l1.fetched_at)
        ):
            self.cache.seed_entry(key, l2_entry.payload, l2_entry.updated_at_ts)

        if closed:
            saved = self.cache.peek(key)
            if saved and closed_price_snapshot_usable(saved.fetched_at, moment):
                tier = (
                    "postgres"
                    if l2_entry and saved.fetched_at == l2_entry.updated_at_ts
                    else "memory"
                )
                return (
                    (saved.value, True, max(0, int(now_ts - saved.fetched_at)), tier, True),
                    store,
                    l2_entry,
                )
            raise MarketPriceRefreshPaused("market_closed_no_cached_price")

        return None, store, l2_entry

    async def refresh(
        self, key, price_module, fetcher, store, fresh_ttl_seconds, stale_ttl_seconds
    ) -> Any:
        requested_at = self.clock()
        if price_module:
            with market_price_refresh_scope():
                value = await fetcher()
        else:
            value = await fetcher()
        completed_session = (
            us_market_session_opened_at(datetime.fromtimestamp(self.clock(), tz=timezone.utc))
            if key.startswith(self.sensitive_prefixes)
            else None
        )
        if key.startswith("stock_history:"):
            completed_session = daily_history_cache_window(
                datetime.fromtimestamp(self.clock(), tz=timezone.utc)
            )[1]
        if completed_session is not None and requested_at < completed_session:
            # Nested caches may have been read before opening. Rebuild once
            # under the new session before stamping this assembled snapshot.
            if price_module:
                with market_price_refresh_scope():
                    value = await fetcher()
            else:
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
                logger.warning(
                    "[Kai Market] L2 cache write skipped for %s: %s", key, type(exc).__name__
                )
        return value
