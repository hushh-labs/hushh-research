"""Concrete execution contracts.

These dataclasses are the binding shape of every order that flows
through the Trading specialist, regardless of broker. The reserved
contracts listed in `docs/reference/kai/kai-brokerage-connectivity-architecture.md`
under "Broker Execution Shape" map 1:1 to the classes here.

Frozen + slot-friendly (via dataclass(frozen=True)) so audit-log entries
can hash deterministically across processes.
"""

from __future__ import annotations

import enum
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional


class OrderSide(str, enum.Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, enum.Enum):
    MARKET = "market"
    LIMIT = "limit"


class TimeInForce(str, enum.Enum):
    DAY = "day"
    GTC = "gtc"
    IOC = "ioc"


class ExecutionStatus(str, enum.Enum):
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    SUBMITTED = "submitted"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    HALTED = "halted"


@dataclass(frozen=True)
class BrokerConnection:
    """Bearer of the per-user encrypted broker credential reference.

    The actual ciphertext never appears here — only the reference id
    that the integration layer uses to fetch and decrypt the credential
    at submit time.
    """

    broker_id: str
    user_id: str
    credential_ref: str
    paper: bool
    label: str = ""


@dataclass(frozen=True)
class ExecutionAccount:
    broker_id: str
    account_id: str
    user_id: str
    cash: float
    equity: float
    buying_power: float
    paper: bool


@dataclass(frozen=True)
class OrderIntent:
    """An intent emitted by the Trading specialist.

    Idempotency: `idempotency_key` is reused as the broker's
    client-order-id. Resubmissions are no-ops at the broker.
    """

    intent_id: str
    user_id: str
    strategy_id: str
    ticker: str
    side: OrderSide
    qty: float
    order_type: OrderType
    time_in_force: TimeInForce
    limit_price: Optional[float] = None
    note: str = ""
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    idempotency_key: str = field(default_factory=lambda: secrets.token_hex(16))

    @staticmethod
    def new_id() -> str:
        return f"intent_{uuid.uuid4().hex[:16]}"


@dataclass(frozen=True)
class OrderPreview:
    """Pre-submit summary the user reviews before signing approval."""

    intent: OrderIntent
    estimated_price: float
    estimated_fees: float
    estimated_notional: float
    portfolio_impact_pct: float
    risk_headroom_pct: float
    risk_warnings: tuple[str, ...]
    expires_at_ms: int


@dataclass(frozen=True)
class ExecutionApproval:
    """User-signed approval for a single OrderIntent.

    `consent_token` is the vault-owner consent token whose validity is
    re-checked at submit time. `approved_at_ms` is the server-stamped
    moment of approval; `signature` is over (intent_id, consent_token,
    approved_at_ms) signed with the user's BYOK material — verified by
    the broker base before submit.
    """

    intent_id: str
    user_id: str
    consent_token: str
    approved_at_ms: int
    signature: str


@dataclass(frozen=True)
class ExecutionOrder:
    """Broker-side state of a submitted order."""

    order_id: str
    intent_id: str
    broker_id: str
    account_id: str
    status: ExecutionStatus
    submitted_at_ms: int
    filled_qty: float = 0.0
    avg_fill_price: float = 0.0
    last_status_at_ms: Optional[int] = None
    broker_payload: dict = field(default_factory=dict)


__all__ = [
    "BrokerConnection",
    "ExecutionAccount",
    "ExecutionApproval",
    "ExecutionOrder",
    "ExecutionStatus",
    "OrderIntent",
    "OrderPreview",
    "OrderSide",
    "OrderType",
    "TimeInForce",
]
