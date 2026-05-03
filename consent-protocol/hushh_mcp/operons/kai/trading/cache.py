"""Parquet-on-disk cache for OHLCV bar series.

Keyed by `(ticker, timeframe, start_iso, end_iso)`. Used by the
backtest harness and paper-trading service to avoid hitting external
data providers more than necessary, and to make backtests reproducible
when underlying provider series shift.

Cache root resolution:

1. `KAI_TRADING_CACHE_DIR` env var, if set.
2. `~/.cache/hushh/kai-trading/bars/`.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .data import OHLCV_COLUMNS, BarFetcher, BarSeries, Timeframe, _to_utc


def cache_root() -> Path:
    override = os.getenv("KAI_TRADING_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".cache" / "hushh" / "kai-trading" / "bars"


def cache_key(ticker: str, timeframe: Timeframe, start: datetime, end: datetime) -> str:
    payload = f"{ticker.upper()}|{timeframe}|{_to_utc(start).isoformat()}|{_to_utc(end).isoformat()}"
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    safe_ticker = "".join(ch if ch.isalnum() else "_" for ch in ticker.upper())
    return f"{safe_ticker}-{timeframe}-{digest}.parquet"


def load(path: Path, ticker: str, timeframe: Timeframe) -> BarSeries:
    frame = pd.read_parquet(path)
    if frame.index.tz is None:
        frame.index = frame.index.tz_localize(timezone.utc)
    return BarSeries(ticker=ticker, timeframe=timeframe, frame=frame[list(OHLCV_COLUMNS)])


def save(series: BarSeries, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    series.frame.to_parquet(path)


def get_or_fetch(
    fetcher: BarFetcher,
    ticker: str,
    start: datetime,
    end: datetime,
    timeframe: Timeframe = "1d",
    *,
    root: Path | None = None,
) -> BarSeries:
    """Return a BarSeries, hitting disk cache before the fetcher."""

    base = root or cache_root()
    path = base / cache_key(ticker, timeframe, start, end)
    if path.exists():
        return load(path, ticker, timeframe)
    series = fetcher.fetch(ticker, start, end, timeframe)
    save(series, path)
    return series


__all__ = ["cache_key", "cache_root", "get_or_fetch", "load", "save"]
