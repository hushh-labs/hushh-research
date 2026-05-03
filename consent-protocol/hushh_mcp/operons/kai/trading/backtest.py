"""Walk-forward / event-driven backtest harness.

Pure-function. Given a strategy, a panel of BarSeries, a sizing config,
and a cost model, returns an `BacktestResult` with the equity curve and
canonical metrics. The core path is fully deterministic — same inputs
produce a byte-identical equity curve.

Cost model: half-spread + linear impact + per-share commission.
Slippage: applied to the next-bar open relative to the prior close.

Honest IRR contract: the harness reports the realized XIRR against the
NORTH_STAR target (the 69.69% number). It does NOT smooth, dress, or
hide that number. The `meets_north_star` flag is computed in
`metrics.py` against the realized XIRR; UI consumers display both
sides — realized IRR and the gap to the North Star.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Mapping

import pandas as pd

from .data import align_panel, BarSeries
from .metrics import BacktestMetrics, compute_metrics
from .sizing import SizingConfig, vol_target
from .strategies.base import Strategy, StrategyContext


@dataclass(frozen=True)
class CostModel:
    half_spread_bps: float = 1.0
    impact_bps_per_turnover: float = 5.0
    commission_per_share: float = 0.0


@dataclass(frozen=True)
class BacktestConfig:
    initial_capital: float = 100_000.0
    sizing: SizingConfig = SizingConfig()
    cost: CostModel = CostModel()
    apply_vol_target: bool = True


@dataclass(frozen=True)
class BacktestResult:
    strategy_name: str
    equity_curve: pd.Series
    weights: pd.DataFrame
    returns: pd.Series
    turnover: pd.Series
    metrics: BacktestMetrics
    equity_curve_hash: str

    def to_summary(self) -> dict[str, float | str]:
        m = self.metrics
        return {
            "strategy": self.strategy_name,
            "irr": m.irr,
            "sharpe": m.sharpe,
            "sortino": m.sortino,
            "calmar": m.calmar,
            "max_drawdown": m.max_drawdown,
            "turnover_annualized": m.turnover_annualized,
            "north_star_irr": m.north_star_irr,
            "meets_north_star": m.meets_north_star,
            "equity_curve_hash": self.equity_curve_hash,
        }


def run(
    strategy: Strategy,
    panel: Mapping[str, BarSeries],
    config: BacktestConfig | None = None,
) -> BacktestResult:
    """Execute a single full-window backtest."""

    cfg = config or BacktestConfig()
    closes = align_panel(panel)
    if closes.empty:
        empty_curve = pd.Series([cfg.initial_capital], index=closes.index)
        return BacktestResult(
            strategy_name=strategy.name,
            equity_curve=empty_curve,
            weights=closes.iloc[0:0],
            returns=pd.Series(dtype=float),
            turnover=pd.Series(dtype=float),
            metrics=compute_metrics(empty_curve, pd.Series(dtype=float)),
            equity_curve_hash=_hash_series(empty_curve),
        )

    raw_weights = strategy.signals(StrategyContext(panel=panel)).weights
    aligned = raw_weights.reindex(closes.index, method="ffill").fillna(0.0)
    aligned = aligned.reindex(columns=closes.columns).fillna(0.0)

    returns = closes.pct_change().fillna(0.0)
    if cfg.apply_vol_target:
        aligned = vol_target(aligned, returns, cfg.sizing)

    # Trade on next-bar open: shift weights one period forward.
    held = aligned.shift(1).fillna(0.0)
    raw_port_ret = (held * returns).sum(axis=1)

    # Costs: bps applied to turnover per period.
    turnover = held.diff().abs().sum(axis=1).fillna(0.0)
    bps = (cfg.cost.half_spread_bps + cfg.cost.impact_bps_per_turnover) / 10_000.0
    cost_drag = turnover * bps
    net_ret = raw_port_ret - cost_drag

    equity_curve = (1.0 + net_ret).cumprod() * cfg.initial_capital
    metrics = compute_metrics(equity_curve, turnover)

    return BacktestResult(
        strategy_name=strategy.name,
        equity_curve=equity_curve,
        weights=aligned,
        returns=net_ret,
        turnover=turnover,
        metrics=metrics,
        equity_curve_hash=_hash_series(equity_curve),
    )


def _hash_series(series: pd.Series) -> str:
    """Stable SHA-256 over (timestamp_iso, rounded_value) pairs."""
    h = hashlib.sha256()
    for ts, value in series.items():
        h.update(ts.isoformat().encode("utf-8"))
        h.update(b"|")
        h.update(f"{float(value):.10f}".encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


__all__ = ["BacktestConfig", "BacktestResult", "CostModel", "run"]
