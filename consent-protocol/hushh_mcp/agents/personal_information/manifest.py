"""One Personal Information Agent manifest."""

from hushh_mcp.constants import ConsentScope

MANIFEST = {
    "agent_id": "agent_personal_information",
    "name": "Information Marketplace",
    "version": "0.1.0",
    "description": (
        "Marketplace chatbot under One: lets the owner query, publish, and manage "
        "their own PKM data slices with consent, and answers what is published and "
        "what it is worth. Delegatable by Agent One over A2A."
    ),
    "required_scopes": [
        ConsentScope.AGENT_ONE_ORCHESTRATE,
        ConsentScope.CAP_PKM_MARKETPLACE_VIEW,
    ],
    "optional_scopes": [
        ConsentScope.CAP_PKM_MARKETPLACE_PUBLISH,
        ConsentScope.CAP_PKM_MARKETPLACE_MANAGE,
    ],
    "specialists": [
        {
            "id": "nav",
            "name": "Nav",
            "description": "Consent, revocation, and audit language for published slices.",
            "color": "#10B981",
            "icon": "shield-check",
        }
    ],
    "capabilities": {
        "reads_published_slice_metadata": True,
        "returns_raw_pkm_values": False,
        "server_authoritative_pricing": True,
        "payment_rail": False,
    },
    "compliance": {
        "consent_required": True,
        "owner_only_reads": True,
        "raw_pkm_values_returned": False,
        "audit_trail": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
