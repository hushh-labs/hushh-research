"""In-process paper-trading session.

Runs a strategy against an evolving price panel, emits OrderIntents
through the approval flow, and auto-signs approvals only when the
session is configured `auto_approve=True`. The auto-approval path
exists for paper mode and tests; the live path always requires a
human-signed approval.

This is the same chokepoint the live trading service uses; swapping
broker + auto_approve produces a real-money path. Keeping one shape
for both ensures the audit-log entries match.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Mapping

import pandas as pd

from .data import BarSeries, align_panel
from .execution.approval_flow import ApprovalFlow
from .execution.broker_base import ExecutionBroker
from .execution.contracts import (
    BrokerConnection,
    ExecutionApproval,
    ExecutionOrder,
    ExecutionStatus,
    OrderIntent,
    OrderSide,
    OrderType,
    TimeInForce,
)
from .risk import RiskLimits, RiskState, evaluate_intent
from .strategies.base import Strategy, StrategyContext


@dataclass
class PositionBook:
    """Per-strategy position and cash book persisted to PKM in production.

    Keys: ticker -> shares. Float-shares are allowed for fractional
    brokers; integer accounting is the caller's responsibility.
    """

    cash: float
    positions: dict[str, float] = field(default_factory=dict)
    realized_pnl: float = 0.0

    def nav(self, prices: Mapping[str, float]) -> float:
        market = sum(qty * prices.get(ticker, 0.0) for ticker, qty in self.positions.items())
        return self.cash + market

    def apply_fill(self, order: ExecutionOrder, intent: OrderIntent) -> None:
        signed = intent.qty if intent.side == OrderSide.BUY else -intent.qty
        self.positions[intent.ticker] = self.positions.get(intent.ticker, 0.0) + signed
        if abs(self.positions[intent.ticker]) < 1e-9:
            del self.positions[intent.ticker]
        notional = signed * order.avg_fill_price
        fees = float(order.broker_payload.get("fees", 0.0))
        self.cash -= notional + fees


@dataclass
class PaperTradingSession:
    user_id: str
    strategy: Strategy
    broker: ExecutionBroker
    connection: BrokerConnection
    approval_flow: ApprovalFlow
    book: PositionBook
    auto_approve: bool = True
    consent_token: str = "HCT.paper.session"
    risk_limits: RiskLimits = field(default_factory=RiskLimits)
    sector_of: Mapping[str, str] = field(default_factory=dict)
    history: list[ExecutionOrder] = field(default_factory=list)

    def step(self, panel: Mapping[str, BarSeries], as_of: pd.Timestamp) -> list[ExecutionOrder]:
        """Drive one rebalance cycle: signals -> intents -> orders.

        Returns the list of orders produced this step (may be empty when
        target == current or every intent was risk-blocked).
        """

        signals = self.strategy.signals(StrategyContext(panel=panel, as_of=as_of))
        if signals.weights.empty:
            return []

        # Use the row at `as_of` (or the latest <= as_of).
        try:
            target_row = signals.weights.loc[: as_of].iloc[-1]
        except (IndexError, KeyError):
            return []
        prices = {
            ticker: float(series.frame.loc[: as_of].iloc[-1]["close"])
            for ticker, series in panel.items()
            if not series.frame.loc[: as_of].empty
        }
        if not prices:
            return []

        nav = self.book.nav(prices)
        if nav <= 0:
            return []

        # Convert target weights to target shares.
        target_shares: dict[str, float] = {}
        for ticker, weight in target_row.items():
            price = prices.get(ticker)
            if price is None or price <= 0:
                continue
            target_shares[ticker] = (float(weight) * nav) / price

        produced: list[ExecutionOrder] = []
        for ticker, target in target_shares.items():
            current = self.book.positions.get(ticker, 0.0)
            delta = target - current
            if abs(delta) < 1e-6:
                continue
            order = self._submit_one(ticker=ticker, qty_delta=delta, price=prices[ticker], nav=nav)
            if order is not None:
                produced.append(order)
        # Close out positions that fell out of the target set.
        for ticker, current in list(self.book.positions.items()):
            if ticker in target_shares or abs(current) < 1e-9:
                continue
            order = self._submit_one(
                ticker=ticker,
                qty_delta=-current,
                price=prices.get(ticker, 0.0),
                nav=nav,
            )
            if order is not None:
                produced.append(order)
        self.history.extend(produced)
        return produced

    # ------------------------------------------------------------------

    def _submit_one(
        self,
        *,
        ticker: str,
        qty_delta: float,
        price: float,
        nav: float,
    ) -> ExecutionOrder | None:
        if price <= 0 or abs(qty_delta) < 1e-6:
            return None
        side = OrderSide.BUY if qty_delta > 0 else OrderSide.SELL
        intent = OrderIntent(
            intent_id=OrderIntent.new_id(),
            user_id=self.user_id,
            strategy_id=self.strategy.name,
            ticker=ticker,
            side=side,
            qty=abs(qty_delta),
            order_type=OrderType.MARKET,
            time_in_force=TimeInForce.DAY,
        )
        risk_state = self._snapshot_risk_state(price=price, nav=nav)
        decision = evaluate_intent(intent, risk_state, self.risk_limits, estimated_price=price)
        if not decision.allowed:
            self.approval_flow.audit.append(
                user_id=self.user_id,
                event_type="intent_blocked_by_risk",
                payload={
                    "intent_id": intent.intent_id,
                    "ticker": ticker,
                    "breaches": list(decision.breaches),
                    "reason": decision.reason,
                },
            )
            return None

        try:
            self.approval_flow.emit_intent(intent, self.broker, self.connection)
        except Exception:  # noqa: BLE001 — kill switch, etc. Auditor already records.
            return None

        if not self.auto_approve:
            # Live path leaves the intent pending for a human to sign.
            return None

        approval = ExecutionApproval(
            intent_id=intent.intent_id,
            user_id=self.user_id,
            consent_token=self.consent_token,
            approved_at_ms=int(time.time() * 1000),
            signature="auto.paper",
        )
        try:
            order = self.approval_flow.submit_approved(approval, self.broker, self.connection)
        except Exception:  # noqa: BLE001
            return None
        if order.status in {ExecutionStatus.FILLED, ExecutionStatus.PARTIALLY_FILLED}:
            self.book.apply_fill(order, intent)
        return order

    def _snapshot_risk_state(self, *, price: float, nav: float) -> RiskState:
        positions_notional = {
            ticker: qty * price if ticker == ticker else qty * price  # placeholder per-ticker pricing
            for ticker, qty in self.book.positions.items()
        }
        return RiskState(
            nav=nav,
            cash=self.book.cash,
            day_pnl=0.0,
            rolling_drawdown_30d=0.0,
            daily_turnover_notional=0.0,
            positions_notional=positions_notional,
            sector_of=self.sector_of,
            last_quote_age_seconds=0.0,
        )


def run_session_over(
    session: PaperTradingSession,
    panel: Mapping[str, BarSeries],
    *,
    rebalance_index: pd.DatetimeIndex | None = None,
) -> list[ExecutionOrder]:
    """Drive a session through every timestamp in `rebalance_index`.

    Defaults to the union of all bar timestamps in `panel`. Useful for
    end-to-end tests and offline replays.
    """

    closes = align_panel(panel)
    if closes.empty:
        return []
    idx = rebalance_index if rebalance_index is not None else closes.index
    out: list[ExecutionOrder] = []
    for ts in idx:
        out.extend(session.step(panel, ts))
    return out


__all__ = ["PaperTradingSession", "PositionBook", "run_session_over"]
