"""Backtest harness tests, including the determinism contract."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hushh_mcp.operons.kai.trading.backtest import (
    BacktestConfig,
    CostModel,
    run,
)
from hushh_mcp.operons.kai.trading.data import StubBarFetcher, fetch_panel
from hushh_mcp.operons.kai.trading.metrics import NORTH_STAR_IRR, compute_metrics
from hushh_mcp.operons.kai.trading.sizing import SizingConfig
from hushh_mcp.operons.kai.trading.strategies import CrossSectionalMomentum
from hushh_mcp.operons.kai.trading.walkforward import walk_forward


@pytest.fixture(scope="module")
def panel() -> dict:
    fetcher = StubBarFetcher()
    return fetch_panel(
        fetcher,
        ["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA", "TSLA", "JPM"],
        datetime(2020, 1, 1, tzinfo=timezone.utc),
        datetime(2023, 12, 31, tzinfo=timezone.utc),
    )


def test_determinism_same_seed_same_curve(panel) -> None:
    strat = CrossSectionalMomentum(long_only=True)
    cfg = BacktestConfig(
        sizing=SizingConfig(target_annual_vol=0.15),
        cost=CostModel(),
    )
    a = run(strat, panel, cfg)
    b = run(strat, panel, cfg)
    assert a.equity_curve_hash == b.equity_curve_hash
    assert a.equity_curve_hash != ""


def test_metrics_report_north_star(panel) -> None:
    strat = CrossSectionalMomentum(long_only=True)
    result = run(strat, panel)
    summary = result.to_summary()
    # The North Star is always reported, regardless of realized IRR.
    assert summary["north_star_irr"] == pytest.approx(NORTH_STAR_IRR)
    # meets_north_star is a strict numeric comparison, never tweaked.
    assert summary["meets_north_star"] == (summary["irr"] >= NORTH_STAR_IRR)


def test_equity_curve_starts_at_initial_capital(panel) -> None:
    strat = CrossSectionalMomentum(long_only=True)
    cfg = BacktestConfig(initial_capital=50_000.0)
    result = run(strat, panel, cfg)
    assert result.equity_curve.iloc[0] == pytest.approx(cfg.initial_capital, rel=1e-6)


def test_costs_reduce_returns(panel) -> None:
    strat = CrossSectionalMomentum(long_only=True)
    no_cost = run(strat, panel, BacktestConfig(cost=CostModel(half_spread_bps=0.0, impact_bps_per_turnover=0.0)))
    with_cost = run(strat, panel, BacktestConfig(cost=CostModel(half_spread_bps=10.0, impact_bps_per_turnover=20.0)))
    # Costs cannot increase ending equity.
    assert with_cost.equity_curve.iloc[-1] <= no_cost.equity_curve.iloc[-1] + 1e-6


def test_walk_forward_runs(panel) -> None:
    strat = CrossSectionalMomentum(long_only=True)
    wf = walk_forward(strat, panel, train_years=1.0, test_years=0.5)
    # Synthetic data with 4 years history -> at least 4 OOS folds.
    assert len(wf.folds) >= 4
    assert wf.pooled.equity_curve.iloc[0] > 0


def test_metrics_handles_empty_curve() -> None:
    import pandas as pd

    metrics = compute_metrics(pd.Series(dtype=float), pd.Series(dtype=float))
    assert metrics.irr == 0.0
    assert metrics.meets_north_star is False
