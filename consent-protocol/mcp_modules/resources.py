# mcp/resources.py
"""
MCP Resources (informational endpoints).
"""

import json

from mcp.types import Resource

from mcp_modules.config import SERVER_INFO


async def list_resources() -> list[Resource]:
    """List available MCP resources."""
    return [
        Resource(
            uri="hushh://info/server",
            name="Server Information",
            description="Hussh MCP Server version and capabilities",
            mimeType="application/json",
        ),
        Resource(
            uri="hushh://info/protocol",
            name="Protocol Information",
            description="HushhMCP protocol compliance details",
            mimeType="application/json",
        ),
        Resource(
            uri="hushh://info/connector",
            name="Connector usage and capabilities",
            description="What the Hussh connector does, tool list, recommended flow, and supported scopes",
            mimeType="application/json",
        ),
    ]


async def read_resource(uri: str) -> str:
    """Read MCP resource content by URI."""
    import logging

    logger = logging.getLogger("hushh-mcp-server")

    # Normalize: MCP SDK may pass AnyUrl; some hosts add trailing slash
    uri_str = str(uri).strip().rstrip("/")
    logger.info(f"📖 Reading resource: {uri_str}")

    if uri_str == "hushh://info/server":
        return json.dumps(SERVER_INFO, indent=2)

    elif uri_str == "hushh://info/protocol":
        protocol_info = {
            "name": "HushhMCP Protocol",
            "version": "1.0.0",
            "core_principles": [
                "🔐 Consent First - No data access without explicit user approval",
                "🎯 Scoped Access - Each data category requires separate consent",
                "✍️ Cryptographic Signatures - Tokens signed with HMAC-SHA256",
                "⏱️ Time-Limited - Tokens expire after configurable duration",
                "🔗 TrustLinks - Agent-to-agent delegation with proof",
            ],
            "token_format": "HCT:base64(user|agent|scope|issued|expires).signature",
            "scopes_are_dynamic": True,
            "scope_note": "Scopes are NOT a fixed list. They come from the world model registry and per-user metadata. Always use discover_user_domains(user_id) or GET /api/v1/user-scopes/{user_id} to get the actual scope strings for a user. Domains come from world_model_index_v2.available_domains; optional subintent scopes are inferred from domain summaries + domain_registry metadata.",
            "scope_examples": [
                "world_model.read - Full world model (all domains)",
                "world_model.write - Write to world model",
                "attr.{domain}.* - One domain (domain key from discover_user_domains or metadata; e.g. attr.financial.*, attr.food.*)",
            ],
            "zero_knowledge": True,
            "server_sees_plaintext": False,
        }
        return json.dumps(protocol_info, indent=2)

    elif uri_str == "hushh://info/connector":
        connector_info = {
            "what": "The Hussh connector provides consent-first personal data access for AI agents. Data is only returned after explicit user approval. Zero-knowledge and scoped access apply where applicable.",
            "tools": [
                {
                    "name": "request_consent",
                    "purpose": "Request user consent for a scope",
                    "when_to_use": "Before accessing any user data; pass scope from discover_user_domains or list_scopes",
                },
                {
                    "name": "validate_token",
                    "purpose": "Validate a consent token",
                    "when_to_use": "Before using a token with get_* tools or external APIs",
                },
                {
                    "name": "discover_user_domains",
                    "purpose": "Discover user domains and scope strings",
                    "when_to_use": "First step to know which scopes to request for a user",
                },
                {
                    "name": "list_scopes",
                    "purpose": "List available scope categories",
                    "when_to_use": "Static reference for scope names if not using discover_user_domains",
                },
                {
                    "name": "check_consent_status",
                    "purpose": "Check current status of pending consent",
                    "when_to_use": "After request_consent when status is pending",
                },
                {
                    "name": "get_food_preferences",
                    "purpose": "Get food/dining preferences",
                    "when_to_use": "After consent for attr.food.* or world_model.read",
                },
                {
                    "name": "get_professional_profile",
                    "purpose": "Get professional profile",
                    "when_to_use": "After consent for attr.professional.* or world_model.read",
                },
                {
                    "name": "delegate_to_agent",
                    "purpose": "Create TrustLink for agent delegation",
                    "when_to_use": "When one agent needs to delegate access to another",
                },
                {
                    "name": "list_ria_profiles",
                    "purpose": "List discoverable RIA marketplace profiles (read-only)",
                    "when_to_use": "When building advisor discovery experiences",
                },
                {
                    "name": "get_ria_profile",
                    "purpose": "Get discoverable RIA profile details by id (read-only)",
                    "when_to_use": "After advisor selection from marketplace search",
                },
                {
                    "name": "list_marketplace_investors",
                    "purpose": "List discoverable opt-in investor profiles (read-only)",
                    "when_to_use": "When building RIA client discovery experiences",
                },
                {
                    "name": "get_ria_verification_status",
                    "purpose": "Get RIA verification status for a user (read-only)",
                    "when_to_use": "With same-user VAULT_OWNER token during advisor control-plane checks",
                },
                {
                    "name": "get_ria_client_access_summary",
                    "purpose": "Get RIA relationship/access summary (read-only)",
                    "when_to_use": "With same-user VAULT_OWNER token before advisor workspace actions",
                },
            ],
            "recommended_flow": [
                "1. discover_user_domains(user_id) to get domains and scope strings for this user",
                "2. request_consent(user_id, scope) for each scope needed (e.g. world_model.read or attr.food.*)",
                "3. If status is pending, return control to caller; user approves in app and caller can re-check status later",
                "4. Use the returned consent_token with get_* tools or world-model data APIs",
            ],
            "scopes_are_dynamic": True,
            "supported_scopes": "world_model.read, world_model.write, attr.{domain}.*, and attr.{domain}.{subintent}.* when metadata exposes subintents. No fixed list.",
            "discover_scopes": "Call discover_user_domains(user_id) first to get this user's domains and scope strings. Backend uses GET /api/v1/user-scopes/{user_id} (developer-auth) and validates against world_model_index_v2 + domain_registry metadata.",
            "server_backend": "Backend: FastAPI consent API. Set CONSENT_API_URL if not using default (e.g. http://localhost:8000).",
            "consent_ui_required": "When request_consent returns 'pending', the user must approve in the Hussh app (consents/dashboard). Delivery is FCM-first in production; consent SSE/polling is disabled for this flow.",
        }
        return json.dumps(connector_info, indent=2)

    else:
        logger.warning(f"❌ Unknown resource URI: {uri_str}")
        return json.dumps({"error": f"Unknown resource: {uri_str}"})
