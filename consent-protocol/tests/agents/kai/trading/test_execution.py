"""Execution scaffold: contracts + mock broker + approval flow + audit."""

from __future__ import annotations

import time

import pytest

from hushh_mcp.operons.kai.trading.execution import (
    ApprovalFlow,
    AuditLog,
    BrokerConnection,
    ExecutionApproval,
    ExecutionStatus,
    MockExecutionBroker,
    OrderIntent,
    OrderSide,
    OrderType,
    TimeInForce,
)
from hushh_mcp.operons.kai.trading.execution.audit import InMemoryAuditStorage
from hushh_mcp.operons.kai.trading.execution.broker_base import (
    ApprovalRequiredError,
    KillSwitchActiveError,
)


@pytest.fixture
def connection() -> BrokerConnection:
    return BrokerConnection(
        broker_id="mock",
        user_id="user_alice",
        credential_ref="cred_ref_x",
        paper=True,
        label="alice paper",
    )


@pytest.fixture
def audit() -> AuditLog:
    return AuditLog(InMemoryAuditStorage())


@pytest.fixture
def flow(audit: AuditLog) -> ApprovalFlow:
    return ApprovalFlow(audit=audit, kill_switch_mode="paper")


@pytest.fixture
def broker() -> MockExecutionBroker:
    return MockExecutionBroker(price_source=lambda _t: 150.0, starting_cash=100_000.0)


def make_intent(user_id: str = "user_alice", ticker: str = "AAPL", qty: float = 10.0) -> OrderIntent:
    return OrderIntent(
        intent_id=OrderIntent.new_id(),
        user_id=user_id,
        strategy_id="xs_momentum_12_1",
        ticker=ticker,
        side=OrderSide.BUY,
        qty=qty,
        order_type=OrderType.MARKET,
        time_in_force=TimeInForce.DAY,
    )


def make_approval(intent: OrderIntent) -> ExecutionApproval:
    return ExecutionApproval(
        intent_id=intent.intent_id,
        user_id=intent.user_id,
        consent_token="HCT.test.token",
        approved_at_ms=int(time.time() * 1000),
        signature="sig.test",
    )


def test_intent_emits_preview_and_audit(flow: ApprovalFlow, broker, connection, audit) -> None:
    intent = make_intent()
    preview = flow.emit_intent(intent, broker, connection)
    assert preview.estimated_price == 150.0
    assert preview.estimated_notional == pytest.approx(1500.0)
    entries = list(audit._storage.all_for_user("user_alice"))  # type: ignore[attr-defined]
    assert [e.event_type for e in entries] == ["order_intent", "order_preview"]


def test_submit_requires_pending_approval(flow, broker, connection) -> None:
    intent = make_intent()
    approval = make_approval(intent)
    with pytest.raises(ApprovalRequiredError, match="no pending intent"):
        flow.submit_approved(approval, broker, connection)


def test_submit_rejects_mismatched_intent_id(flow, broker, connection) -> None:
    intent = make_intent()
    flow.emit_intent(intent, broker, connection)
    other_intent = make_intent()
    bad_approval = ExecutionApproval(
        intent_id=other_intent.intent_id,  # wrong
        user_id=intent.user_id,
        consent_token="HCT.test.token",
        approved_at_ms=int(time.time() * 1000),
        signature="sig.test",
    )
    with pytest.raises(ApprovalRequiredError, match="no pending intent"):
        flow.submit_approved(bad_approval, broker, connection)


def test_happy_path_intent_to_filled(flow, broker, connection, audit) -> None:
    intent = make_intent(qty=10)
    flow.emit_intent(intent, broker, connection)
    approval = make_approval(intent)
    order = flow.submit_approved(approval, broker, connection)
    assert order.status == ExecutionStatus.FILLED
    assert order.filled_qty == 10
    assert order.avg_fill_price == 150.0
    events = [e.event_type for e in audit._storage.all_for_user("user_alice")]  # type: ignore[attr-defined]
    assert events == [
        "order_intent",
        "order_preview",
        "execution_approval",
        "order_submitted",
        "order_filled",
    ]


def test_kill_switch_halt_blocks_intent(audit, broker, connection) -> None:
    flow = ApprovalFlow(audit=audit, kill_switch_mode="halt")
    intent = make_intent()
    with pytest.raises(KillSwitchActiveError):
        flow.emit_intent(intent, broker, connection)


def test_kill_switch_halt_blocks_submit(flow, broker, connection) -> None:
    intent = make_intent()
    flow.emit_intent(intent, broker, connection)
    flow.kill_switch_mode = "halt"
    approval = make_approval(intent)
    with pytest.raises(KillSwitchActiveError):
        flow.submit_approved(approval, broker, connection)


def test_idempotency_same_key_does_not_double_fill(broker, connection) -> None:
    intent = make_intent(qty=5)
    approval = make_approval(intent)
    order_a = broker.submit(intent, approval, connection)
    order_b = broker.submit(intent, approval, connection)
    # Second submit with same idempotency_key returns the same order.
    assert order_a.order_id == order_b.order_id


def test_audit_chain_verifies(flow, broker, connection, audit) -> None:
    intent = make_intent()
    flow.emit_intent(intent, broker, connection)
    approval = make_approval(intent)
    flow.submit_approved(approval, broker, connection)
    assert audit.verify_chain("user_alice") is True


def test_audit_chain_detects_tamper(flow, broker, connection, audit) -> None:
    intent = make_intent()
    flow.emit_intent(intent, broker, connection)
    storage: InMemoryAuditStorage = audit._storage  # type: ignore[assignment]
    # Mutate the first entry's payload — the chain hash should now be wrong.
    original = storage._entries[0]  # type: ignore[attr-defined]
    storage._entries[0] = type(original)(  # type: ignore[attr-defined]
        seq=original.seq,
        user_id=original.user_id,
        event_type=original.event_type,
        payload={**original.payload, "qty": 9999.0},
        prev_hash=original.prev_hash,
        entry_hash=original.entry_hash,
        timestamp_ms=original.timestamp_ms,
    )
    assert audit.verify_chain("user_alice") is False
