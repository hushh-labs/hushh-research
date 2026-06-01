"""One Location Agent manifest."""

from hushh_mcp.constants import ConsentScope

MANIFEST = {
    "agent_id": "agent_location",
    "name": "Location Agent",
    "version": "0.1.0",
    "description": "Trusted-people live location workflow under One, consent, recipient encryption, revocation, and audit.",
    "required_scopes": [
        ConsentScope.AGENT_ONE_ORCHESTRATE,
        ConsentScope.CAP_LOCATION_LIVE_SHARE,
    ],
    "optional_scopes": [
        ConsentScope.CAP_LOCATION_LIVE_VIEW,
        ConsentScope.CAP_LOCATION_LIVE_REQUEST,
        ConsentScope.CAP_LOCATION_LIVE_REVOKE,
        ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST,
    ],
    "specialists": [
        {
            "id": "nav",
            "name": "Nav",
            "description": "Consent, revocation, expiry, audit language, and warning copy.",
            "color": "#10B981",
            "icon": "shield-check",
        }
    ],
    "capabilities": {
        "recipient_scoped_encryption": True,
        "public_bearer_links": False,
        "server_plaintext_coordinates": False,
        "referral_grants_access": False,
    },
    "compliance": {
        "consent_required": True,
        "recipient_identity_required": True,
        "recipient_e2ee_required": True,
        "backend_plaintext_coordinates_allowed": False,
        "public_bearer_links_allowed": False,
        "audit_trail": True,
        "metadata_only_notifications": True,
    },
}


def get_manifest():
    """Get agent manifest."""
    return MANIFEST
