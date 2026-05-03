"""Position sizing primitives.

Operates on raw `SignalSeries` weights from strategies and applies:

- Vol targeting: scale gross to hit a target annualized portfolio vol.
- Kelly cap: cap any single name's weight at a fraction of the
  full-Kelly bet implied by its mean / variance.
- Per-name and sector caps.

All functions are pure: they take a weights DataFrame plus a returns
DataFrame and return a new weights DataFrame. The risk module composes
these with the kill-switch / circuit-breaker pre-trade checks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import pandas as pd


@dataclass(frozen=True)
class SizingConfig:
    target_annual_vol: float = 0.15
    trading_days_per_year: int = 252
    kelly_fraction: float = 0.25
    per_name_cap: float = 0.05
    sector_cap: float = 0.25


def vol_target(
    weights: pd.DataFrame,
    returns: pd.DataFrame,
    config: SizingConfig,
    *,
    vol_window: int = 60,
) -> pd.DataFrame:
    """Scale row gross so realized portfolio vol matches target."""

    aligned = weights.reindex(returns.index, method="ffill").fillna(0.0)
    shifted = aligned.shift(1).fillna(0.0)
    port_ret = (shifted * returns).sum(axis=1)
    realized = port_ret.rolling(vol_window).std().bfill().fillna(0.0)
    annual = realized * (config.trading_days_per_year**0.5)
    scale = (config.target_annual_vol / annual.replace(0.0, pd.NA)).fillna(1.0)
    scale = scale.clip(upper=3.0)  # avoid pathological leverage explosions
    return aligned.mul(scale, axis=0).fillna(0.0)


def kelly_cap(
    weights: pd.DataFrame,
    returns: pd.DataFrame,
    config: SizingConfig,
    *,
    window: int = 60,
) -> pd.DataFrame:
    """Cap each name to a fractional-Kelly bet computed on rolling stats."""

    mean = returns.rolling(window).mean()
    var = returns.rolling(window).var().replace(0.0, pd.NA)
    full_kelly = (mean / var).fillna(0.0)
    cap = (full_kelly.abs() * config.kelly_fraction).clip(lower=0.0, upper=1.0)
    cap = cap.reindex(weights.index, method="ffill").fillna(0.0)
    capped = weights.copy()
    for col in capped.columns:
        col_cap = cap[col].reindex(capped.index, method="ffill").fillna(0.0)
        sign = capped[col].apply(_sign)
        capped[col] = sign * pd.concat([capped[col].abs(), col_cap], axis=1).min(axis=1)
    return capped


def per_name_cap(weights: pd.DataFrame, config: SizingConfig) -> pd.DataFrame:
    """Hard cap per-ticker weight at config.per_name_cap (preserves sign)."""

    return weights.clip(lower=-config.per_name_cap, upper=config.per_name_cap)


def sector_cap(
    weights: pd.DataFrame,
    sectors: Mapping[str, str],
    config: SizingConfig,
) -> pd.DataFrame:
    """Cap absolute exposure per sector at config.sector_cap.

    `sectors` maps ticker -> sector. Tickers not present default to a
    `_unknown_` sector.
    """

    if weights.empty:
        return weights
    sector_of = {ticker: sectors.get(ticker, "_unknown_") for ticker in weights.columns}
    out = weights.copy()
    for sector in set(sector_of.values()):
        cols = [t for t, s in sector_of.items() if s == sector]
        if not cols:
            continue
        gross = out[cols].abs().sum(axis=1)
        ratio = (config.sector_cap / gross.replace(0.0, pd.NA)).fillna(1.0).clip(upper=1.0)
        out[cols] = out[cols].mul(ratio, axis=0)
    return out


def _sign(x: float) -> float:
    if x > 0:
        return 1.0
    if x < 0:
        return -1.0
    return 0.0


__all__ = [
    "SizingConfig",
    "kelly_cap",
    "per_name_cap",
    "sector_cap",
    "vol_target",
]
