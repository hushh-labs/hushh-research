"""
Tests for market cache hit/miss/fetch instrumentation.
Log lines align with Kushal cache_resource_resolved observability schema:
  resource_class, cache_tier, freshness, result, duration_ms_bucket
"""

import asyncio
import logging
import time

import pytest

from hushh_mcp.services.market_insights_cache import MarketInsightsCache


LOGGER_NAME = "hushh_mcp.services.market_insights_cache"


def _resolved_messages(caplog):
    return [
        record.message for record in caplog.records if "cache_resource_resolved" in record.message
    ]


def _assert_contract_fields(message: str) -> None:
    assert "resource_class=market_data" in message
    assert "cache_tier=" in message
    assert "freshness=" in message
    assert "result=" in message
    assert "duration_ms_bucket=" in message
    assert "duration_ms=" not in message
    assert "age_seconds=" not in message
    assert "quotes:" not in message
    assert "home:" not in message
    assert "user123" not in message


class TestMarketCacheInstrumentation:
    def setup_method(self):
        self.cache = MarketInsightsCache()

    @pytest.mark.asyncio
    async def test_l1_fresh_hit_logs_cache_resource_resolved(self, caplog):
        """L1 fresh hit emits cache_resource_resolved with freshness=fresh."""
        self.cache.seed_entry("quotes:AAPL", {"price": 100}, time.time())
        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            result = await self.cache.get_or_refresh(
                "quotes:AAPL",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=lambda: (_ for _ in ()).throw(AssertionError("should not fetch")),
            )
        assert result.stale is False
        messages = _resolved_messages(caplog)
        assert len(messages) == 1
        assert "freshness=fresh" in messages[0]
        assert "cache_tier=memory" in messages[0]
        assert "result=hit" in messages[0]
        _assert_contract_fields(messages[0])

    @pytest.mark.asyncio
    async def test_l1_miss_logs_missing_then_network_fresh(self, caplog):
        """L1 miss emits freshness=missing then freshness=fresh after fetch."""

        async def fake_fetcher():
            return {"price": 200}

        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            result = await self.cache.get_or_refresh(
                "quotes:MSFT",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=fake_fetcher,
            )
        assert result.stale is False
        messages = _resolved_messages(caplog)
        assert any("freshness=missing" in m and "result=miss" in m for m in messages)
        assert any(
            "freshness=fresh" in m and "cache_tier=network" in m and "result=success" in m
            for m in messages
        )
        assert all("duration_ms_bucket=" in m for m in messages)
        for message in messages:
            _assert_contract_fields(message)

    @pytest.mark.asyncio
    async def test_lock_recheck_hit_logs_locked_result(self, caplog):
        """Second caller under the lock emits the locked-hit decision."""
        call_count = 0

        async def slow_fetcher():
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(0.01)
            return {"price": 300}

        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            first, second = await asyncio.gather(
                self.cache.get_or_refresh(
                    "quotes:GOOG",
                    fresh_ttl_seconds=60,
                    stale_ttl_seconds=300,
                    fetcher=slow_fetcher,
                ),
                self.cache.get_or_refresh(
                    "quotes:GOOG",
                    fresh_ttl_seconds=60,
                    stale_ttl_seconds=300,
                    fetcher=slow_fetcher,
                ),
            )

        assert call_count == 1
        assert first.stale is False
        assert second.stale is False
        messages = _resolved_messages(caplog)
        assert any("result=locked_hit" in m for m in messages)
        for message in messages:
            _assert_contract_fields(message)

    @pytest.mark.asyncio
    async def test_fetch_error_logs_network_stale_fallback(self, caplog):
        """Fetch failure with stale fallback emits freshness=stale with fallback=true."""
        self.cache.seed_entry("quotes:TSLA", {"price": 50}, time.time() - 100)

        async def failing_fetcher():
            raise RuntimeError("provider down")

        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            result = await self.cache.get_or_refresh(
                "quotes:TSLA",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=failing_fetcher,
            )
        assert result.stale is True
        assert result.stale_reason == "refresh_failure"
        messages = _resolved_messages(caplog)
        assert any(
            "freshness=stale" in m and "cache_tier=network" in m and "result=fallback" in m
            for m in messages
        )
        for message in messages:
            _assert_contract_fields(message)

    @pytest.mark.asyncio
    async def test_error_without_fallback_logs_metadata_only_error(self, caplog):
        """Hard failures emit the unsafe/missing outcome without raw keys or errors."""

        async def failing_fetcher():
            raise RuntimeError("provider down")

        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            with pytest.raises(RuntimeError, match="provider down"):
                await self.cache.get_or_refresh(
                    "home:baseline:user123",
                    fresh_ttl_seconds=60,
                    stale_ttl_seconds=300,
                    fetcher=failing_fetcher,
                )

        messages = _resolved_messages(caplog)
        assert any(
            "freshness=missing" in m and "cache_tier=network" in m and "result=error" in m
            for m in messages
        )
        for message in messages:
            _assert_contract_fields(message)

    @pytest.mark.asyncio
    async def test_all_log_lines_include_required_metadata_only_fields(self, caplog):
        """Every cache_resource_resolved log line uses metadata-only schema fields."""

        async def fake_fetcher():
            return {"data": "ok"}

        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            await self.cache.get_or_refresh(
                "home:baseline:user123",
                fresh_ttl_seconds=60,
                stale_ttl_seconds=300,
                fetcher=fake_fetcher,
            )

        resolved_logs = _resolved_messages(caplog)
        assert resolved_logs
        for message in resolved_logs:
            _assert_contract_fields(message)
