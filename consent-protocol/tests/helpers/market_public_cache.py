from datetime import datetime

import pytest

from api.routes.kai import market_insights
from hushh_mcp.services import market_insights_cache as cache_module


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


@pytest.fixture(autouse=True)
def regular_session_clock(monkeypatch):
    now = datetime.fromisoformat("2026-07-14T14:00:00+00:00").timestamp()
    monkeypatch.setattr(cache_module.time, "time", lambda: now)
    monkeypatch.setattr(market_insights, "time", lambda: cache_module.time.time())


async def _payload_fetcher():
    return {"rows": [{"symbol": "AAPL"}], "provider_status": {"quote:AAPL": "ok"}}
