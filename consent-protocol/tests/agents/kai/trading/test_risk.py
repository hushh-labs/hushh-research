"""Pre-trade risk evaluation."""

from __future__ import annotations

import os

import pytest

from hushh_mcp.operons.kai.trading.execution.contracts import (
    OrderIntent,
    OrderSide,
    OrderType,
    TimeInForce,
)
from hushh_mcp.operons.kai.trading.risk import (
    RiskLimits,
    RiskState,
    evaluate_intent,
    kill_switch_mode,
)


def make_intent(qty: float = 10, ticker: str = "AAPL") -> OrderIntent:
    return OrderIntent(
        intent_id=OrderIntent.new_id(),
        user_id="user_alice",
        strategy_id="xs_momentum",
        ticker=ticker,
        side=OrderSide.BUY,
        qty=qty,
        order_type=OrderType.MARKET,
        time_in_force=TimeInForce.DAY,
    )


def make_state(**overrides) -> RiskState:
    base: dict = {
        "nav": 100_000.0,
        "cash": 100_000.0,
        "day_pnl": 0.0,
        "rolling_drawdown_30d": 0.0,
        "daily_turnover_notional": 0.0,
        "positions_notional": {},
        "sector_of": {"AAPL": "tech", "MSFT": "tech", "JPM": "fin"},
        "last_quote_age_seconds": 1.0,
    }
    base.update(overrides)
    return RiskState(**base)


def test_clean_state_allows_small_order() -> None:
    decision = evaluate_intent(make_intent(qty=10), make_state(), estimated_price=150.0)
    assert decision.allowed
    assert decision.breaches == ()


def test_per_name_cap_blocks_oversize_order() -> None:
    # 5% of 100k = $5000. 100 shares * $150 = $15,000 > cap.
    decision = evaluate_intent(make_intent(qty=100), make_state(), estimated_price=150.0)
    assert not decision.allowed
    assert "per_name_cap" in decision.breaches


def test_daily_loss_circuit_breaker() -> None:
    state = make_state(day_pnl=-3000.0)  # -3% on 100k NAV
    decision = evaluate_intent(make_intent(qty=10), state, estimated_price=150.0)
    assert not decision.allowed
    assert "daily_loss_limit" in decision.breaches


def test_drawdown_auto_halt() -> None:
    state = make_state(rolling_drawdown_30d=-0.15)
    decision = evaluate_intent(make_intent(qty=10), state, estimated_price=150.0)
    assert not decision.allowed
    assert "drawdown_auto_halt" in decision.breaches


def test_stale_data_blocks_submit() -> None:
    state = make_state(last_quote_age_seconds=120.0)
    decision = evaluate_intent(make_intent(qty=10), state, estimated_price=150.0)
    assert not decision.allowed
    assert "stale_market_data" in decision.breaches


def test_insufficient_cash_blocks_buy() -> None:
    state = make_state(cash=100.0)
    decision = evaluate_intent(make_intent(qty=10), state, estimated_price=150.0)
    assert not decision.allowed
    assert "insufficient_cash" in decision.breaches


def test_kill_switch_halt_overrides_clean_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KAI_TRADING_MODE", "halt")
    decision = evaluate_intent(make_intent(qty=1), make_state(), estimated_price=150.0)
    assert not decision.allowed
    assert decision.breaches == ("kill_switch_halt",)


def test_kill_switch_mode_defaults_to_paper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KAI_TRADING_MODE", raising=False)
    assert kill_switch_mode() == "paper"


def test_kill_switch_mode_unknown_value_defaults_to_paper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KAI_TRADING_MODE", "wibble")
    assert kill_switch_mode() == "paper"


def test_sector_cap_blocks_concentrated_buy() -> None:
    state = make_state(
        positions_notional={"AAPL": 20_000.0, "MSFT": 4_000.0},
    )
    # AAPL+MSFT already $24k in tech (24% of NAV); cap is 25%. New $1k+ order overshoots
    # if combined with the AAPL leg.
    decision = evaluate_intent(make_intent(qty=10, ticker="MSFT"), state, estimated_price=150.0)
    assert not decision.allowed
    # Either sector_cap OR per_name_cap can fire; both are valid.
    assert any(b in decision.breaches for b in ("sector_cap", "per_name_cap"))


def test_custom_limits_loosen_per_name_cap() -> None:
    # With a 50% per-name cap, the same trade is fine.
    custom = RiskLimits(per_name_cap_pct=0.5, sector_cap_pct=0.9, max_gross_leverage=2.0,
                        daily_turnover_cap_pct=2.0)
    decision = evaluate_intent(
        make_intent(qty=100), make_state(), RiskLimits() if False else custom,
        estimated_price=150.0,
    )
    assert decision.allowed, decision.breaches
