"""End-to-end paper trading session: strategy -> intent -> auto-approve -> fill."""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from hushh_mcp.operons.kai.trading.data import StubBarFetcher, fetch_panel
from hushh_mcp.operons.kai.trading.execution import (
    ApprovalFlow,
    AuditLog,
    BrokerConnection,
    MockExecutionBroker,
)
from hushh_mcp.operons.kai.trading.execution.audit import InMemoryAuditStorage
from hushh_mcp.operons.kai.trading.paper import (
    PaperTradingSession,
    PositionBook,
    run_session_over,
)
from hushh_mcp.operons.kai.trading.risk import RiskLimits
from hushh_mcp.operons.kai.trading.strategies import CrossSectionalMomentum


@pytest.fixture(scope="module")
def panel() -> dict:
    fetcher = StubBarFetcher()
    return fetch_panel(
        fetcher,
        ["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA", "TSLA", "JPM"],
        datetime(2021, 1, 1, tzinfo=timezone.utc),
        datetime(2023, 12, 31, tzinfo=timezone.utc),
    )


def _build_session(*, auto_approve: bool = True) -> PaperTradingSession:
    audit = AuditLog(InMemoryAuditStorage())
    flow = ApprovalFlow(audit=audit, kill_switch_mode="paper")
    broker = MockExecutionBroker(price_source=lambda _t: 100.0, starting_cash=1_000_000.0)
    connection = BrokerConnection(
        broker_id="mock",
        user_id="user_alice",
        credential_ref="ref",
        paper=True,
    )
    book = PositionBook(cash=1_000_000.0)
    # Loosen risk limits so the test exercises the happy path.
    limits = RiskLimits(
        per_name_cap_pct=1.0,
        sector_cap_pct=1.0,
        max_gross_leverage=2.0,
        daily_turnover_cap_pct=10.0,
        daily_loss_limit_pct=-1.0,
        drawdown_auto_halt_pct=-1.0,
    )
    return PaperTradingSession(
        user_id="user_alice",
        strategy=CrossSectionalMomentum(long_only=True),
        broker=broker,
        connection=connection,
        approval_flow=flow,
        book=book,
        auto_approve=auto_approve,
        risk_limits=limits,
        sector_of={t: "tech" for t in ["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA", "TSLA"]} | {"JPM": "fin"},
    )


def test_session_produces_orders_and_updates_book(panel) -> None:
    session = _build_session()
    # Sample sparingly — quarterly rebalance index from the panel.
    idx = pd.DatetimeIndex(panel["AAPL"].frame.index).normalize().unique()
    quarterly = pd.DatetimeIndex([idx[i] for i in range(0, len(idx), 60)])
    orders = run_session_over(session, panel, rebalance_index=quarterly)
    assert len(orders) > 0
    # After running, the book holds positions and cash differs from start.
    assert sum(abs(q) for q in session.book.positions.values()) > 0
    assert session.book.cash != 1_000_000.0


def test_non_auto_approve_leaves_pending(panel) -> None:
    session = _build_session(auto_approve=False)
    idx = pd.DatetimeIndex(panel["AAPL"].frame.index).normalize().unique()
    quarterly = pd.DatetimeIndex([idx[i] for i in range(0, len(idx), 60)])
    orders = run_session_over(session, panel, rebalance_index=quarterly)
    # Without auto-approve, no orders are submitted; intents are pending.
    assert orders == []
    assert len(session.approval_flow.pending) > 0


def test_audit_trail_records_intent_and_fill(panel) -> None:
    session = _build_session()
    idx = pd.DatetimeIndex(panel["AAPL"].frame.index).normalize().unique()
    one_step = pd.DatetimeIndex([idx[300]])
    run_session_over(session, panel, rebalance_index=one_step)
    storage = session.approval_flow.audit._storage  # type: ignore[attr-defined]
    events = [e.event_type for e in storage.all_for_user("user_alice")]
    assert "order_intent" in events
    assert "order_filled" in events


def test_audit_chain_remains_valid_after_session(panel) -> None:
    session = _build_session()
    idx = pd.DatetimeIndex(panel["AAPL"].frame.index).normalize().unique()
    quarterly = pd.DatetimeIndex([idx[i] for i in range(0, len(idx), 60)])
    run_session_over(session, panel, rebalance_index=quarterly)
    assert session.approval_flow.audit.verify_chain("user_alice") is True
