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
        Resource(
            uri="hushh://info/developer-api",
            name="Developer API Contract",
            description="Developer API base path, authentication transport, MCP setup, and resource summary",
            mimeType="application/json",
        ),
        Resource(
            uri="hushh://info/consent-lifecycle",
            name="Consent Lifecycle For Coding Agents",
            description="Expected MCP flow for scope discovery, consent reuse, bounded polling, export fetch, and local decrypt",
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
            "scope_note": "External information scopes are discovered per user from the PKM scope registry. pkm.read, pkm.write, and vault.owner are internal-only and are never externally requestable.",
            "scope_examples": [
                "cap.one.invoke - Start or resume One without granting information access",
                "attr.{domain}.{scope}.* - Exact discovered information authority",
            ],
            "zero_knowledge": True,
            "server_sees_plaintext": False,
        }
        return json.dumps(protocol_info, indent=2)

    elif uri_str == "hushh://info/connector":
        public_tools = [
            "prepare_campaign_context",
            "list_scopes",
            "discover_user_domains",
            "search_user_scopes",
            "request_consent",
            "check_consent_status",
            "get_encrypted_scoped_export",
            "validate_token",
        ]
        connector_info = {
            "what": "The Hussh connector provides consent-first personal data access for AI agents. Data is only returned after explicit user approval. Zero-knowledge and scoped access apply where applicable.",
            "tools": [
                {
                    "name": "prepare_campaign_context",
                    "purpose": "High-level consent loop for external campaign/customer-experience agents",
                    "when_to_use": "Preferred when an operator gives a user identifier plus an ads, campaign, or personalization goal",
                },
                {
                    "name": "list_scopes",
                    "purpose": "Static scope reference",
                    "when_to_use": "Use only for orientation; discover_user_domains is authoritative for a specific user",
                },
                {
                    "name": "discover_user_domains",
                    "purpose": "Discover user domains and exact scope strings",
                    "when_to_use": "First step for a specific One user",
                },
                {
                    "name": "search_user_scopes",
                    "purpose": "Deterministically ranked, least-privilege-first lookup over a user's scopes",
                    "when_to_use": "When you have an intent (e.g. 'portfolio') and want the narrowest matching scope without scanning the full discovery list",
                },
                {
                    "name": "check_consent_status",
                    "purpose": "Check active grant or request state",
                    "when_to_use": "Before request_consent for reuse; after request_consent for bounded polling",
                },
                {
                    "name": "request_consent",
                    "purpose": "Request or reuse user consent for a discovered scope",
                    "when_to_use": "Only after selecting a least-privilege discovered scope and checking status",
                },
                {
                    "name": "get_encrypted_scoped_export",
                    "purpose": "Fetch envelope metadata plus an authenticated binary ResourceLink, or decrypt locally in stdio",
                    "when_to_use": "After check_consent_status or request_consent returns granted and current",
                },
                {
                    "name": "validate_token",
                    "purpose": "Validate consent token signature, expiration, and scope",
                    "when_to_use": "Before using a token in non-MCP code paths",
                },
            ],
            "recommended_flow": [
                "Campaign/customer-experience agents should call prepare_campaign_context first; it performs the steps below and returns selected_scope, request_id, duration, status, and encrypted-export readiness.",
                "1. discover_user_domains(user_id) to get the exact scope strings for this One user (or search_user_scopes(user_id, query) to rank them by intent)",
                "2. choose the least-privilege discovered scope for the stated purpose",
                "3. check_consent_status(user_id, scope) to reuse existing approval before creating a request",
                "4. request_consent(user_id, scope, connector_public_key, connector_key_id, connector_wrapping_alg, expiry_hours, approval_timeout_minutes) only when status is not_found or requires_reconsent",
                "5. if status is pending, bounded-poll check_consent_status(user_id, scope, request_id); do not fabricate approval",
                "6. when granted, call get_encrypted_scoped_export; stdio decrypts locally, hosted connectors fetch the ResourceLink and decrypt outside model context",
            ],
            "public_tools": public_tools,
            "scopes_are_dynamic": True,
            "supported_scopes": "cap.one.invoke plus exact discovered attr.{domain}.{scope}.* authorities. Internal PKM/vault authorities are excluded.",
            "connector_capabilities": {
                "crypto_mode": "local for stdio; host for hosted MCP",
                "envelope_versions": [2],
                "wrapping_versions": ["X25519-AES256-GCM"],
                "resource_fetch_required": True,
                "inline_ciphertext": False,
            },
            "discover_scopes": "Call discover_user_domains(user_id) first to get this user's domains and scope strings. Backend uses GET /api/v1/user-scopes/{user_id} (developer-auth) and validates against PKM metadata + domain_registry metadata.",
            "server_backend": "Backend: FastAPI consent API. Set CONSENT_API_URL if not using default (e.g. http://localhost:8000).",
            "duration_controls": {
                "requestor_expiry_hours": "24 to 2160 hours; default 24",
                "approval_timeout_minutes": "5 to 1440 minutes; default 1440",
                "one_user_can_adjust_duration": True,
            },
            "consent_ui_required": "When request_consent returns pending, the user must approve in the Hussh app. Delivery is FCM-first in production. SSE consent waiting is disabled for this flow; MCP clients should use bounded status polling.",
        }
        return json.dumps(connector_info, indent=2)

    elif uri_str == "hushh://info/developer-api":
        developer_api_info = {
            "base_path": "/api/v1",
            "auth": {
                "developer_token_transport": "header_only",
                "developer_auth": "Authorization: Bearer <developer-token>",
                "remote_mcp_url_template": "/mcp/",
                "header_transport": "Authorization: Bearer <developer-token>",
            },
            "mcp_resources": [
                "hushh://info/server",
                "hushh://info/protocol",
                "hushh://info/connector",
                "hushh://info/developer-api",
                "hushh://info/consent-lifecycle",
            ],
            "developer_endpoints": [
                "/api/v1/list-scopes",
                "/api/v1/user-scopes/{user_id}",
                "/api/v1/request-consent",
                "/api/v1/consent-status",
                "/api/v1/scoped-export",
                "/api/v1/validate-token",
                "/api/v1/tool-catalog",
            ],
            "notes": [
                "Remote MCP clients must use Authorization: Bearer. Query-string credentials are rejected.",
                "Scopes are dynamic. Call user-scopes or discover_user_domains before requesting attr.{domain}.* access.",
                "Requestors can set expiry_hours and approval_timeout_minutes; the One user can approve with an adjusted duration.",
            ],
        }
        return json.dumps(developer_api_info, indent=2)

    elif uri_str == "hushh://info/consent-lifecycle":
        lifecycle = {
            "purpose": "Teach coding agents the expected Hussh MCP consent loop without hardcoded scope assumptions.",
            "steps": [
                {
                    "step": "discover",
                    "tool": "discover_user_domains",
                    "expectation": "Use the returned scopes for the specific One user. Do not invent domains or scopes.",
                },
                {
                    "step": "select_least_privilege",
                    "expectation": "Pick the narrowest discovered scope that fits the operator's stated purpose.",
                },
                {
                    "step": "reuse_check",
                    "tool": "check_consent_status",
                    "expectation": "Call with user_id and scope before request_consent. status=granted means use the returned token; status=not_found means create a request.",
                },
                {
                    "step": "request",
                    "tool": "request_consent",
                    "expectation": "Send connector_public_key, connector_key_id, connector_wrapping_alg, reason, expiry_hours, and approval_timeout_minutes. Exact pending requests are reused.",
                },
                {
                    "step": "bounded_poll",
                    "tool": "check_consent_status",
                    "expectation": "Poll with user_id, scope, and request_id for a bounded window. If still pending, tell the operator the One user must approve.",
                },
                {
                    "step": "fetch_export",
                    "tool": "get_encrypted_scoped_export",
                    "expectation": "Call only after granted/current status. Local stdio decrypts in-process. Hosted MCP returns envelope metadata and a standard ResourceLink; fetch with bearer auth and decrypt in the connector, never in model context.",
                },
            ],
            "response_contract": {
                "preferred_campaign_tool": "prepare_campaign_context",
                "always_surface_to_operator": [
                    "selected scope",
                    "category label",
                    "request id when available",
                    "requested duration",
                    "approval timeout",
                    "status: already granted, pending, denied, expired, or ready",
                ],
                "never_fabricate": [
                    "approval",
                    "plaintext user data",
                    "scope names",
                    "encrypted export readiness",
                ],
            },
            "examples": {
                "already_granted": {
                    "status": "granted",
                    "next": "fetch encrypted scoped export",
                },
                "pending": {
                    "status": "pending",
                    "next": "bounded-poll, then ask operator to wait for One approval",
                },
                "denied_or_expired": {
                    "status": "denied|expired|revoked|denied_recently",
                    "next": "do not fetch export",
                },
            },
            "sse": "Consent SSE waiting is disabled for this flow today; use bounded polling.",
        }
        return json.dumps(lifecycle, indent=2)

    else:
        logger.warning(f"❌ Unknown resource URI: {uri_str}")
        return json.dumps({"error": f"Unknown resource: {uri_str}"})
