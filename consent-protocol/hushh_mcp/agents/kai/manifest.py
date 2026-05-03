"""
Agent Kai — Agent Manifest

Registers Kai agents with the Hushh MCP system.
"""

from hushh_mcp.constants import ConsentScope

# Agent metadata
MANIFEST = {
    "agent_id": "agent_kai",
    "name": "Agent Kai",
    "version": "1.0.0",
    "description": "Explainable investing copilot with 3-agent debate framework",
    # Required consent scopes (PKM only; enum members)
    "required_scopes": [
        ConsentScope.PKM_READ,
        ConsentScope.PKM_WRITE,
        ConsentScope.AGENT_KAI_ANALYZE,
    ],
    # Optional scopes (for hybrid mode and trading specialist)
    "optional_scopes": [
        ConsentScope("external.sec.filings"),
        ConsentScope("external.market.data"),
        ConsentScope("external.news.api"),
        ConsentScope.AGENT_KAI_TRADE_SIMULATE,
        ConsentScope.AGENT_KAI_TRADE_EXECUTE,
        ConsentScope.AGENT_KAI_TRADE_APPROVE,
    ],
    # Specialist agents
    "specialists": [
        {
            "id": "fundamental",
            "name": "Fundamental Agent",
            "description": "Analyzes 10-K/10-Q filings and financial fundamentals",
            "color": "#3b82f6",  # Blue
            "icon": "chart-line",
        },
        {
            "id": "sentiment",
            "name": "Sentiment Agent",
            "description": "Processes news articles and market sentiment",
            "color": "#8b5cf6",  # Purple
            "icon": "newspaper",
        },
        {
            "id": "valuation",
            "name": "Valuation Agent",
            "description": "Calculates financial metrics and relative valuation",
            "color": "#10b981",  # Green
            "icon": "calculator",
        },
        {
            "id": "trading",
            "name": "Trading Agent",
            "description": (
                "Strategy research, walk-forward backtesting, paper trading, "
                "and per-order-approved execution. Reports realized IRR honestly "
                "and halts on circuit-breaker breach."
            ),
            "color": "#f59e0b",  # Amber
            "icon": "trending-up",
        },
    ],
    # Capabilities
    "capabilities": {
        "on_device": True,
        "hybrid": True,
        "real_time": True,
        "historical": True,
        # Permissioned execution: every live order requires a signed
        # ExecutionApproval bound to the user's vault-owner consent token.
        # The Trading specialist is the only surface that may emit OrderIntents.
        "permissioned_execution": True,
    },
    # Regulatory compliance
    "compliance": {
        "educational_only": True,
        "not_investment_advice": True,
        "disclaimer_required": True,
        "audit_trail": True,
        # Trading-specialist guarantees:
        "per_order_human_approval": True,
        "kill_switch": True,
        "honest_irr_reporting": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
