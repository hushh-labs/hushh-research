"""Trading specialist manifest.

Mirrors the shape of `consent-protocol/hushh_mcp/agents/kai/manifest.py`
so the agent registry can consume both alongside the other Kai
specialists.
"""

from __future__ import annotations

from hushh_mcp.constants import ConsentScope

MANIFEST: dict = {
    "agent_id": "agent_kai_trading",
    "name": "Kai Trading Agent",
    "version": "0.1.0",
    "description": (
        "Strategy research, walk-forward backtesting, paper trading, and "
        "per-order-approved live execution. Reports realized IRR honestly "
        "alongside Sharpe / Sortino / Calmar / max drawdown / turnover."
    ),
    "required_scopes": [
        ConsentScope.PKM_READ,
        ConsentScope.PKM_WRITE,
        ConsentScope.AGENT_KAI_TRADE_SIMULATE,
    ],
    "optional_scopes": [
        ConsentScope.AGENT_KAI_TRADE_EXECUTE,
        ConsentScope.AGENT_KAI_TRADE_APPROVE,
        ConsentScope.EXTERNAL_MARKET_DATA,
    ],
    "specialists": [
        {
            "id": "research",
            "name": "Research",
            "description": "Backtests, walk-forward CV, and equity-curve metrics",
            "color": "#0ea5e9",
            "icon": "search",
        },
        {
            "id": "paper",
            "name": "Paper Trading",
            "description": "Auto-approved simulated execution against live data",
            "color": "#22c55e",
            "icon": "flask",
        },
        {
            "id": "execution",
            "name": "Execution",
            "description": "Per-order human-approved live trading via broker adapters",
            "color": "#f59e0b",
            "icon": "trending-up",
        },
    ],
    "capabilities": {
        "on_device": False,
        "hybrid": True,
        "real_time": True,
        "historical": True,
        "permissioned_execution": True,
    },
    "compliance": {
        "educational_only": True,
        "not_investment_advice": True,
        "disclaimer_required": True,
        "audit_trail": True,
        "per_order_human_approval": True,
        "kill_switch": True,
        "honest_irr_reporting": True,
    },
    "north_star": {
        "irr": 0.6969,
        "is_guarantee": False,
        "framing": (
            "The 69.69% IRR target is a research goal. The system reports "
            "realized IRR alongside Sharpe / Sortino / Calmar / max drawdown / "
            "turnover and never tweaks the comparison."
        ),
    },
}


def get_manifest() -> dict:
    return MANIFEST


__all__ = ["MANIFEST", "get_manifest"]
