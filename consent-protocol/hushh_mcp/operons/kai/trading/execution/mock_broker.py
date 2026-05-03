"""In-process MockExecutionBroker.

Used by tests, paper trading, and the kill-switch `paper` mode. Mirrors
the Alpaca Trading API surface that the real adapter will implement,
so swapping in the live adapter is a configuration change, not a code
change at the call site.

Fills are simulated at the supplied "current price" (carried via
`OrderPreview.estimated_price` for previews and a per-broker price hook
for submits). Idempotency is enforced by client-order-id deduplication.
"""

from __future__ import annotations

import time
import uuid
from typing import Callable

from .broker_base import ExecutionBroker
from .contracts import (
    BrokerConnection,
    ExecutionAccount,
    ExecutionApproval,
    ExecutionOrder,
    ExecutionStatus,
    OrderIntent,
    OrderPreview,
    OrderSide,
)


PriceSource = Callable[[str], float]


def _default_price_source(ticker: str) -> float:
    """Fallback price for tests when no price source is wired."""
    return 100.0


class MockExecutionBroker(ExecutionBroker):
    broker_id = "mock"
    paper = True

    def __init__(
        self,
        *,
        price_source: PriceSource | None = None,
        starting_cash: float = 100_000.0,
        starting_equity: float = 100_000.0,
        commission_per_share: float = 0.0,
        fee_rate_bps: float = 1.0,
    ) -> None:
        self._price = price_source or _default_price_source
        self._cash = starting_cash
        self._equity = starting_equity
        self._commission = commission_per_share
        self._fee_rate_bps = fee_rate_bps
        self._orders: dict[str, ExecutionOrder] = {}
        self._submitted_keys: set[str] = set()  # idempotency

    def get_account(self, connection: BrokerConnection) -> ExecutionAccount:
        return ExecutionAccount(
            broker_id=self.broker_id,
            account_id=f"mock_{connection.user_id}",
            user_id=connection.user_id,
            cash=self._cash,
            equity=self._equity,
            buying_power=self._cash,
            paper=True,
        )

    def preview(
        self,
        intent: OrderIntent,
        connection: BrokerConnection,
    ) -> OrderPreview:
        price = intent.limit_price or self._price(intent.ticker)
        notional = abs(intent.qty) * price
        fees = notional * (self._fee_rate_bps / 10_000.0) + abs(intent.qty) * self._commission
        portfolio_impact = (notional / self._equity) if self._equity else 0.0
        warnings: list[str] = []
        if portfolio_impact > 0.10:
            warnings.append("order > 10% of portfolio NAV")
        if intent.side == OrderSide.BUY and notional + fees > self._cash:
            warnings.append("insufficient buying power")
        return OrderPreview(
            intent=intent,
            estimated_price=price,
            estimated_fees=fees,
            estimated_notional=notional,
            portfolio_impact_pct=portfolio_impact,
            risk_headroom_pct=max(0.0, 1.0 - portfolio_impact),
            risk_warnings=tuple(warnings),
            expires_at_ms=int(time.time() * 1000) + 60_000,
        )

    def submit(
        self,
        intent: OrderIntent,
        approval: ExecutionApproval,
        connection: BrokerConnection,
    ) -> ExecutionOrder:
        self.assert_approval_matches(intent, approval)

        # Idempotency: same idempotency_key = same order, no re-submit.
        if intent.idempotency_key in self._submitted_keys:
            for order in self._orders.values():
                if order.intent_id == intent.intent_id:
                    return order

        price = intent.limit_price or self._price(intent.ticker)
        signed_qty = intent.qty if intent.side == OrderSide.BUY else -intent.qty
        notional = abs(intent.qty) * price
        fees = notional * (self._fee_rate_bps / 10_000.0) + abs(intent.qty) * self._commission

        # Update mock account: cash flows on fill, equity stays in nominal terms.
        self._cash -= signed_qty * price + fees

        now_ms = int(time.time() * 1000)
        order = ExecutionOrder(
            order_id=f"mock_{uuid.uuid4().hex[:12]}",
            intent_id=intent.intent_id,
            broker_id=self.broker_id,
            account_id=f"mock_{connection.user_id}",
            status=ExecutionStatus.FILLED,
            submitted_at_ms=now_ms,
            filled_qty=intent.qty,
            avg_fill_price=price,
            last_status_at_ms=now_ms,
            broker_payload={
                "fees": fees,
                "client_order_id": intent.idempotency_key,
            },
        )
        self._orders[order.order_id] = order
        self._submitted_keys.add(intent.idempotency_key)
        return order

    def status(
        self,
        order: ExecutionOrder,
        connection: BrokerConnection,
    ) -> ExecutionOrder:
        return self._orders.get(order.order_id, order)

    def cancel(
        self,
        order: ExecutionOrder,
        connection: BrokerConnection,
    ) -> ExecutionOrder:
        existing = self._orders.get(order.order_id)
        if existing is None:
            return order
        if existing.status in self.terminal_statuses():
            return existing
        cancelled = ExecutionOrder(
            order_id=existing.order_id,
            intent_id=existing.intent_id,
            broker_id=existing.broker_id,
            account_id=existing.account_id,
            status=ExecutionStatus.CANCELLED,
            submitted_at_ms=existing.submitted_at_ms,
            filled_qty=existing.filled_qty,
            avg_fill_price=existing.avg_fill_price,
            last_status_at_ms=int(time.time() * 1000),
            broker_payload=existing.broker_payload,
        )
        self._orders[existing.order_id] = cancelled
        return cancelled

    def list_open_orders(self, connection: BrokerConnection):
        terminal = self.terminal_statuses()
        return [o for o in self._orders.values() if o.status not in terminal]


__all__ = ["MockExecutionBroker", "PriceSource"]
