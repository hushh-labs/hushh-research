from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hushh_mcp.services.market_refresh_policy import (
    closed_price_snapshot_usable,
    price_cache_retention_seconds,
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


@pytest.mark.parametrize("instant", ["2026-12-25T16:00:00+00:00", "2026-11-27T18:00:00+00:00"])
def test_holidays_and_early_close_do_not_use_open_cache_window(instant):
    assert us_market_session_opened_at(datetime.fromisoformat(instant)) is None
    assert provider_quote_cache_ttl_seconds(600, now=datetime.fromisoformat(instant)) == 1800


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


@pytest.mark.parametrize(
    ("saved", "opening"),
    [
        ("2026-07-17T19:59:00+00:00", "2026-07-20T13:30:00+00:00"),
        ("2026-11-25T20:59:00+00:00", "2026-11-27T14:30:00+00:00"),
        ("2026-11-27T17:59:00+00:00", "2026-11-30T14:30:00+00:00"),
    ],
)
def test_price_retention_survives_weekends_holidays_and_early_closes(saved, opening):
    saved_at, opens_at = datetime.fromisoformat(saved), datetime.fromisoformat(opening)
    assert (
        saved_at.timestamp() + price_cache_retention_seconds(1800, saved_at)
        >= opens_at.timestamp() + 120
    )
    before_open = datetime.fromtimestamp(opens_at.timestamp() - 1, tz=timezone.utc)
    assert closed_price_snapshot_usable(saved_at.timestamp(), before_open)
    assert not closed_price_snapshot_usable(saved_at.timestamp() - 7 * 86400, before_open)
