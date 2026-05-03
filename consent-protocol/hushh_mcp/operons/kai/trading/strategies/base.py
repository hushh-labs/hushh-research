"""Strategy contracts.

A `Strategy` is a stateless callable that, given a price panel and
optional risk context, returns target portfolio weights per ticker per
timestamp. The backtest harness and paper-trading loop both consume
this protocol.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol

import pandas as pd

from ..data import BarSeries


@dataclass(frozen=True)
class Signal:
    """A target weight for a single ticker at a single timestamp."""

    ticker: str
    weight: float
    confidence: float = 1.0


@dataclass(frozen=True)
class SignalSeries:
    """Wide DataFrame of target weights.

    Index = timestamps (tz-aware UTC). Columns = tickers. Values =
    target weights in [-1, 1] (negative for short). Rows must sum to
    `gross_target` after risk shaping; the strategy itself only needs
    to produce relative weights — sizing layers normalize later.
    """

    weights: pd.DataFrame

    def __post_init__(self) -> None:
        if not isinstance(self.weights.index, pd.DatetimeIndex):
            raise ValueError("SignalSeries index must be DatetimeIndex")
        if self.weights.index.tz is None:
            raise ValueError("SignalSeries index must be tz-aware (UTC)")


@dataclass(frozen=True)
class StrategyContext:
    """Inputs every strategy receives.

    - `panel`: ticker -> BarSeries
    - `as_of`: optional date cutoff used by walk-forward folds; data
      strictly after this point is hidden from the strategy.
    """

    panel: Mapping[str, BarSeries]
    as_of: pd.Timestamp | None = None


class Strategy(Protocol):
    """Stateless strategy protocol."""

    name: str

    def signals(self, ctx: StrategyContext) -> SignalSeries: ...


__all__ = ["Signal", "SignalSeries", "Strategy", "StrategyContext"]
