"""Performance metrics with honest IRR reporting.

The 69.69% North Star lives here as `NORTH_STAR_IRR`. Every metrics
report carries the realized IRR and the gap to that target. Display
layers (UI, MCP tool output, reports) read this single source of
truth — there is no second place where the target is hard-coded.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import pandas as pd

NORTH_STAR_IRR: float = 0.6969
RISK_FREE_RATE: float = 0.04
TRADING_DAYS_PER_YEAR: int = 252


@dataclass(frozen=True)
class BacktestMetrics:
    irr: float
    sharpe: float
    sortino: float
    calmar: float
    max_drawdown: float
    turnover_annualized: float
    north_star_irr: float
    meets_north_star: bool
    days: int


def compute_metrics(equity_curve: pd.Series, turnover: pd.Series) -> BacktestMetrics:
    if equity_curve.empty or len(equity_curve) < 2:
        return BacktestMetrics(
            irr=0.0,
            sharpe=0.0,
            sortino=0.0,
            calmar=0.0,
            max_drawdown=0.0,
            turnover_annualized=0.0,
            north_star_irr=NORTH_STAR_IRR,
            meets_north_star=False,
            days=0,
        )

    start_val = float(equity_curve.iloc[0])
    end_val = float(equity_curve.iloc[-1])
    span_days = max(1, (equity_curve.index[-1] - equity_curve.index[0]).days)
    years = span_days / 365.25

    irr = _irr(start_val, end_val, years)
    rets = equity_curve.pct_change().dropna()
    sharpe = _annualized_sharpe(rets)
    sortino = _annualized_sortino(rets)
    mdd = _max_drawdown(equity_curve)
    calmar = irr / abs(mdd) if mdd < 0 else 0.0
    turnover_annualized = float(turnover.sum()) / max(years, 1e-9)

    return BacktestMetrics(
        irr=irr,
        sharpe=sharpe,
        sortino=sortino,
        calmar=calmar,
        max_drawdown=mdd,
        turnover_annualized=turnover_annualized,
        north_star_irr=NORTH_STAR_IRR,
        meets_north_star=irr >= NORTH_STAR_IRR,
        days=span_days,
    )


def _irr(start: float, end: float, years: float) -> float:
    """Annualized geometric return (CAGR)."""
    if start <= 0 or end <= 0 or years <= 0:
        return 0.0
    return (end / start) ** (1.0 / years) - 1.0


def _annualized_sharpe(returns: pd.Series) -> float:
    if returns.empty or returns.std() == 0:
        return 0.0
    excess = returns - (RISK_FREE_RATE / TRADING_DAYS_PER_YEAR)
    return float(excess.mean() / returns.std() * math.sqrt(TRADING_DAYS_PER_YEAR))


def _annualized_sortino(returns: pd.Series) -> float:
    if returns.empty:
        return 0.0
    downside = returns[returns < 0]
    if downside.empty or downside.std() == 0:
        return 0.0
    excess = returns.mean() - (RISK_FREE_RATE / TRADING_DAYS_PER_YEAR)
    return float(excess / downside.std() * math.sqrt(TRADING_DAYS_PER_YEAR))


def _max_drawdown(equity_curve: pd.Series) -> float:
    if equity_curve.empty:
        return 0.0
    running_max = equity_curve.cummax()
    drawdown = (equity_curve - running_max) / running_max
    return float(drawdown.min())


__all__ = [
    "BacktestMetrics",
    "NORTH_STAR_IRR",
    "RISK_FREE_RATE",
    "TRADING_DAYS_PER_YEAR",
    "compute_metrics",
]
