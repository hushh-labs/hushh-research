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
