"""Execution scaffold for the Kai trading specialist.

The reserved contracts in `kai-brokerage-connectivity-architecture.md`
become concrete here. No live broker code lives in this package; live
adapters belong in `hushh_mcp/integrations/<broker>_trading/` and consume
these contracts.
"""

from .audit import AuditEntry, AuditLog
from .approval_flow import ApprovalFlow, PendingApproval
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
    OrderType,
    TimeInForce,
)
from .mock_broker import MockExecutionBroker

__all__ = [
    "ApprovalFlow",
    "AuditEntry",
    "AuditLog",
    "BrokerConnection",
    "ExecutionAccount",
    "ExecutionApproval",
    "ExecutionBroker",
    "ExecutionOrder",
    "ExecutionStatus",
    "MockExecutionBroker",
    "OrderIntent",
    "OrderPreview",
    "OrderSide",
    "OrderType",
    "PendingApproval",
    "TimeInForce",
]
