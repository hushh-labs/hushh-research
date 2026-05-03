"""Inverse-volatility allocator across child strategies.

Combines multiple child SignalSeries by weighting each child by its
inverse trailing realized vol over the panel. Output is a single
SignalSeries whose weights are a convex combination of the children.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import pandas as pd

from ..data import align_panel
from .base import SignalSeries, Strategy, StrategyContext


@dataclass(frozen=True)
class InverseVolAllocator:
    name: str
    children: Sequence[Strategy]
    vol_window: int = 60

    def signals(self, ctx: StrategyContext) -> SignalSeries:
        if not self.children:
            return SignalSeries(weights=pd.DataFrame())
        child_signals = [c.signals(ctx) for c in self.children]
        closes = align_panel(ctx.panel)
        if closes.empty:
            return child_signals[0]
        returns = closes.pct_change().fillna(0.0)

        # Per-child realized portfolio vol from prior weights * returns.
        vols: list[pd.Series] = []
        for sig in child_signals:
            w = sig.weights.reindex(returns.index, method="ffill").fillna(0.0)
            shifted = w.shift(1).fillna(0.0)
            port_ret = (shifted * returns).sum(axis=1)
            vol = port_ret.rolling(self.vol_window).std().bfill().fillna(1e-6)
            vols.append(vol.replace(0.0, 1e-6))

        # Combine.
        combined = pd.DataFrame(0.0, index=returns.index, columns=returns.columns)
        for sig, vol in zip(child_signals, vols, strict=True):
            inv = 1.0 / vol
            w = sig.weights.reindex(returns.index, method="ffill").fillna(0.0)
            combined = combined.add(w.mul(inv, axis=0), fill_value=0.0)

        # Normalize so each row's gross matches the average of children's gross.
        target_gross = pd.concat(
            [s.weights.abs().sum(axis=1) for s in child_signals], axis=1
        ).reindex(returns.index, method="ffill").fillna(0.0).mean(axis=1)
        actual_gross = combined.abs().sum(axis=1).replace(0.0, pd.NA)
        ratio = (target_gross / actual_gross).fillna(0.0)
        combined = combined.mul(ratio, axis=0).fillna(0.0)
        return SignalSeries(weights=combined)


__all__ = ["InverseVolAllocator"]
