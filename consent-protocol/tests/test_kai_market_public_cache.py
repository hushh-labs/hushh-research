from __future__ import annotations

import pytest

from api.routes.kai import market_insights
from hushh_mcp.services.market_insights_cache import MarketInsightsCache


class _FakeEntry:
    def __init__(self, payload, updated_at_ts: float, fresh_until_ts: float, stale_until_ts: float):
        self.payload = payload
        self.updated_at_ts = updated_at_ts
        self.fresh_until_ts = fresh_until_ts
        self.stale_until_ts = stale_until_ts

    def is_fresh(self, now_ts: float | None = None) -> bool:
        now = self.updated_at_ts if now_ts is None else now_ts
        return now <= self.fresh_until_ts

    def is_stale_servable(self, now_ts: float | None = None) -> bool:
        now = self.updated_at_ts if now_ts is None else now_ts
        return now <= self.stale_until_ts

    def age_seconds(self, now_ts: float | None = None) -> int:
        now = self.updated_at_ts if now_ts is None else now_ts
        return max(0, int(now - self.updated_at_ts))


class _FakeStore:
    def __init__(self) -> None:
        self.entries: dict[str, _FakeEntry] = {}

    async def get_entry(self, cache_key: str):
        return self.entries.get(cache_key)

    async def set_entry(
        self,
        *,
        cache_key: str,
        payload,
        fresh_ttl_seconds: int,
        stale_ttl_seconds: int,
        provider_status=None,
    ) -> None:
        from time import time

        now = time()
        self.entries[cache_key] = _FakeEntry(
            payload,
            updated_at_ts=now,
            fresh_until_ts=now + fresh_ttl_seconds,
            stale_until_ts=now + stale_ttl_seconds,
        )


async def _payload_fetcher():
    return {"rows": [{"symbol": "AAPL"}], "provider_status": {"quote:AAPL": "ok"}}


@pytest.mark.asyncio
async def test_public_module_reads_back_from_l2_when_l1_is_cold(monkeypatch):
    fake_store = _FakeStore()
    cold_l1 = MarketInsightsCache()
    fetch_count = {"count": 0}

    async def _counted_fetcher():
        fetch_count["count"] += 1
        return await _payload_fetcher()

    monkeypatch.setattr(market_insights, "get_market_cache_store_service", lambda: fake_store)
    monkeypatch.setattr(market_insights, "market_insights_cache", cold_l1)

    payload, stale, _age, tier, cache_hit = await market_insights._get_or_refresh_public_module(
        key="quotes:AAPL,MSFT",
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=_counted_fetcher,
        serve_stale_while_revalidate=False,
    )

    assert payload["rows"][0]["symbol"] == "AAPL"
    assert stale is False
    assert tier == "live"
    assert cache_hit is False
    assert fetch_count["count"] == 1

    monkeypatch.setattr(market_insights, "market_insights_cache", MarketInsightsCache())

    payload, stale, _age, tier, cache_hit = await market_insights._get_or_refresh_public_module(
        key="quotes:AAPL,MSFT",
        fresh_ttl_seconds=600,
        stale_ttl_seconds=1800,
        fetcher=_counted_fetcher,
        serve_stale_while_revalidate=False,
    )

    assert payload["rows"][0]["symbol"] == "AAPL"
    assert stale is False
    assert tier == "postgres"
    assert cache_hit is True
    assert fetch_count["count"] == 1


def test_market_home_cache_key_uses_shared_baseline_and_user_scoped_personalization():
    baseline_user_a = market_insights._market_home_cache_key(
        user_id="user_a",
        canonical_watchlist_key="AAPL,MSFT",
        days_back=7,
        active_pick_source="default",
        roster_signature="none",
        personalized=False,
    )
    baseline_user_b = market_insights._market_home_cache_key(
        user_id="user_b",
        canonical_watchlist_key="AAPL,MSFT",
        days_back=7,
        active_pick_source="default",
        roster_signature="none",
        personalized=False,
    )
    personalized_user_a = market_insights._market_home_cache_key(
        user_id="user_a",
        canonical_watchlist_key="AAPL,MSFT",
        days_back=7,
        active_pick_source="default",
        roster_signature="ria:alpha",
        personalized=True,
    )

    assert baseline_user_a == baseline_user_b
    assert baseline_user_a.startswith("home:baseline:")
    assert personalized_user_a.startswith("home:user_a:")


def test_repair_quote_symbol_normalizes_known_provider_aliases():
    assert market_insights._repair_quote_symbol("BRKB") == ("BRK-B", True)
    assert market_insights._repair_quote_symbol("CMCS1") == ("CMCSA", True)
    assert market_insights._repair_quote_symbol("MSFT") == ("MSFT", False)


@pytest.mark.asyncio
async def test_concurrent_public_module_failure_degrades_without_collapsing_home(monkeypatch):
    async def _fake_resolve_pick_source_rows(*_args, **_kwargs):
        return [], [market_insights._default_pick_source()], market_insights.DEFAULT_PICK_SOURCE_ID

    async def _fake_public_module(**kwargs):
        key = str(kwargs["key"])
        if key.startswith("home:"):
            return await kwargs["fetcher"](), False, 0, "live", False
        if key.startswith("quotes:"):
            raise RuntimeError("quote provider unavailable")
        if key == "macro:us":
            return (
                {
                    "vix": {
                        "label": "Volatility",
                        "value": None,
                        "delta_pct": None,
                        "as_of": None,
                        "source": "Unavailable",
                        "degraded": True,
                    },
                    "market_status": market_insights._scheduled_market_status_fallback(),
                    "provider_status": {"volatility": "partial", "market_status": "partial"},
                },
                False,
                0,
                "live",
                False,
            )
        if key == "movers:us":
            return ({}, {"movers:gainers": "partial"}), False, 0, "live", False
        if key == "sectors:us":
            return ([], "partial"), False, 0, "live", False
        if key.startswith("recommendation:"):
            symbol = key.split(":", 1)[1]
            return (
                {
                    "recommendation": market_insights._fallback_recommendation_from_quote(
                        symbol, None
                    ),
                    "status": "partial",
                    "provider_status": {f"recommendation:{symbol}": "partial"},
                },
                False,
                0,
                "live",
                False,
            )
        if key.startswith("news:"):
            return {"rows": [], "provider_status": {}}, False, 0, "live", False
        raise AssertionError(f"unexpected cache key {key}")

    monkeypatch.setattr(
        market_insights,
        "_resolve_pick_source_rows",
        _fake_resolve_pick_source_rows,
    )
    monkeypatch.setattr(
        market_insights,
        "_get_or_refresh_public_module",
        _fake_public_module,
    )

    payload = await market_insights._get_market_insights_payload(
        user_id="test-user",
        requested_watchlist_symbols=["AAPL"],
        filtered_symbols=[],
        watchlist_symbols=["AAPL"],
        days_back=7,
        active_pick_source=market_insights.DEFAULT_PICK_SOURCE_ID,
        consent_token=None,
        personalized=False,
    )

    assert payload["stale"] is True
    assert payload["provider_status"]["quote:AAPL"] == "failed"
    assert payload["watchlist"][0]["symbol"] == "AAPL"
    assert payload["watchlist"][0]["degraded"] is True
    assert payload["movers"]["degraded"] is True
    assert payload["provider_status"]["sectors"] == "partial"


@pytest.mark.asyncio
async def test_startup_warm_seeds_shared_baseline_home_after_public_modules(monkeypatch):
    call_order: list[str] = []
    captured: dict[str, object] = {}

    async def _fake_public_refresh():
        call_order.append("public")

    async def _fake_market_payload(**kwargs):
        call_order.append("baseline")
        captured.update(kwargs)
        return {
            "meta": {
                "cache_tier": "memory",
                "stale": False,
                "cache_age_seconds": 0,
            }
        }

    monkeypatch.setattr(market_insights, "_run_refresh_with_advisory_lock", _fake_public_refresh)
    monkeypatch.setattr(market_insights, "_get_market_insights_payload", _fake_market_payload)
    monkeypatch.setenv("KAI_MARKET_BACKGROUND_REFRESH", "true")
    monkeypatch.setenv("KAI_MARKET_STARTUP_WARM_TIMEOUT_SECONDS", "2")

    await market_insights.warm_market_insights_startup_once()

    assert call_order == ["public", "baseline"]
    assert captured == {
        "user_id": "startup",
        "requested_watchlist_symbols": list(market_insights.DEFAULT_SYMBOLS),
        "filtered_symbols": [],
        "watchlist_symbols": list(market_insights.DEFAULT_SYMBOLS),
        "days_back": 7,
        "active_pick_source": market_insights.DEFAULT_PICK_SOURCE_ID,
        "consent_token": None,
        "personalized": False,
        "warm_source": "startup",
    }
