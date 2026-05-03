"""Unit tests for the bar / fetcher primitives."""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from hushh_mcp.operons.kai.trading.data import (
    OHLCV_COLUMNS,
    BarSeries,
    StubBarFetcher,
    align_panel,
    fetch_panel,
)


def test_bar_series_rejects_missing_columns() -> None:
    bad = pd.DataFrame(
        {"close": [1.0]},
        index=pd.DatetimeIndex(["2024-01-01"], tz=timezone.utc),
    )
    with pytest.raises(ValueError, match="missing columns"):
        BarSeries(ticker="X", timeframe="1d", frame=bad)


def test_bar_series_rejects_naive_index() -> None:
    frame = pd.DataFrame(
        {c: [1.0] for c in OHLCV_COLUMNS},
        index=pd.DatetimeIndex(["2024-01-01"]),
    )
    with pytest.raises(ValueError, match="tz-aware"):
        BarSeries(ticker="X", timeframe="1d", frame=frame)


def test_bar_series_rejects_unsorted_index() -> None:
    frame = pd.DataFrame(
        {c: [1.0, 2.0] for c in OHLCV_COLUMNS},
        index=pd.DatetimeIndex(["2024-01-02", "2024-01-01"], tz=timezone.utc),
    )
    with pytest.raises(ValueError, match="sorted"):
        BarSeries(ticker="X", timeframe="1d", frame=frame)


def test_stub_fetcher_is_deterministic() -> None:
    fetcher = StubBarFetcher()
    start = datetime(2023, 1, 1, tzinfo=timezone.utc)
    end = datetime(2023, 6, 30, tzinfo=timezone.utc)
    a = fetcher.fetch("AAPL", start, end)
    b = fetcher.fetch("AAPL", start, end)
    pd.testing.assert_frame_equal(a.frame, b.frame)


def test_stub_fetcher_distinct_tickers_diverge() -> None:
    fetcher = StubBarFetcher()
    start = datetime(2023, 1, 1, tzinfo=timezone.utc)
    end = datetime(2023, 6, 30, tzinfo=timezone.utc)
    aapl = fetcher.fetch("AAPL", start, end)
    msft = fetcher.fetch("MSFT", start, end)
    # Same length, different paths.
    assert len(aapl) == len(msft)
    assert not aapl.frame.equals(msft.frame)


def test_align_panel_inner_join() -> None:
    fetcher = StubBarFetcher()
    start = datetime(2023, 1, 1, tzinfo=timezone.utc)
    end = datetime(2023, 3, 31, tzinfo=timezone.utc)
    panel = fetch_panel(fetcher, ["A", "B", "C"], start, end)
    closes = align_panel(panel)
    assert list(closes.columns) == ["A", "B", "C"]
    assert closes.index.is_monotonic_increasing
    assert not closes.isna().any().any()
