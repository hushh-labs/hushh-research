# mcp/tools/definitions.py
"""
MCP Tool definitions (JSON schemas for Claude/Cursor).
"""

from mcp.types import Tool


def get_tool_definitions(allowed_tool_names: set[str] | None = None) -> list[Tool]:
    """
    Return all Hushh consent tools for MCP hosts.

    Compliance: MCP tools/list specification
    Privacy: Tools enforce consent before any data access
    """
    definitions = [
        # Tool 1: Request Consent
        Tool(
            name="request_consent",
            description=(
                "🔐 Request consent from a user to access their personal data. "
                "Returns a cryptographically signed consent token (HCT format) if granted. "
                "This MUST be called before accessing any user data. "
                "The token contains: user_id, scope, expiration, HMAC-SHA256 signature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's unique identifier or Email Address (e.g., user@example.com)",
                    },
                    "scope": {
                        "type": "string",
                        "description": (
                            "Data scope to access. Use pkm.read for the full PKM, "
                            "or one of the dynamic attr scopes discovered for this user. "
                            "Domains per user come from discover_user_domains(user_id). Each scope requires separate consent."
                        ),
                        "examples": [
                            "pkm.read",
                            "attr.{domain}.*",
                            "attr.{domain}.{subintent}.*",
                            "attr.{domain}.{path}",
                        ],
                    },
                    "reason": {
                        "type": "string",
                        "description": "Human-readable reason for the request (transparency)",
                    },
                },
                "required": ["user_id", "scope"],
            },
        ),
        # Tool 2: Validate Token
        Tool(
            name="validate_token",
            description=(
                "✅ Validate a consent token's cryptographic signature, expiration, and scope. "
                "Use this to verify a token is valid before attempting data access. "
                "Checks: HMAC-SHA256 signature, not expired, not revoked, scope matches."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "token": {
                        "type": "string",
                        "description": "The consent token string (format: HCT:base64.signature)",
                    },
                    "expected_scope": {
                        "type": "string",
                        "description": "Optional: verify token has this specific scope",
                    },
                },
                "required": ["token"],
            },
        ),
        # Tool 3: Get Scoped Data
        Tool(
            name="get_scoped_data",
            description=(
                "📦 Retrieve the approved scoped export for any valid consent token. "
                "This is the recommended dynamic data-access tool for all new integrations. "
                "The returned payload already reflects the exact scope the user approved."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's unique identifier or email address",
                    },
                    "consent_token": {
                        "type": "string",
                        "description": "Valid consent token for the approved scope",
                    },
                    "expected_scope": {
                        "type": "string",
                        "description": (
                            "Optional safety check. Use a discovered scope string if the caller "
                            "wants to verify the token is scoped exactly as expected."
                        ),
                    },
                },
                "required": ["user_id", "consent_token"],
            },
        ),
        # Tool 4: Delegate to Agent (TrustLink)
        Tool(
            name="delegate_to_agent",
            description=(
                "🔗 Create a TrustLink to delegate a task to another agent (A2A). "
                "This enables agent-to-agent communication with cryptographic proof "
                "that the delegation was authorized by the user."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "from_agent": {
                        "type": "string",
                        "description": "Agent ID making the delegation (e.g., 'orchestrator')",
                    },
                    "to_agent": {
                        "type": "string",
                        "description": "Target agent ID",
                        "enum": [
                            "agent_food_dining",
                            "agent_professional_profile",
                            "agent_identity",
                        ],
                    },
                    "scope": {"type": "string", "description": "Scope being delegated"},
                    "user_id": {
                        "type": "string",
                        "description": "User authorizing the delegation (or Email Address)",
                    },
                },
                "required": ["from_agent", "to_agent", "scope", "user_id"],
            },
        ),
        # Tool 5: List Available Scopes
        Tool(
            name="list_scopes",
            description=(
                "📋 List canonical dynamic scope patterns and their descriptions. "
                "Use this as a reference, but always call discover_user_domains before requesting attr scopes."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        # Tool 6: Discover user's domains and scopes (per-user discovery)
        Tool(
            name="discover_user_domains",
            description=(
                "Discover which domains a user has and the scope strings to request. "
                "Call this before request_consent to know which scopes "
                "are available for that user. Returns user_id, list of domain keys, and available_scopes."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's unique identifier (Firebase UID or email to resolve)",
                    }
                },
                "required": ["user_id"],
            },
        ),
        # Tool 7: Check Consent Status (Production Flow)
        Tool(
            name="check_consent_status",
            description=(
                "🔄 Check the status of a pending consent request. "
                "Use this after request_consent returns 'pending' status. "
                "Poll this until status changes to 'granted' or 'denied'. "
                "Returns the consent token when approved."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's unique identifier or Email Address",
                    },
                    "scope": {
                        "type": "string",
                        "description": "The scope that was requested. Preferred when checking app+scope status.",
                    },
                    "request_id": {
                        "type": "string",
                        "description": "Optional request_id returned by request_consent for more precise polling.",
                    },
                },
                "required": ["user_id", "scope"],
            },
        ),
        Tool(
            name="list_ria_profiles",
            description=(
                "List discoverable RIA marketplace profiles (read-only). "
                "Supports query, firm filter, and verification status filter."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "firm": {"type": "string"},
                    "verification_status": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                },
                "required": [],
            },
        ),
        Tool(
            name="get_ria_profile",
            description="Get a discoverable RIA marketplace profile by RIA profile ID (read-only).",
            inputSchema={
                "type": "object",
                "properties": {
                    "ria_id": {"type": "string"},
                },
                "required": ["ria_id"],
            },
        ),
        Tool(
            name="list_marketplace_investors",
            description=(
                "List discoverable investor marketplace profiles (opt-in app investors only, read-only)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                },
                "required": [],
            },
        ),
        Tool(
            name="get_ria_verification_status",
            description=(
                "Get RIA verification status for a user_id (read-only). "
                "Requires a valid VAULT_OWNER consent token for the same user."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {"type": "string"},
                    "consent_token": {"type": "string"},
                },
                "required": ["user_id", "consent_token"],
            },
        ),
        Tool(
            name="get_ria_client_access_summary",
            description=(
                "Get relationship/access summary for an RIA user (read-only). "
                "Requires a valid VAULT_OWNER consent token for the same user."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {"type": "string"},
                    "consent_token": {"type": "string"},
                },
                "required": ["user_id", "consent_token"],
            },
        ),
    ]
    if allowed_tool_names is None:
        return definitions
    return [tool for tool in definitions if tool.name in allowed_tool_names]
