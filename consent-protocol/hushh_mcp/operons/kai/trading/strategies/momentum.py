"""Cross-sectional momentum (12-1 by default).

For each rebalance date, rank names by trailing total return excluding
the most recent month, then go long the top tercile and short the
bottom tercile (or long-only if `long_only=True`). Equal-weight inside
each leg.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ..data import align_panel
from .base import SignalSeries, StrategyContext


@dataclass(frozen=True)
class CrossSectionalMomentum:
    name: str = "xs_momentum_12_1"
    lookback_days: int = 252
    skip_days: int = 21
    rebalance: str = "ME"  # month-end
    long_only: bool = True
    long_pct: float = 0.34
    short_pct: float = 0.34

    def signals(self, ctx: StrategyContext) -> SignalSeries:
        closes = align_panel(ctx.panel)
        if ctx.as_of is not None:
            closes = closes.loc[: ctx.as_of]
        if closes.empty or len(closes.columns) < 3:
            return SignalSeries(weights=closes.iloc[0:0])

        rebalance_dates = closes.resample(self.rebalance).last().index
        weights = pd.DataFrame(
            0.0,
            index=rebalance_dates,
            columns=closes.columns,
        )
        for ts in rebalance_dates:
            window = closes.loc[:ts]
            if len(window) < self.lookback_days + self.skip_days:
                continue
            past = window.iloc[-(self.lookback_days + self.skip_days)]
            recent = window.iloc[-self.skip_days]
            ret = (recent / past) - 1.0
            ret = ret.dropna()
            if ret.empty:
                continue
            n = len(ret)
            n_long = max(1, int(n * self.long_pct))
            longs = ret.sort_values(ascending=False).head(n_long).index
            weights.loc[ts, longs] = 1.0 / n_long
            if not self.long_only:
                n_short = max(1, int(n * self.short_pct))
                shorts = ret.sort_values(ascending=True).head(n_short).index
                weights.loc[ts, shorts] = -1.0 / n_short

        return SignalSeries(weights=weights.reindex(closes.index, method="ffill").fillna(0.0))


__all__ = ["CrossSectionalMomentum"]
