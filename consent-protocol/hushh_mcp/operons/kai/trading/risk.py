"""Pre-trade risk checks and kill-switch resolution.

`evaluate_intent` runs synchronously before any broker submit and
returns a `RiskDecision` with the breaches that apply. Callers fail
closed on any breach.

Default limits match `docs/reference/kai/kai-trading-system.md`. Each
limit is configurable per user but never silently relaxed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

from .execution.contracts import OrderIntent, OrderSide


@dataclass(frozen=True)
class RiskLimits:
    daily_loss_limit_pct: float = -0.02  # halt if NAV-day < -2%
    max_gross_leverage: float = 1.0
    max_net_leverage: float = 1.0
    per_name_cap_pct: float = 0.05
    sector_cap_pct: float = 0.25
    daily_turnover_cap_pct: float = 1.0
    drawdown_auto_halt_pct: float = -0.10  # rolling 30d
    stale_data_window_seconds: int = 60


@dataclass(frozen=True)
class RiskState:
    nav: float
    cash: float
    day_pnl: float
    rolling_drawdown_30d: float
    daily_turnover_notional: float
    positions_notional: Mapping[str, float]
    sector_of: Mapping[str, str]
    last_quote_age_seconds: float


@dataclass(frozen=True)
class RiskDecision:
    allowed: bool
    breaches: tuple[str, ...]
    reason: str = ""


def kill_switch_mode() -> str:
    """Read `KAI_TRADING_MODE` env var; default to 'paper'."""
    raw = os.getenv("KAI_TRADING_MODE", "paper").strip().lower()
    if raw not in {"paper", "live", "halt"}:
        return "paper"
    return raw


def evaluate_intent(
    intent: OrderIntent,
    state: RiskState,
    limits: RiskLimits | None = None,
    *,
    estimated_price: float,
) -> RiskDecision:
    """Return whether `intent` may proceed given current state + limits."""

    lim = limits or RiskLimits()
    breaches: list[str] = []

    mode = kill_switch_mode()
    if mode == "halt":
        return RiskDecision(allowed=False, breaches=("kill_switch_halt",), reason="KAI_TRADING_MODE=halt")

    # Stale-data guard.
    if state.last_quote_age_seconds > lim.stale_data_window_seconds:
        breaches.append("stale_market_data")

    # Daily loss circuit breaker.
    if state.nav > 0 and (state.day_pnl / state.nav) <= lim.daily_loss_limit_pct:
        breaches.append("daily_loss_limit")

    # Drawdown auto-halt.
    if state.rolling_drawdown_30d <= lim.drawdown_auto_halt_pct:
        breaches.append("drawdown_auto_halt")

    # Per-name cap (post-trade exposure).
    notional = abs(intent.qty) * estimated_price
    signed = notional if intent.side == OrderSide.BUY else -notional
    new_position = state.positions_notional.get(intent.ticker, 0.0) + signed
    if state.nav > 0 and abs(new_position) / state.nav > lim.per_name_cap_pct:
        breaches.append("per_name_cap")

    # Sector cap.
    sector = state.sector_of.get(intent.ticker, "_unknown_")
    sector_exposure = sum(
        abs(state.positions_notional.get(t, 0.0))
        for t, s in state.sector_of.items()
        if s == sector
    )
    sector_exposure += abs(signed)
    if state.nav > 0 and sector_exposure / state.nav > lim.sector_cap_pct:
        breaches.append("sector_cap")

    # Gross leverage.
    gross_after = sum(abs(v) for v in state.positions_notional.values()) + abs(signed)
    if state.nav > 0 and gross_after / state.nav > lim.max_gross_leverage:
        breaches.append("gross_leverage")

    # Daily turnover cap.
    new_turnover = state.daily_turnover_notional + notional
    if state.nav > 0 and new_turnover / state.nav > lim.daily_turnover_cap_pct:
        breaches.append("daily_turnover_cap")

    # Buying power.
    if intent.side == OrderSide.BUY and state.cash < notional:
        breaches.append("insufficient_cash")

    if breaches:
        return RiskDecision(
            allowed=False,
            breaches=tuple(breaches),
            reason="; ".join(breaches),
        )
    return RiskDecision(allowed=True, breaches=(), reason="")


__all__ = [
    "RiskDecision",
    "RiskLimits",
    "RiskState",
    "evaluate_intent",
    "kill_switch_mode",
]
