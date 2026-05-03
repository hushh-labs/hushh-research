"""Trading sub-agent manifest + tool-facade contract tests."""

from __future__ import annotations

import re
from datetime import datetime, timezone

import pytest

from hushh_mcp.agents.kai.trading import MANIFEST as TRADING_MANIFEST
from hushh_mcp.agents.kai.trading import (
    list_strategies,
    propose_order,
    run_backtest,
    walk_forward_evaluate,
)
from hushh_mcp.agents.kai.trading.manifest import get_manifest as get_trading_manifest
from hushh_mcp.constants import ConsentScope
from hushh_mcp.operons.kai.trading.data import StubBarFetcher
from hushh_mcp.operons.kai.trading.execution import (
    ApprovalFlow,
    AuditLog,
    BrokerConnection,
    MockExecutionBroker,
)
from hushh_mcp.operons.kai.trading.execution.audit import InMemoryAuditStorage

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def test_trading_manifest_shape() -> None:
    for key in (
        "agent_id",
        "name",
        "version",
        "description",
        "required_scopes",
        "optional_scopes",
        "specialists",
        "capabilities",
        "compliance",
        "north_star",
    ):
        assert key in TRADING_MANIFEST


def test_trading_manifest_version_is_semver() -> None:
    assert SEMVER.match(TRADING_MANIFEST["version"])


def test_trading_manifest_required_scopes_include_simulate() -> None:
    assert ConsentScope.AGENT_KAI_TRADE_SIMULATE in TRADING_MANIFEST["required_scopes"]


def test_trading_manifest_specialists_have_valid_colors() -> None:
    for specialist in TRADING_MANIFEST["specialists"]:
        assert HEX.match(specialist["color"])


def test_get_manifest_returns_same_dict() -> None:
    assert get_trading_manifest() is TRADING_MANIFEST


def test_compliance_flags_all_bool() -> None:
    for value in TRADING_MANIFEST["compliance"].values():
        assert isinstance(value, bool)


def test_north_star_is_not_a_guarantee() -> None:
    ns = TRADING_MANIFEST["north_star"]
    assert ns["irr"] == 0.6969
    assert ns["is_guarantee"] is False
    assert "research goal" in ns["framing"].lower() or "target" in ns["framing"].lower()


def test_list_strategies_returns_registry() -> None:
    catalog = list_strategies()
    names = {s["name"] for s in catalog}
    assert {"xs_momentum_12_1", "zscore_reversion", "donchian_breakout"} <= names


def test_run_backtest_returns_summary_keys() -> None:
    summary = run_backtest(
        strategy_name="xs_momentum_12_1",
        tickers=["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA"],
        start=datetime(2021, 1, 1, tzinfo=timezone.utc),
        end=datetime(2023, 6, 30, tzinfo=timezone.utc),
        fetcher=StubBarFetcher(),
    )
    for key in (
        "irr",
        "sharpe",
        "sortino",
        "calmar",
        "max_drawdown",
        "north_star_irr",
        "meets_north_star",
        "equity_curve_hash",
    ):
        assert key in summary


def test_walk_forward_evaluate_returns_per_fold_irr() -> None:
    summary = walk_forward_evaluate(
        strategy_name="xs_momentum_12_1",
        tickers=["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA"],
        start=datetime(2020, 1, 1, tzinfo=timezone.utc),
        end=datetime(2023, 12, 31, tzinfo=timezone.utc),
        fetcher=StubBarFetcher(),
        train_years=1.0,
        test_years=0.5,
    )
    assert summary["folds"] >= 4
    assert isinstance(summary["per_fold_irr"], list)


def test_propose_order_emits_intent_and_preview() -> None:
    audit = AuditLog(InMemoryAuditStorage())
    flow = ApprovalFlow(audit=audit, kill_switch_mode="paper")
    broker = MockExecutionBroker(price_source=lambda _t: 200.0, starting_cash=100_000.0)
    connection = BrokerConnection(
        broker_id="mock", user_id="user_alice", credential_ref="ref", paper=True,
    )
    intent, preview = propose_order(
        user_id="user_alice",
        strategy_id="xs_momentum_12_1",
        ticker="AAPL",
        side="buy",
        qty=10,
        order_type="market",
        time_in_force="day",
        limit_price=None,
        broker=broker,
        connection=connection,
        approval_flow=flow,
    )
    assert preview.estimated_price == 200.0
    assert intent.intent_id in flow.pending


def test_propose_order_rejects_invalid_side() -> None:
    audit = AuditLog(InMemoryAuditStorage())
    flow = ApprovalFlow(audit=audit, kill_switch_mode="paper")
    broker = MockExecutionBroker(price_source=lambda _t: 1.0)
    connection = BrokerConnection(broker_id="mock", user_id="u", credential_ref="r", paper=True)
    with pytest.raises(ValueError):
        propose_order(
            user_id="u",
            strategy_id="x",
            ticker="A",
            side="hodl",  # invalid
            qty=1,
            order_type="market",
            time_in_force="day",
            limit_price=None,
            broker=broker,
            connection=connection,
            approval_flow=flow,
        )
