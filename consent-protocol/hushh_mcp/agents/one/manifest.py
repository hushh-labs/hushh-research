"""Agent One manifest.

One is the top personal agent and relationship layer. Runtime code may still
use the legacy orchestrator package while migration proceeds.
"""

from hushh_mcp.constants import ConsentScope

MANIFEST = {
    "agent_id": "agent_one",
    "legacy_ids": ["agent_orchestrator"],
    "name": "Agent One",
    "version": "0.1.0",
    "description": "Top personal agent that frames user intent and delegates specialist work.",
    "required_scopes": [
        ConsentScope.AGENT_ONE_ORCHESTRATE,
    ],
    "optional_scopes": [],
    "specialists": [
        {
            "id": "kai",
            "name": "Kai",
            "description": "Finance, portfolio, market, and RIA/investor specialist.",
            "color": "#D4AF37",
            "icon": "chart-line",
        },
        {
            "id": "nav",
            "name": "Nav",
            "description": "Privacy, consent, vault, deletion, and scope-review guardian.",
            "color": "#10B981",
            "icon": "shield-check",
        },
        {
            "id": "kyc",
            "name": "KYC",
            "description": "Identity/KYC workflow, missing-document state, and structured PKM writeback specialist.",
            "color": "#6366F1",
            "icon": "id-card",
        },
    ],
    "capabilities": {
        "relationship_layer": True,
        "specialist_delegation": True,
        "direct_finance_analysis": False,
        "direct_privacy_enforcement": False,
        "direct_kyc_processing": False,
    },
    "compliance": {
        "consent_required": True,
        "vault_gated": True,
        "delegation_scoped": True,
        "audit_trail": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
