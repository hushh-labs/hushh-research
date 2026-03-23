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
    # Optional scopes (for hybrid mode)
    "optional_scopes": [
        ConsentScope("external.sec.filings"),
        ConsentScope("external.market.data"),
        ConsentScope("external.news.api"),
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
    ],
    # Capabilities
    "capabilities": {
        "on_device": True,  # Supports on-device analysis
        "hybrid": True,  # Supports hybrid mode with external data
        "real_time": True,  # Can fetch real-time data
        "historical": True,  # Can analyze historical data
    },
    # Regulatory compliance
    "compliance": {
        "educational_only": True,
        "not_investment_advice": True,
        "disclaimer_required": True,
        "audit_trail": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
