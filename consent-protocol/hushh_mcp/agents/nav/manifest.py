"""Agent Nav manifest."""

from hushh_mcp.constants import ConsentScope

MANIFEST = {
    "agent_id": "agent_nav",
    "name": "Agent Nav",
    "version": "0.1.0",
    "description": "Privacy and consent guardian for scope review, vault friction, deletion, and revocation.",
    "required_scopes": [
        ConsentScope.AGENT_NAV_REVIEW,
    ],
    "optional_scopes": [
        ConsentScope.AGENT_NAV_REVOKE,
    ],
    "specialists": [],
    "capabilities": {
        "scope_review": True,
        "revocation_guidance": True,
        "vault_friction": True,
        "finance_analysis": False,
    },
    "compliance": {
        "consent_required": True,
        "privacy_guardian": True,
        "audit_trail": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
