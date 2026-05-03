"""Donchian-channel breakout / trend follower.

Long when close pierces the N-day high; flat (or short) when close
pierces the N-day low. Per-name independent — no cross-sectional
ranking — so it scales with the size of the panel via equal weights
across names that are currently long.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ..data import align_panel
from .base import SignalSeries, StrategyContext


@dataclass(frozen=True)
class DonchianBreakout:
    name: str = "donchian_breakout"
    entry_window: int = 55
    exit_window: int = 20
    long_only: bool = True

    def signals(self, ctx: StrategyContext) -> SignalSeries:
        closes = align_panel(ctx.panel)
        if ctx.as_of is not None:
            closes = closes.loc[: ctx.as_of]
        if closes.empty:
            return SignalSeries(weights=closes.iloc[0:0])

        highs = closes.shift(1).rolling(self.entry_window).max()
        lows = closes.shift(1).rolling(self.exit_window).min()

        position = pd.DataFrame(0.0, index=closes.index, columns=closes.columns)
        held = pd.Series(0.0, index=closes.columns)
        for ts in closes.index:
            for ticker in closes.columns:
                price = closes.at[ts, ticker]
                if pd.isna(price):
                    continue
                up = highs.at[ts, ticker]
                dn = lows.at[ts, ticker]
                if held[ticker] <= 0 and pd.notna(up) and price > up:
                    held[ticker] = 1.0
                elif held[ticker] > 0 and pd.notna(dn) and price < dn:
                    held[ticker] = 0.0 if self.long_only else -1.0
            active = held[held != 0.0]
            if not active.empty:
                w = 1.0 / len(active)
                for ticker in active.index:
                    position.at[ts, ticker] = w * active[ticker]

        return SignalSeries(weights=position)


__all__ = ["DonchianBreakout"]
