"""Market data primitives for the Kai trading specialist.

Defines the canonical bar / series shapes and a `BarFetcher` protocol so
strategies and backtests are agnostic to the data source. Two concrete
fetchers ship here:

- `YFinanceBarFetcher` for live/historical pulls from Yahoo via yfinance.
- `StubBarFetcher` that returns deterministic synthetic series, used by
  unit tests and by the determinism contract on the backtest harness.

Network access is opt-in: the yfinance fetcher is only constructed at the
service / route layer, never inside an operon under test.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Mapping, Protocol, Sequence

import pandas as pd

Timeframe = str  # "1d", "1h", "5m" — yfinance interval strings

OHLCV_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume")


@dataclass(frozen=True)
class Bar:
    """A single OHLCV bar."""

    ts: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    ticker: str


@dataclass(frozen=True)
class BarSeries:
    """Typed wrapper over a tz-aware DatetimeIndex'd OHLCV DataFrame.

    The frame columns are exactly OHLCV_COLUMNS in that order. The index
    is sorted ascending and unique. `ticker` is stored alongside so a
    BarSeries can be passed around without losing its symbol.
    """

    ticker: str
    timeframe: Timeframe
    frame: pd.DataFrame = field(repr=False)

    def __post_init__(self) -> None:
        missing = [c for c in OHLCV_COLUMNS if c not in self.frame.columns]
        if missing:
            raise ValueError(f"BarSeries frame missing columns: {missing}")
        if not isinstance(self.frame.index, pd.DatetimeIndex):
            raise ValueError("BarSeries frame must have a DatetimeIndex")
        if self.frame.index.tz is None:
            raise ValueError("BarSeries frame index must be tz-aware (UTC)")
        if not self.frame.index.is_monotonic_increasing:
            raise ValueError("BarSeries frame index must be sorted ascending")
        if self.frame.index.has_duplicates:
            raise ValueError("BarSeries frame index has duplicate timestamps")

    def __len__(self) -> int:
        return len(self.frame)

    @property
    def closes(self) -> pd.Series:
        return self.frame["close"]

    @property
    def returns(self) -> pd.Series:
        return self.frame["close"].pct_change().fillna(0.0)


class BarFetcher(Protocol):
    """Source-agnostic bar fetcher protocol."""

    def fetch(
        self,
        ticker: str,
        start: datetime,
        end: datetime,
        timeframe: Timeframe = "1d",
    ) -> BarSeries: ...


class StubBarFetcher:
    """Deterministic synthetic-data fetcher for tests.

    Produces a geometric-Brownian-motion-style price walk seeded by the
    ticker name. Two calls with the same arguments return byte-identical
    frames — that's what the backtest determinism test depends on.
    """

    def __init__(self, *, drift: float = 0.0001, vol: float = 0.01) -> None:
        self._drift = drift
        self._vol = vol

    def fetch(
        self,
        ticker: str,
        start: datetime,
        end: datetime,
        timeframe: Timeframe = "1d",
    ) -> BarSeries:
        if timeframe != "1d":
            raise NotImplementedError("StubBarFetcher only supports 1d timeframe")
        start_utc = _to_utc(start)
        end_utc = _to_utc(end)
        if end_utc <= start_utc:
            raise ValueError("end must be after start")
        index = pd.date_range(start=start_utc, end=end_utc, freq="B", tz=timezone.utc)
        if len(index) == 0:
            raise ValueError("empty business-day range")
        seed = _seed_from_ticker(ticker)
        # Deterministic LCG — avoids depending on numpy.random global state.
        state = seed
        closes: list[float] = []
        price = 100.0 + (seed % 50)
        for _ in range(len(index)):
            state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
            # Map LCG output to a centered normal-ish shock via Box-Muller.
            u1 = ((state >> 8) & 0xFFFF) / 0x10000 or 1e-9
            state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
            u2 = ((state >> 8) & 0xFFFF) / 0x10000
            z = math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)
            shock = self._drift + self._vol * z
            price = max(0.01, price * (1.0 + shock))
            closes.append(price)
        opens = [closes[0]] + closes[:-1]
        highs = [max(o, c) * 1.001 for o, c in zip(opens, closes, strict=True)]
        lows = [min(o, c) * 0.999 for o, c in zip(opens, closes, strict=True)]
        volumes = [1_000_000.0 + (i % 17) * 1000 for i in range(len(index))]
        frame = pd.DataFrame(
            {
                "open": opens,
                "high": highs,
                "low": lows,
                "close": closes,
                "volume": volumes,
            },
            index=index,
        )
        return BarSeries(ticker=ticker, timeframe=timeframe, frame=frame)


class YFinanceBarFetcher:
    """Live OHLCV fetcher over yfinance.

    Keeps the dependency hidden behind the BarFetcher protocol so tests
    and the backtest harness don't need network access. yfinance is
    imported lazily so importing this module doesn't trigger a heavy
    import chain.
    """

    def fetch(
        self,
        ticker: str,
        start: datetime,
        end: datetime,
        timeframe: Timeframe = "1d",
    ) -> BarSeries:
        import yfinance as yf

        start_utc = _to_utc(start)
        end_utc = _to_utc(end)
        raw = yf.download(
            tickers=ticker,
            start=start_utc.strftime("%Y-%m-%d"),
            end=end_utc.strftime("%Y-%m-%d"),
            interval=timeframe,
            auto_adjust=True,
            progress=False,
            threads=False,
        )
        if raw is None or raw.empty:
            raise ValueError(f"yfinance returned no data for {ticker}")
        # yfinance returns a MultiIndex when tickers is a list; flatten
        # defensively even for a single ticker.
        if isinstance(raw.columns, pd.MultiIndex):
            raw.columns = [c[0] for c in raw.columns]
        frame = raw.rename(
            columns={
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
                "Volume": "volume",
            }
        )[list(OHLCV_COLUMNS)]
        if frame.index.tz is None:
            frame.index = frame.index.tz_localize(timezone.utc)
        else:
            frame.index = frame.index.tz_convert(timezone.utc)
        frame = frame.sort_index()
        frame = frame[~frame.index.duplicated(keep="last")]
        return BarSeries(ticker=ticker, timeframe=timeframe, frame=frame)


def fetch_panel(
    fetcher: BarFetcher,
    tickers: Sequence[str],
    start: datetime,
    end: datetime,
    timeframe: Timeframe = "1d",
) -> dict[str, BarSeries]:
    """Bulk-fetch a panel of BarSeries, one per ticker.

    Returns a dict ticker -> BarSeries. Tickers that fail to fetch are
    omitted; callers decide whether to fail or proceed on partial data.
    """

    out: dict[str, BarSeries] = {}
    for ticker in tickers:
        try:
            out[ticker] = fetcher.fetch(ticker, start, end, timeframe)
        except Exception:  # noqa: BLE001 — best-effort panel build
            continue
    return out


def align_panel(panel: Mapping[str, BarSeries]) -> pd.DataFrame:
    """Inner-join close prices across a panel into a wide frame.

    Index = common timestamps. Columns = tickers. Used by cross-sectional
    strategies that need the same date for every name.
    """

    if not panel:
        return pd.DataFrame()
    closes = pd.concat(
        {ticker: series.closes for ticker, series in panel.items()},
        axis=1,
        join="inner",
    )
    closes.columns = list(panel.keys())
    return closes


def _to_utc(value: datetime | date) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)


def _seed_from_ticker(ticker: str) -> int:
    seed = 1469598103934665603  # FNV-1a offset basis fits 64-bit
    for ch in ticker.upper():
        seed ^= ord(ch)
        seed = (seed * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return seed & 0xFFFFFFFF


__all__ = [
    "Bar",
    "BarFetcher",
    "BarSeries",
    "OHLCV_COLUMNS",
    "StubBarFetcher",
    "Timeframe",
    "YFinanceBarFetcher",
    "align_panel",
    "fetch_panel",
]
