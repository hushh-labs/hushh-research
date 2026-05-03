"""Z-score mean reversion.

Per-name rolling z-score of close vs an N-day mean. Long the bottom
tail (price below mean), short the top tail. Equal-weight across
active names per timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ..data import align_panel
from .base import SignalSeries, StrategyContext


@dataclass(frozen=True)
class ZScoreReversion:
    name: str = "zscore_reversion"
    window: int = 20
    entry_z: float = 1.5
    long_only: bool = True

    def signals(self, ctx: StrategyContext) -> SignalSeries:
        closes = align_panel(ctx.panel)
        if ctx.as_of is not None:
            closes = closes.loc[: ctx.as_of]
        if closes.empty:
            return SignalSeries(weights=closes.iloc[0:0])

        mean = closes.rolling(self.window).mean()
        std = closes.rolling(self.window).std().replace(0.0, pd.NA)
        z = (closes - mean) / std

        long_mask = z < -self.entry_z
        short_mask = z > self.entry_z

        weights = pd.DataFrame(0.0, index=closes.index, columns=closes.columns)
        for ts in closes.index:
            longs = long_mask.loc[ts][long_mask.loc[ts].fillna(False)].index
            shorts = short_mask.loc[ts][short_mask.loc[ts].fillna(False)].index
            n_long = len(longs)
            if n_long:
                weights.loc[ts, longs] = 1.0 / n_long
            if not self.long_only:
                n_short = len(shorts)
                if n_short:
                    weights.loc[ts, shorts] = -1.0 / n_short

        return SignalSeries(weights=weights)


__all__ = ["ZScoreReversion"]
