from datetime import datetime
from types import SimpleNamespace

import pytest

import hushh_mcp.operons.kai.fetchers as fetchers


@pytest.fixture(autouse=True)
def isolated_public_provider_cache(monkeypatch):
    from hushh_mcp.services import market_provider_cache
    from hushh_mcp.services.market_insights_cache import MarketInsightsCache

    class OfflineStore:
        async def get_entry(self, _key):
            return None

        async def set_entry(self, **_kwargs):
            return None

    monkeypatch.setattr(market_provider_cache, "market_insights_cache", MarketInsightsCache())
    monkeypatch.setattr(market_provider_cache, "get_market_cache_store_service", OfflineStore)
    opened_at = datetime.fromisoformat("2026-07-14T14:00:00+00:00").timestamp()
    monkeypatch.setattr(fetchers.time, "time", lambda: opened_at)
    monkeypatch.setattr(fetchers, "_MARKET_DATA_CACHE", {})
    monkeypatch.setattr(fetchers, "_MARKET_DATA_LOCKS", {})


def _valid_token(*_args, **_kwargs):
    return True, "", SimpleNamespace(user_id="user_1")


def _unexpected_validate(*_args, **_kwargs):
    raise AssertionError("validate_token should not run for public-safe market baseline fetches")
