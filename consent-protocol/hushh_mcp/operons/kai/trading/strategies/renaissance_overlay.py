"""Renaissance-tier conviction overlay.

Multiplies a base strategy's weights by tier weights from the
Renaissance Investable Universe (ACE 1.0, KING 0.8, QUEEN 0.6,
JACK 0.4, default 0.0). Names not in the universe drop to zero.

The overlay never increases gross exposure; it only attenuates and
re-allocates within the original sign of each weight. Sizing layers
downstream renormalize.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import pandas as pd

from .base import SignalSeries, Strategy, StrategyContext


@dataclass(frozen=True)
class RenaissanceOverlay:
    name: str
    base: Strategy
    tier_weights: Mapping[str, float]

    def signals(self, ctx: StrategyContext) -> SignalSeries:
        base_signals = self.base.signals(ctx)
        if base_signals.weights.empty:
            return base_signals
        scaled = base_signals.weights.copy()
        for ticker in scaled.columns:
            scaled[ticker] = scaled[ticker] * float(self.tier_weights.get(ticker, 0.0))
        # Renormalize each row so |weights|.sum() matches the original gross.
        original_gross = base_signals.weights.abs().sum(axis=1).replace(0.0, pd.NA)
        scaled_gross = scaled.abs().sum(axis=1).replace(0.0, pd.NA)
        ratio = (original_gross / scaled_gross).fillna(0.0)
        scaled = scaled.mul(ratio, axis=0).fillna(0.0)
        return SignalSeries(weights=scaled)


__all__ = ["RenaissanceOverlay"]
