"""Abstract broker interface every execution backend implements.

The base enforces the binding rules from the brokerage architecture
doc: every submit requires a valid `ExecutionApproval` whose
`intent_id` matches the order, no auto-trade paths, and idempotency on
the broker's client-order-id.
"""

from __future__ import annotations

import abc
from typing import Iterable

from .contracts import (
    BrokerConnection,
    ExecutionAccount,
    ExecutionApproval,
    ExecutionOrder,
    ExecutionStatus,
    OrderIntent,
    OrderPreview,
)


class BrokerSubmitError(RuntimeError):
    pass


class ApprovalRequiredError(BrokerSubmitError):
    """Raised when a submit is attempted without a matching approval."""


class KillSwitchActiveError(BrokerSubmitError):
    """Raised when KAI_TRADING_MODE=halt blocks a submit."""


class ExecutionBroker(abc.ABC):
    """Every concrete broker (mock, Alpaca, IBKR, ...) implements this."""

    broker_id: str
    paper: bool

    @abc.abstractmethod
    def get_account(self, connection: BrokerConnection) -> ExecutionAccount: ...

    @abc.abstractmethod
    def preview(
        self,
        intent: OrderIntent,
        connection: BrokerConnection,
    ) -> OrderPreview: ...

    @abc.abstractmethod
    def submit(
        self,
        intent: OrderIntent,
        approval: ExecutionApproval,
        connection: BrokerConnection,
    ) -> ExecutionOrder: ...

    @abc.abstractmethod
    def status(
        self,
        order: ExecutionOrder,
        connection: BrokerConnection,
    ) -> ExecutionOrder: ...

    @abc.abstractmethod
    def cancel(
        self,
        order: ExecutionOrder,
        connection: BrokerConnection,
    ) -> ExecutionOrder: ...

    @abc.abstractmethod
    def list_open_orders(
        self,
        connection: BrokerConnection,
    ) -> Iterable[ExecutionOrder]: ...

    # ------------------------------------------------------------------
    # Shared helpers for subclasses
    # ------------------------------------------------------------------

    @staticmethod
    def assert_approval_matches(intent: OrderIntent, approval: ExecutionApproval) -> None:
        """Reject any submit whose approval does not match the intent."""
        if approval.intent_id != intent.intent_id:
            raise ApprovalRequiredError(
                f"approval.intent_id={approval.intent_id!r} does not match "
                f"intent.intent_id={intent.intent_id!r}"
            )
        if approval.user_id != intent.user_id:
            raise ApprovalRequiredError("approval.user_id does not match intent.user_id")
        if not approval.consent_token:
            raise ApprovalRequiredError("approval.consent_token is empty")

    @staticmethod
    def terminal_statuses() -> frozenset[ExecutionStatus]:
        return frozenset({
            ExecutionStatus.FILLED,
            ExecutionStatus.CANCELLED,
            ExecutionStatus.REJECTED,
            ExecutionStatus.HALTED,
        })


__all__ = [
    "ApprovalRequiredError",
    "BrokerSubmitError",
    "ExecutionBroker",
    "KillSwitchActiveError",
]
