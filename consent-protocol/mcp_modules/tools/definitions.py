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
        # Tool 1: High-level campaign/customer-experience consent loop
        Tool(
            name="prepare_campaign_context",
            description=(
                "Recommended high-level tool for external ads, campaign, and customer-experience agents. "
                "Use this before low-level consent tools when the operator gives a user identifier and a "
                "campaign or personalization goal. It discovers the user's available dynamic scopes, chooses "
                "the least-privilege useful scope, checks for an existing grant, reuses active grants, creates "
                "or reuses a pending request only when needed, performs bounded polling, and fetches encrypted "
                "export metadata after approval. It never returns plaintext user data or raw ciphertext; a "
                "local connector with the private key must decrypt before generating preference summaries."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "The user's Firebase UID, registered email, or registered phone number.",
                    },
                    "country_iso2": {
                        "type": "string",
                        "description": "Optional ISO country hint for national phone numbers, such as US, GB, or IN.",
                    },
                    "country": {
                        "type": "string",
                        "description": "Optional country hint for national phone numbers, such as United States or UK.",
                    },
                    "campaign_goal": {
                        "type": "string",
                        "description": (
                            "Plain-English campaign/customer-experience purpose. Example: "
                            "'help make the next customer experience more relevant for someone considering a trip'."
                        ),
                    },
                    "surface": {
                        "type": "string",
                        "description": "Campaign surface or experience type. Defaults to customer_experience.",
                        "examples": [
                            "customer_experience",
                            "search",
                            "performance_max",
                            "search_pmax",
                        ],
                    },
                    "preferred_context": {
                        "type": "string",
                        "description": (
                            "Optional explicit context preference when the operator asks for one. "
                            "Examples: auto, travel, shopping, location, food, financial."
                        ),
                    },
                    "approval_timeout_minutes": {
                        "type": "integer",
                        "description": "How long the request remains actionable before timing out. Public range: 5 to 1440 minutes. Default: 1440.",
                        "minimum": 5,
                        "maximum": 1440,
                    },
                    "expiry_hours": {
                        "type": "integer",
                        "description": "How long the granted consent remains valid after approval. Public range: 24 to 2160 hours. Default: 24.",
                        "minimum": 24,
                        "maximum": 2160,
                    },
                    "poll_seconds": {
                        "type": "integer",
                        "description": "Bounded polling window after a pending request is created or reused. Default: 90; maximum: 90.",
                        "minimum": 0,
                        "maximum": 90,
                    },
                    "connector_public_key": {
                        "type": "string",
                        "description": (
                            "Base64-encoded X25519 public key owned by the external/local connector. "
                            "Required when no active grant exists."
                        ),
                    },
                    "connector_key_id": {
                        "type": "string",
                        "description": "Stable caller-managed identifier for the connector public key.",
                    },
                    "connector_wrapping_alg": {
                        "type": "string",
                        "description": "Connector key-wrapping algorithm. Use X25519-AES256-GCM.",
                        "enum": ["X25519-AES256-GCM"],
                    },
                    "fetch_export_metadata": {
                        "type": "boolean",
                        "description": "When granted, fetch safe encrypted-export metadata without returning ciphertext. Default: true.",
                    },
                },
                "required": ["user_id"],
            },
        ),
        # Tool 2: Request Consent
        Tool(
            name="request_consent",
            description=(
                "🔐 Request consent from a user to access their personal data. "
                "Use this after discover_user_domains and a scope-based check_consent_status call. "
                "Returns a cryptographically signed consent token (HCT format) if already granted, "
                "or a pending request id if the One user must approve in the Hussh app. "
                "If an exact or broader active grant already covers the requested scope, the existing token "
                "is reused and the response exposes requested_scope, granted_scope, coverage_kind, and "
                "covered_by_existing_grant. If an exact pending request already exists, it is reused."
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
                        "enum": ["X25519-AES256-GCM"],
                    },
                    "scope_bundle": {
                        "type": "string",
                        "description": (
                            "Pre-defined scope bundle name. Use instead of 'scope' for common use cases. "
                            "Available: financial_overview, full_portfolio_review, risk_assessment, "
                            "health_wellness, lifestyle_preferences."
                        ),
                        "enum": [
                            "financial_overview",
                            "full_portfolio_review",
                            "risk_assessment",
                            "health_wellness",
                            "lifestyle_preferences",
                        ],
                    },
                    "offer": {
                        "type": "object",
                        "description": (
                            "Optional priced-consent offer — the consent reverse-auction bid. "
                            "A Demand Agent (a brand/advertiser's agent) attaches an offer to PAY the "
                            "user for scoped, time-boxed access to their consented context. The bid is "
                            "recorded on the consent request and surfaces to the user side, where their "
                            "reserve price clears it. Settlement happens via AP2 at the money boundary on "
                            "approval — this call authorizes the read and carries the bid; it never moves money."
                        ),
                        "properties": {
                            "bid_amount": {
                                "type": "number",
                                "exclusiveMinimum": 0,
                                "maximum": 1000000,
                                "description": "Amount offered to the user for this scoped access.",
                            },
                            "currency": {
                                "type": "string",
                                "description": "ISO-4217 currency code (3 letters). Default USD.",
                            },
                            "offer_summary": {
                                "type": "string",
                                "description": "Short human-readable description of the offer/deal (transparency).",
                            },
                            "settlement_ref": {
                                "type": "string",
                                "description": (
                                    "Optional correlation id linking the cleared consent receipt to the "
                                    "AP2 Payment Mandate that will settle the bid."
                                ),
                            },
                        },
                        "required": ["bid_amount"],
                    },
                },
                "required": [
                    "user_id",
                    "connector_public_key",
                    "connector_key_id",
                    "connector_wrapping_alg",
                ],
                "anyOf": [{"required": ["scope"]}, {"required": ["scope_bundle"]}],
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
                "🔄 Check consent status for a user/scope pair or a specific request id. "
                "Call this before request_consent to reuse an existing active grant, then use it "
                "for bounded polling after request_consent returns pending. "
                "If a broader active grant covers the scope, the response returns status=granted "
                "with requested_scope/granted_scope coverage metadata. If no matching grant or "
                "request exists, status is not_found."
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
                "required": ["user_id"],
                "anyOf": [{"required": ["scope"]}, {"required": ["request_id"]}],
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
