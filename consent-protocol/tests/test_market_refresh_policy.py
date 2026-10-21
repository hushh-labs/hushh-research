from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hushh_mcp.services.market_refresh_policy import (
    provider_quote_cache_ttl_seconds,
    seconds_until_us_market_open,
    us_market_session_opened_at,
)


def test_provider_quote_cache_tightens_during_us_market_hours() -> None:
    open_session = datetime(2026, 7, 14, 14, 0, tzinfo=timezone.utc)  # 10:00 ET

    assert provider_quote_cache_ttl_seconds(600, now=open_session) == 120


def test_provider_quote_cache_relaxes_when_us_market_is_closed() -> None:
    closed_session = datetime(2026, 7, 14, 23, 0, tzinfo=timezone.utc)  # 19:00 ET

    assert provider_quote_cache_ttl_seconds(600, now=closed_session) == 1_800


@pytest.mark.parametrize(
    ("instant", "opening"),
    [
        ("2026-07-14T13:29:59+00:00", None),
        ("2026-07-14T13:30:00+00:00", "2026-07-14T13:30:00+00:00"),
        ("2026-01-14T14:30:00+00:00", "2026-01-14T14:30:00+00:00"),
        ("2026-07-14T20:00:00+00:00", None),
        ("2026-07-18T14:00:00+00:00", None),
        ("2026-07-20T13:30:00+00:00", "2026-07-20T13:30:00+00:00"),
    ],
)
def test_opening_freshness_boundary_uses_eastern_session(instant, opening):
    expected = datetime.fromisoformat(opening).timestamp() if opening else None
    assert us_market_session_opened_at(datetime.fromisoformat(instant)) == expected


@pytest.mark.parametrize(
    ("instant", "opening"),
    [
        ("2026-07-14T13:29:00+00:00", "2026-07-14T13:30:00+00:00"),
        # The next opening crosses both a weekend and a daylight-saving change.
        ("2026-03-06T21:00:00+00:00", "2026-03-09T13:30:00+00:00"),
        ("2026-10-30T20:00:00+00:00", "2026-11-02T14:30:00+00:00"),
    ],
)
def test_closed_warmer_wakes_at_next_opening(instant, opening):
    now = datetime.fromisoformat(instant)
    assert (
        seconds_until_us_market_open(now)
        == datetime.fromisoformat(opening).timestamp() - now.timestamp()
    )
