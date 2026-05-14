# mcp/tools/definitions.py
"""
MCP Tool definitions (JSON schemas for Claude/Cursor).
"""

from mcp.types import Tool


def get_tool_definitions(allowed_tool_names: set[str] | None = None) -> list[Tool]:
    """
    Return all Hussh consent tools for MCP hosts.

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
                "The token contains: user_id, scope, expiration, HMAC-SHA256 signature. "
                "If a broader active grant already covers the requested scope, the existing token is reused "
                "and the response exposes both requested_scope and granted_scope."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's Firebase UID, registered email, or registered E.164 phone number",
                    },
                    "country_iso2": {
                        "type": "string",
                        "description": (
                            "Optional ISO country hint for national phone numbers. "
                            "Examples: US, GB, IN."
                        ),
                    },
                    "country": {
                        "type": "string",
                        "description": (
                            "Optional country name or shortform for national phone numbers. "
                            "Examples: United States, USA, UK."
                        ),
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
                    "approval_timeout_minutes": {
                        "type": "integer",
                        "description": (
                            "How long the request remains actionable before timing out. "
                            "Public range: 5 to 1440 minutes. Default: 1440."
                        ),
                        "minimum": 5,
                        "maximum": 1440,
                    },
                    "expiry_hours": {
                        "type": "integer",
                        "description": (
                            "How long the granted consent token remains valid after approval. "
                            "Public range: 24 to 2160 hours. Default: 24."
                        ),
                        "minimum": 24,
                        "maximum": 2160,
                    },
                    "connector_public_key": {
                        "type": "string",
                        "description": (
                            "Base64-encoded X25519 public key owned by the external connector. "
                            "Hussh wraps the export key to this public key and never manages the private key."
                        ),
                    },
                    "connector_key_id": {
                        "type": "string",
                        "description": "Stable caller-managed identifier for the connector public key.",
                    },
                    "connector_wrapping_alg": {
                        "type": "string",
                        "description": "Connector key-wrapping algorithm. Use X25519-AES256-GCM.",
                    },
                    "scope_bundle": {
                        "type": "string",
                        "description": (
                            "Pre-defined scope bundle name. Use instead of 'scope' for common use cases. "
                            "Available: financial_overview, full_portfolio_review, risk_assessment, "
                            "health_wellness, lifestyle_preferences."
                        ),
                    },
                },
                "required": [
                    "user_id",
                    "connector_public_key",
                    "connector_key_id",
                    "connector_wrapping_alg",
                ],
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
        # Tool 3: Get Encrypted Scoped Export
        Tool(
            name="get_encrypted_scoped_export",
            description=(
                "📦 Retrieve the encrypted wrapped-key export for any valid consent token. "
                "This is the recommended dynamic data-access tool for all new integrations. "
                "Hussh returns ciphertext plus wrapped key metadata only; the external connector decrypts client-side."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's Firebase UID, registered email, or registered E.164 phone number",
                    },
                    "country_iso2": {
                        "type": "string",
                        "description": (
                            "Optional ISO country hint for national phone numbers. "
                            "Examples: US, GB, IN."
                        ),
                    },
                    "country": {
                        "type": "string",
                        "description": (
                            "Optional country name or shortform for national phone numbers. "
                            "Examples: United States, USA, UK."
                        ),
                    },
                    "consent_token": {
                        "type": "string",
                        "description": "Valid consent token for the approved scope",
                    },
                    "expected_scope": {
                        "type": "string",
                        "description": (
                            "Optional safety check. Pass the original discovered/requested scope here. "
                            "If the token came from a reused broader grant, the server returns the canonical broader encrypted export "
                            "and echoes expected_scope so the connector can narrow after decrypting."
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
                        "description": "User authorizing the delegation (Firebase UID, registered email, or registered E.164 phone number)",
                    },
                    "country_iso2": {
                        "type": "string",
                        "description": (
                            "Optional ISO country hint for national phone numbers. "
                            "Examples: US, GB, IN."
                        ),
                    },
                    "country": {
                        "type": "string",
                        "description": (
                            "Optional country name or shortform for national phone numbers. "
                            "Examples: United States, USA, UK."
                        ),
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
                        "description": "The user's Firebase UID, registered email, or registered E.164 phone number",
                    },
                    "country_iso2": {
                        "type": "string",
                        "description": (
                            "Optional ISO country hint for national phone numbers. "
                            "Examples: US, GB, IN."
                        ),
                    },
                    "country": {
                        "type": "string",
                        "description": (
                            "Optional country name or shortform for national phone numbers. "
                            "Examples: United States, USA, UK."
                        ),
                    },
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
                        "description": "The user's Firebase UID, registered email, or registered E.164 phone number",
                    },
                    "country_iso2": {
                        "type": "string",
                        "description": (
                            "Optional ISO country hint for national phone numbers. "
                            "Examples: US, GB, IN."
                        ),
                    },
                    "country": {
                        "type": "string",
                        "description": (
                            "Optional country name or shortform for national phone numbers. "
                            "Examples: United States, USA, UK."
                        ),
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
        # ── Kai Voice Action Tools ─────────────────────────────────────────────
        # These tools are triggered by the Kai voice agent to perform discrete
        # UI actions inside the Kai mobile application.
        # Each tool returns a KaiAction payload with:
        #   action_id   – canonical action identifier (matches kai-action-gateway)
        #   message     – human-readable voice confirmation
        #   slots       – optional structured parameters for the mobile client
        #   completion_mode – "route_settle" | "background_start" | "none"
        # ──────────────────────────────────────────────────────────────────────
        Tool(
            name="kai_analyze_stock",
            description=(
                "📊 Start a stock analysis inside the Kai app for a given ticker symbol or company name. "
                "The analysis runs in the background and the result is shown in the Analysis History tab. "
                "Use this when the user says 'analyze Apple', 'run analysis on TSLA', etc. "
                "Returns action_id=analysis.start with the resolved ticker in slots."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": (
                            "Stock ticker (e.g. AAPL) or company name (e.g. Apple). "
                            "Company names are resolved to tickers automatically."
                        ),
                    },
                    "analysis_type": {
                        "type": "string",
                        "enum": ["fundamental", "sentiment", "valuation", "full"],
                        "description": "Type of analysis to run. Defaults to 'full'.",
                    },
                },
                "required": ["symbol"],
            },
        ),
        Tool(
            name="kai_open_dashboard",
            description=(
                "📈 Navigate to the Portfolio / Dashboard tab in the Kai app. "
                "Use when the user says 'open dashboard', 'show my portfolio', 'go to portfolio', etc. "
                "Returns action_id=route.kai_dashboard."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_open_import",
            description=(
                "📥 Navigate to the Import / Upload Statement tab in the Kai app. "
                "Use when the user says 'import', 'upload statement', 'scan portfolio statement', etc. "
                "Returns action_id=route.kai_import."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_open_history",
            description=(
                "🕒 Navigate to the Analysis History tab in the Kai app. "
                "Use when the user says 'analysis history', 'show my history', 'open history', etc. "
                "Returns action_id=route.analysis_history. "
                "Optional: specify a sub-tab (history, debate, summary, transcript)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "tab": {
                        "type": "string",
                        "enum": ["history", "debate", "summary", "transcript"],
                        "description": "Sub-tab to open. Defaults to 'history'.",
                    },
                },
                "required": [],
            },
        ),
        Tool(
            name="kai_open_consent",
            description=(
                "🔐 Navigate to the Consents / Privacy tab in the Kai app. "
                "Use when the user says 'consents', 'privacy', 'data permissions', etc. "
                "Returns action_id=route.consents."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_open_profile",
            description=(
                "👤 Navigate to the Profile tab in the Kai app. "
                "Use when the user says 'profile', 'my profile', 'open my account', etc. "
                "Returns action_id=route.profile."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_open_optimize",
            description=(
                "⚡ Navigate to the Portfolio Optimization tab in the Kai app. "
                "Use when the user says 'optimize', 'optimize my portfolio', 'portfolio optimization', etc. "
                "Returns action_id=route.kai_optimize."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_open_home",
            description=(
                "🏠 Navigate to the Market / Home tab in the Kai app. "
                "Use when the user says 'home', 'market', 'go home', 'back to market', etc. "
                "Returns action_id=route.kai_home."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_navigate_back",
            description=(
                "⬅ Navigate back one screen in the Kai app. "
                "Use when the user says 'go back', 'back', 'previous screen', etc. "
                "Returns action_id=route.back."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_resume_active_analysis",
            description=(
                "▶ Resume the currently running analysis in the Kai app. "
                "Use when the user says 'resume analysis', 'continue analysis', 'open active analysis', etc. "
                "Returns action_id=analysis.resume_active."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="kai_cancel_active_analysis",
            description=(
                "⏹ Cancel / stop the currently running analysis in the Kai app. "
                "Use when the user says 'cancel analysis', 'stop analysis', 'stop the analysis', etc. "
                "Returns action_id=analysis.cancel_active."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
    ]
    if allowed_tool_names is None:
        return definitions
    return [tool for tool in definitions if tool.name in allowed_tool_names]
