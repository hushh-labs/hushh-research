"""Trading specialist tool facades.

These functions are intentionally side-effect-light Python callables
that compose the operons. The MCP server / FastAPI routes wrap them
with consent-token validation and persistence; the operons themselves
remain unaware of HTTP and PKM.

Tool registry (consumed by mcp_server.py):

| Tool name                           | Required scope                  |
| ----------------------------------- | ------------------------------- |
| kai_trading_list_strategies         | agent.kai.trade.simulate        |
| kai_trading_run_backtest            | agent.kai.trade.simulate        |
| kai_trading_walk_forward_evaluate   | agent.kai.trade.simulate        |
| kai_trading_start_paper_session     | agent.kai.trade.simulate        |
| kai_trading_propose_order           | agent.kai.trade.execute         |
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from hushh_mcp.operons.kai.trading.backtest import (
    BacktestConfig,
    BacktestResult,
    run as run_backtest_op,
)
from hushh_mcp.operons.kai.trading.data import BarFetcher, BarSeries, fetch_panel
from hushh_mcp.operons.kai.trading.execution import (
    ApprovalFlow,
    BrokerConnection,
    ExecutionBroker,
    OrderIntent,
    OrderPreview,
    OrderSide,
    OrderType,
    TimeInForce,
)
from hushh_mcp.operons.kai.trading.paper import (
    PaperTradingSession,
    PositionBook,
    run_session_over,
)
from hushh_mcp.operons.kai.trading.risk import RiskLimits
from hushh_mcp.operons.kai.trading.strategies import (
    CrossSectionalMomentum,
    DonchianBreakout,
    InverseVolAllocator,
    RenaissanceOverlay,
    ZScoreReversion,
)
from hushh_mcp.operons.kai.trading.strategies.base import Strategy
from hushh_mcp.operons.kai.trading.walkforward import WalkForwardResult, walk_forward


_STRATEGY_REGISTRY: dict[str, type] = {
    "xs_momentum_12_1": CrossSectionalMomentum,
    "zscore_reversion": ZScoreReversion,
    "donchian_breakout": DonchianBreakout,
}


def list_strategies() -> list[dict[str, Any]]:
    """Return the catalog of registered strategies and default params."""
    out: list[dict[str, Any]] = []
    for name, cls in _STRATEGY_REGISTRY.items():
        instance = cls()
        out.append(
            {
                "name": name,
                "class": cls.__name__,
                "default_params": {
                    k: getattr(instance, k)
                    for k in instance.__dataclass_fields__  # type: ignore[attr-defined]
                    if k != "name"
                },
            }
        )
    return out


def _resolve_strategy(name: str, params: Mapping[str, Any] | None = None) -> Strategy:
    if name not in _STRATEGY_REGISTRY:
        raise ValueError(f"unknown strategy: {name!r}")
    cls = _STRATEGY_REGISTRY[name]
    return cls(**(params or {}))


def run_backtest(
    *,
    strategy_name: str,
    tickers: list[str],
    start: datetime,
    end: datetime,
    fetcher: BarFetcher,
    strategy_params: Mapping[str, Any] | None = None,
    config: BacktestConfig | None = None,
) -> dict[str, Any]:
    """Run a single full-window backtest and return a JSON-friendly summary."""

    strategy = _resolve_strategy(strategy_name, strategy_params)
    panel = fetch_panel(fetcher, tickers, start, end)
    if not panel:
        raise ValueError("no data fetched for any ticker")
    result: BacktestResult = run_backtest_op(strategy, panel, config)
    return result.to_summary()


def walk_forward_evaluate(
    *,
    strategy_name: str,
    tickers: list[str],
    start: datetime,
    end: datetime,
    fetcher: BarFetcher,
    train_years: float = 2.0,
    test_years: float = 0.5,
    strategy_params: Mapping[str, Any] | None = None,
    config: BacktestConfig | None = None,
) -> dict[str, Any]:
    """Run walk-forward CV and return pooled out-of-sample metrics."""

    strategy = _resolve_strategy(strategy_name, strategy_params)
    panel = fetch_panel(fetcher, tickers, start, end)
    if not panel:
        raise ValueError("no data fetched for any ticker")
    wf: WalkForwardResult = walk_forward(
        strategy,
        panel,
        train_years=train_years,
        test_years=test_years,
        config=config,
    )
    summary = wf.pooled.to_summary()
    summary["folds"] = len(wf.folds)
    summary["per_fold_irr"] = [f.metrics.irr for f in wf.folds]
    return summary


def start_paper_session(
    *,
    user_id: str,
    strategy_name: str,
    broker: ExecutionBroker,
    connection: BrokerConnection,
    approval_flow: ApprovalFlow,
    starting_cash: float = 100_000.0,
    risk_limits: RiskLimits | None = None,
    sector_of: Mapping[str, str] | None = None,
    strategy_params: Mapping[str, Any] | None = None,
) -> PaperTradingSession:
    strategy = _resolve_strategy(strategy_name, strategy_params)
    return PaperTradingSession(
        user_id=user_id,
        strategy=strategy,
        broker=broker,
        connection=connection,
        approval_flow=approval_flow,
        book=PositionBook(cash=starting_cash),
        auto_approve=True,
        risk_limits=risk_limits or RiskLimits(),
        sector_of=sector_of or {},
    )


def propose_order(
    *,
    user_id: str,
    strategy_id: str,
    ticker: str,
    side: str,
    qty: float,
    order_type: str,
    time_in_force: str,
    limit_price: float | None,
    broker: ExecutionBroker,
    connection: BrokerConnection,
    approval_flow: ApprovalFlow,
    note: str = "",
) -> tuple[OrderIntent, OrderPreview]:
    """Compose an OrderIntent and emit it through the approval flow.

    Returns the intent + preview so the caller (UI / MCP tool) can
    render the click-to-sign modal. Submission requires the user's
    `ExecutionApproval` posted back to `approval_flow.submit_approved`.
    """

    intent = OrderIntent(
        intent_id=OrderIntent.new_id(),
        user_id=user_id,
        strategy_id=strategy_id,
        ticker=ticker,
        side=OrderSide(side),
        qty=qty,
        order_type=OrderType(order_type),
        time_in_force=TimeInForce(time_in_force),
        limit_price=limit_price,
        note=note,
    )
    preview = approval_flow.emit_intent(intent, broker, connection)
    return intent, preview


__all__ = [
    "list_strategies",
    "propose_order",
    "run_backtest",
    "start_paper_session",
    "walk_forward_evaluate",
]
