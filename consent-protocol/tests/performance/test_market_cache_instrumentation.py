"""
Tests for market cache hit/miss/fetch instrumentation.
Log lines align with Kushal cache_resource_resolved observability schema:
  resource_class=market_data cache_tier=memory|network freshness=fresh|stale|missing
"""

import time

import pytest

from hushh_mcp.services.market_insights_cache import MarketInsightsCache


class TestMarketCacheInstrumentation:
    def setup_method(self):
        self.cache = MarketInsightsCache()

    @pytest.mark.asyncio
    async def test_l1_fresh_hit_logs_cache_resource_resolved(self, caplog):
        """L1 fresh hit emits cache_resource_resolved with freshness=fresh."""
        import logging
        self.cache.seed_entry("quotes:AAPL", {"price": 100}, time.time())
        with caplog.at_level(logging.DEBUG, logger="hushh_mcp.services.market_insights_cache"):
            result = await self.cache.get_or_refresh(
                "quotes:AAPL",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=lambda: (_ for _ in ()).throw(AssertionError("should not fetch")),
            )
        assert result.stale is False
        messages = [r.message for r in caplog.records]
        assert any("cache_resource_resolved" in m for m in messages)
        assert any("freshness=fresh" in m for m in messages)
        assert any("cache_tier=memory" in m for m in messages)
        assert any("resource_class=market_data" in m for m in messages)

    @pytest.mark.asyncio
    async def test_l1_miss_logs_missing_then_network_fresh(self, caplog):
        """L1 miss emits freshness=missing then freshness=fresh after fetch."""
        import logging
        async def fake_fetcher():
            return {"price": 200}
        with caplog.at_level(logging.DEBUG, logger="hushh_mcp.services.market_insights_cache"):
            result = await self.cache.get_or_refresh(
                "quotes:MSFT",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=fake_fetcher,
            )
        assert result.stale is False
        messages = [r.message for r in caplog.records]
        assert any("freshness=missing" in m for m in messages)
        assert any("freshness=fresh" in m and "cache_tier=network" in m for m in messages)
        assert any("duration_ms=" in m for m in messages)

    @pytest.mark.asyncio
    async def test_fetch_error_logs_network_stale_fallback(self, caplog):
        """Fetch failure with stale fallback emits freshness=stale with fallback=true."""
        import logging
        self.cache.seed_entry("quotes:TSLA", {"price": 50}, time.time() - 100)
        async def failing_fetcher():
            raise RuntimeError("provider down")
        with caplog.at_level(logging.WARNING, logger="hushh_mcp.services.market_insights_cache"):
            result = await self.cache.get_or_refresh(
                "quotes:TSLA",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=failing_fetcher,
            )
        assert result.stale is True
        assert result.stale_reason == "refresh_failure"
        messages = [r.message for r in caplog.records]
        assert any("cache_resource_resolved" in m for m in messages)
        assert any("freshness=stale" in m and "fallback=true" in m for m in messages)
        assert any("cache_tier=network" in m for m in messages)

    @pytest.mark.asyncio
    async def test_all_log_lines_include_resource_class_market_data(self, caplog):
        """Every cache_resource_resolved log line must include resource_class=market_data."""
        import logging
        async def fake_fetcher():
            return {"data": "ok"}
        with caplog.at_level(logging.DEBUG, logger="hushh_mcp.services.market_insights_cache"):
            await self.cache.get_or_refresh(
                "home:baseline:user123",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=fake_fetcher,
            )
        resolved_logs = [r.message for r in caplog.records if "cache_resource_resolved" in r.message]
        assert len(resolved_logs) > 0
        assert all("resource_class=market_data" in m for m in resolved_logs)
