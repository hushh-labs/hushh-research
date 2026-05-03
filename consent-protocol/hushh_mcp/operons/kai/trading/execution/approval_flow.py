"""Per-order approval state machine.

The Trading specialist emits an `OrderIntent` and a freshly-computed
`OrderPreview`. The intent enters `PENDING_APPROVAL` until the user
signs and posts an `ExecutionApproval`. Only then can the broker base
accept the order for `submit`.

This module is the single chokepoint between strategy logic and a
broker; nothing else may bypass it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .audit import AuditLog
from .broker_base import (
    ApprovalRequiredError,
    ExecutionBroker,
    KillSwitchActiveError,
)
from .contracts import (
    BrokerConnection,
    ExecutionApproval,
    ExecutionOrder,
    ExecutionStatus,
    OrderIntent,
    OrderPreview,
)


@dataclass
class PendingApproval:
    intent: OrderIntent
    preview: OrderPreview
    expires_at_ms: int


@dataclass
class ApprovalFlow:
    """In-memory pending-approval queue keyed by intent_id.

    Production binds this to encrypted Postgres; the API surface stays
    identical so swapping storage is a service-wiring change.
    """

    audit: AuditLog
    kill_switch_mode: str = "paper"  # "paper" | "live" | "halt"
    pending: dict[str, PendingApproval] = field(default_factory=dict)

    def emit_intent(
        self,
        intent: OrderIntent,
        broker: ExecutionBroker,
        connection: BrokerConnection,
    ) -> OrderPreview:
        if self.kill_switch_mode == "halt":
            raise KillSwitchActiveError("KAI_TRADING_MODE=halt — no new intents accepted")
        preview = broker.preview(intent, connection)
        self.pending[intent.intent_id] = PendingApproval(
            intent=intent,
            preview=preview,
            expires_at_ms=preview.expires_at_ms,
        )
        self.audit.append(
            user_id=intent.user_id,
            event_type="order_intent",
            payload={
                "intent_id": intent.intent_id,
                "ticker": intent.ticker,
                "side": intent.side.value,
                "qty": intent.qty,
                "type": intent.order_type.value,
                "tif": intent.time_in_force.value,
                "limit_price": intent.limit_price,
                "strategy_id": intent.strategy_id,
                "idempotency_key": intent.idempotency_key,
            },
        )
        self.audit.append(
            user_id=intent.user_id,
            event_type="order_preview",
            payload={
                "intent_id": intent.intent_id,
                "estimated_price": preview.estimated_price,
                "estimated_fees": preview.estimated_fees,
                "estimated_notional": preview.estimated_notional,
                "portfolio_impact_pct": preview.portfolio_impact_pct,
                "risk_warnings": list(preview.risk_warnings),
            },
        )
        return preview

    def submit_approved(
        self,
        approval: ExecutionApproval,
        broker: ExecutionBroker,
        connection: BrokerConnection,
    ) -> ExecutionOrder:
        if self.kill_switch_mode == "halt":
            raise KillSwitchActiveError("KAI_TRADING_MODE=halt — submit blocked")
        pending = self.pending.get(approval.intent_id)
        if pending is None:
            raise ApprovalRequiredError(
                f"no pending intent for intent_id={approval.intent_id!r}"
            )
        now_ms = int(time.time() * 1000)
        if now_ms > pending.expires_at_ms:
            self.audit.append(
                user_id=approval.user_id,
                event_type="approval_expired",
                payload={"intent_id": approval.intent_id},
            )
            del self.pending[approval.intent_id]
            raise ApprovalRequiredError("preview expired; re-issue intent for fresh preview")

        self.audit.append(
            user_id=approval.user_id,
            event_type="execution_approval",
            payload={
                "intent_id": approval.intent_id,
                "approved_at_ms": approval.approved_at_ms,
            },
        )

        order = broker.submit(pending.intent, approval, connection)
        # Remove from pending regardless of fill state — the broker now owns it.
        del self.pending[approval.intent_id]

        self.audit.append(
            user_id=approval.user_id,
            event_type="order_submitted",
            payload={
                "intent_id": order.intent_id,
                "order_id": order.order_id,
                "broker_id": order.broker_id,
                "status": order.status.value,
            },
        )
        if order.status == ExecutionStatus.FILLED:
            self.audit.append(
                user_id=approval.user_id,
                event_type="order_filled",
                payload={
                    "order_id": order.order_id,
                    "filled_qty": order.filled_qty,
                    "avg_fill_price": order.avg_fill_price,
                },
            )
        return order

    def discard(self, intent_id: str, *, user_id: str, reason: str) -> None:
        if intent_id in self.pending:
            del self.pending[intent_id]
            self.audit.append(
                user_id=user_id,
                event_type="intent_discarded",
                payload={"intent_id": intent_id, "reason": reason},
            )


__all__ = ["ApprovalFlow", "PendingApproval"]
