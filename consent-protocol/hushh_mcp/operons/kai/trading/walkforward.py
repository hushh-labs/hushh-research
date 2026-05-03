"""Walk-forward and purged k-fold cross validation.

Both functions slice a panel into train/test windows and run the
backtest on the OUT-of-sample window only. Results are pooled into a
single equity curve so the user can compare in-sample vs out-of-sample
performance honestly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

import pandas as pd

from .backtest import BacktestConfig, BacktestResult, run
from .data import BarSeries, align_panel
from .metrics import compute_metrics
from .strategies.base import Strategy


@dataclass(frozen=True)
class WalkForwardResult:
    folds: list[BacktestResult]
    pooled: BacktestResult


def walk_forward(
    strategy: Strategy,
    panel: Mapping[str, BarSeries],
    *,
    train_years: float = 2.0,
    test_years: float = 0.5,
    config: BacktestConfig | None = None,
) -> WalkForwardResult:
    """Sliding-window walk-forward CV.

    Each fold trains on `train_years` and tests on `test_years`,
    advancing by `test_years` per step. The train window does nothing
    today (strategies in the v1 library are stateless), but the
    structure leaves room for trainable strategies later.
    """

    cfg = config or BacktestConfig()
    closes = align_panel(panel)
    if closes.empty:
        empty = run(strategy, panel, cfg)
        return WalkForwardResult(folds=[], pooled=empty)

    bounds = list(_fold_bounds(closes.index, train_years, test_years))
    folds: list[BacktestResult] = []
    pooled_curve_pieces: list[pd.Series] = []
    last_value = cfg.initial_capital
    for train_end, test_end in bounds:
        sub_panel = _slice_panel(panel, end=test_end)
        result = run(strategy, sub_panel, cfg)
        # Restrict the fold's contribution to the test window only.
        oos = result.equity_curve.loc[(result.equity_curve.index > train_end)]
        if oos.empty:
            continue
        # Re-base each fold's curve onto the running pooled value.
        rebased = oos / oos.iloc[0] * last_value
        pooled_curve_pieces.append(rebased)
        last_value = float(rebased.iloc[-1])
        folds.append(result)

    if not pooled_curve_pieces:
        empty = run(strategy, panel, cfg)
        return WalkForwardResult(folds=[], pooled=empty)

    pooled_curve = pd.concat(pooled_curve_pieces).sort_index()
    pooled_metrics = compute_metrics(pooled_curve, pd.Series(dtype=float))
    pooled = BacktestResult(
        strategy_name=f"{strategy.name}__walkforward",
        equity_curve=pooled_curve,
        weights=pd.DataFrame(),
        returns=pooled_curve.pct_change().fillna(0.0),
        turnover=pd.Series(dtype=float),
        metrics=pooled_metrics,
        equity_curve_hash="",  # walk-forward composes folds, not deterministic by design
    )
    return WalkForwardResult(folds=folds, pooled=pooled)


def _fold_bounds(
    index: pd.DatetimeIndex,
    train_years: float,
    test_years: float,
) -> Iterable[tuple[pd.Timestamp, pd.Timestamp]]:
    if len(index) == 0:
        return
    start = index[0]
    end = index[-1]
    train_delta = pd.Timedelta(days=int(train_years * 365.25))
    test_delta = pd.Timedelta(days=int(test_years * 365.25))
    cursor = start + train_delta
    while cursor + test_delta <= end:
        yield cursor, cursor + test_delta
        cursor = cursor + test_delta


def _slice_panel(panel: Mapping[str, BarSeries], end: pd.Timestamp) -> dict[str, BarSeries]:
    out: dict[str, BarSeries] = {}
    for ticker, series in panel.items():
        clipped = series.frame.loc[: end]
        if clipped.empty:
            continue
        out[ticker] = BarSeries(ticker=ticker, timeframe=series.timeframe, frame=clipped)
    return out


__all__ = ["WalkForwardResult", "walk_forward"]
