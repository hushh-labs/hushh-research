from __future__ import annotations

from datetime import datetime, timezone

from hushh_mcp.services.market_refresh_policy import provider_quote_cache_ttl_seconds


def test_provider_quote_cache_tightens_during_us_market_hours() -> None:
    open_session = datetime(2026, 7, 14, 14, 0, tzinfo=timezone.utc)  # 10:00 ET

    assert provider_quote_cache_ttl_seconds(600, now=open_session) == 120


def test_provider_quote_cache_relaxes_when_us_market_is_closed() -> None:
    closed_session = datetime(2026, 7, 14, 23, 0, tzinfo=timezone.utc)  # 19:00 ET

    assert provider_quote_cache_ttl_seconds(600, now=closed_session) == 1_800
