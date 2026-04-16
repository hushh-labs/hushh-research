# hushh_mcp/constants.py

from __future__ import annotations

from enum import Enum
from typing import Optional

# ==================== Consent Scopes ====================


class ConsentScope(str, Enum):
    """
    Consent scopes for MCP-compliant data access.

    Design Principles:
    - VAULT_OWNER grants full PKM access (user's own data)
    - Dynamic attr.{domain}.{key} scopes are validated via DynamicScopeGenerator
    - Static operation scopes are defined in this enum

    Dynamic Scopes (NOT in enum - validated dynamically):
    - attr.{domain}.{attribute} - e.g., attr.financial.holdings
    - attr.{domain}.* - Wildcard for entire domain
    """

    # ==================== VAULT OWNER (Full Access) ====================
    # "Master Scope" granted ONLY via BYOK login.
    # Never granted to external agents.
    VAULT_OWNER = "vault.owner"

    # ==================== PORTFOLIO OPERATIONS ====================
    PORTFOLIO_IMPORT = "portfolio.import"
    PORTFOLIO_ANALYZE = "portfolio.analyze"
    PORTFOLIO_READ = "portfolio.read"
    BROKERAGE_TRANSFER_WRITE = "brokerage.transfer.write"

    # ==================== CHAT HISTORY ====================
    CHAT_HISTORY_READ = "chat.history.read"
    CHAT_HISTORY_WRITE = "chat.history.write"

    # ==================== EMBEDDINGS (Similarity Matching) ====================
    EMBEDDING_PROFILE_READ = "embedding.profile.read"
    EMBEDDING_PROFILE_COMPUTE = "embedding.profile.compute"

    # ==================== PKM OPERATIONS ====================
    PKM_READ = "pkm.read"
    PKM_WRITE = "pkm.write"
    PKM_METADATA = "pkm.metadata"

    # ==================== KAI AGENT OPERATIONS ====================
    AGENT_KAI_ANALYZE = "agent.kai.analyze"
    AGENT_KAI_DEBATE = "agent.kai.debate"
    AGENT_KAI_INFER = "agent.kai.infer"
    AGENT_KAI_CHAT = "agent.kai.chat"
    AGENT_KAI_EXECUTE = "agent.kai.execute"  # fix #408 — was missing, causing AttributeError

    # ==================== EXTERNAL DATA SOURCES ====================
    # Hybrid mode - per-request consent
    EXTERNAL_SEC_FILINGS = "external.sec.filings"
    EXTERNAL_NEWS_API = "external.news.api"
    EXTERNAL_MARKET_DATA = "external.market.data"
    EXTERNAL_RENAISSANCE = "external.renaissance.data"

    # Data access uses pkm.read, pkm.write, and dynamic attr.{domain}.* scopes.

    @classmethod
    def list(cls):
        """List all static scopes."""
        return [scope.value for scope in cls]

    @classmethod
    def is_dynamic_scope(cls, scope: str) -> bool:
        """
        Check if a scope is a dynamic attr.* scope.

        Dynamic scopes follow the pattern: attr.{domain}.{attribute}
        They are NOT defined in this enum but validated via DynamicScopeGenerator.
        """
        return scope.startswith("attr.")

    @classmethod
    def is_wildcard_scope(cls, scope: str) -> bool:
        """Check if a scope is a wildcard pattern (ends with .*)."""
        return scope.endswith(".*")

    @classmethod
    def validate(cls, scope: str, user_id: Optional[str] = None) -> bool:
        """
        Validate a scope - static or dynamic.

        Args:
            scope: The scope string to validate
            user_id: Optional user ID for dynamic scope validation

        Returns:
            True if the scope is valid
        """
        # Check static scopes first
        if scope in [s.value for s in cls]:
            return True

        # Check dynamic scopes
        if cls.is_dynamic_scope(scope):
            # Import here to avoid circular dependency
            from hushh_mcp.consent.scope_generator import get_scope_generator

            generator = get_scope_generator()

            # Parse and validate format
            domain, attr_key, is_wildcard = generator.parse_scope(scope)
            if domain is None:
                return False

            # If user_id provided, validate against stored attributes
            if user_id:
                import asyncio

                try:
                    loop = asyncio.get_event_loop()
                    return loop.run_until_complete(generator.validate_scope(scope, user_id))
                except RuntimeError:
                    # No event loop, just validate format
                    return True

            return True

        return False

    @classmethod
    def check_access(
        cls,
        requested_scope: str,
        granted_scopes: list[str],
    ) -> bool:
        """
        Check if a requested scope is covered by granted scopes.

        Handles:
        - Direct matches
        - Wildcard matches (attr.financial.* covers attr.financial.holdings)
        - VAULT_OWNER grants all access

        Args:
            requested_scope: The scope being requested
            granted_scopes: List of scopes that have been granted

        Returns:
            True if access should be granted
        """
        # VAULT_OWNER grants everything
        if cls.VAULT_OWNER.value in granted_scopes:
            return True

        # Direct match
        if requested_scope in granted_scopes:
            return True

        # Check wildcard matches for dynamic scopes
        if cls.is_dynamic_scope(requested_scope):
            from hushh_mcp.consent.scope_generator import get_scope_generator

            generator = get_scope_generator()

            for granted in granted_scopes:
                if generator.matches_wildcard(requested_scope, granted):
                    return True

        return False

    @classmethod
    def operation_scopes(cls):
        """Return all operation scopes (non-attribute)."""
        return [
            cls.PORTFOLIO_IMPORT,
            cls.PORTFOLIO_ANALYZE,
            cls.PORTFOLIO_READ,
            cls.BROKERAGE_TRANSFER_WRITE,
            cls.CHAT_HISTORY_READ,
            cls.CHAT_HISTORY_WRITE,
            cls.EMBEDDING_PROFILE_READ,
            cls.EMBEDDING_PROFILE_COMPUTE,
            cls.PKM_READ,
            cls.PKM_WRITE,
            cls.PKM_METADATA,
        ]

    @classmethod
    def agent_scopes(cls):
        """Return all agent operation scopes."""
        return [
            cls.AGENT_KAI_ANALYZE,
            cls.AGENT_KAI_DEBATE,
            cls.AGENT_KAI_INFER,
            cls.AGENT_KAI_CHAT,
        ]

    @classmethod
    def external_scopes(cls):
        """Return all external data source scopes."""
        return [
            cls.EXTERNAL_SEC_FILINGS,
            cls.EXTERNAL_NEWS_API,
            cls.EXTERNAL_MARKET_DATA,
            cls.EXTERNAL_RENAISSANCE,
        ]


# ==================== Agent Configuration ====================

# Port assignments for agent-to-agent communication
AGENT_PORTS = {
    "agent_orchestrator": 10000,
    "agent_kai": 10005,  # Kai investment analysis agent
}

# ==================== Token & Link Prefixes ====================

CONSENT_TOKEN_PREFIX = "HCT"  # noqa: S105 - Hushh Consent Token
TRUST_LINK_PREFIX = "HTL"  # noqa: S105 - Hushh Trust Link
AGENT_ID_PREFIX = "agent_"
USER_ID_PREFIX = "user_"

# ==================== Defaults (used if .env fails to load) ====================

# These are fallbacks — real defaults should come from config.py which loads from .env
DEFAULT_CONSENT_TOKEN_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7  # 7 days
DEFAULT_TRUST_LINK_EXPIRY_MS = 1000 * 60 * 60 * 24 * 30  # 30 days

# ==================== Gemini Model Configuration ====================

# Standard model for general LLM operations across the codebase.
GEMINI_MODEL = "gemini-3.1-pro-preview"

# Full path format (for ADK and direct API calls)
GEMINI_MODEL_FULL = "models/gemini-3.1-pro-preview"

# Vertex AI model (for Google Cloud deployments)
GEMINI_MODEL_VERTEX = "gemini-3.1-pro-preview"

# ==================== Kai Portfolio Import Defaults ====================

# Portfolio import extraction is prompt-first and optimized for lower latency.
KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL = "gemini-3-flash-preview"
KAI_PORTFOLIO_IMPORT_ENABLE_THINKING = True
KAI_PORTFOLIO_IMPORT_THINKING_LEVEL = "LOW"
KAI_PORTFOLIO_IMPORT_MAX_OUTPUT_TOKENS = 32768

# ==================== Kai LLM Deterministic Runtime ====================

# Keep Kai decision-bearing generation deterministic to reduce user confusion.
KAI_LLM_TEMPERATURE = 0.0
# Default output budget for Kai text-generation helpers.
KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT = 16384
# Larger output budget for long-form generation paths.
KAI_LLM_MAX_OUTPUT_TOKENS_LARGE = 32768
# Optimize stream output budget.
KAI_OPTIMIZE_MAX_OUTPUT_TOKENS = 16384
# Debate synthesis output budget.
KAI_SYNTHESIS_MAX_OUTPUT_TOKENS = 8192
# Keep reasoning mode enabled for optimize/debate quality.
KAI_LLM_THINKING_ENABLED = True
# Generic default for non-import LLM paths.
KAI_LLM_THINKING_LEVEL = "MEDIUM"
# Stream thought chunks for telemetry/progress surfaces.
KAI_LLM_STREAM_INCLUDE_THOUGHTS = True
# Optimize stream hard timeout (seconds).
KAI_OPTIMIZE_STREAM_TIMEOUT_SECONDS = 240

# ==================== Exports ====================

__all__ = [
    "ConsentScope",
    "CONSENT_TOKEN_PREFIX",
    "TRUST_LINK_PREFIX",
    "AGENT_ID_PREFIX",
    "USER_ID_PREFIX",
    "DEFAULT_CONSENT_TOKEN_EXPIRY_MS",
    "DEFAULT_TRUST_LINK_EXPIRY_MS",
    "AGENT_PORTS",
    "GEMINI_MODEL",
    "GEMINI_MODEL_FULL",
    "GEMINI_MODEL_VERTEX",
    "KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL",
    "KAI_PORTFOLIO_IMPORT_ENABLE_THINKING",
    "KAI_PORTFOLIO_IMPORT_THINKING_LEVEL",
    "KAI_PORTFOLIO_IMPORT_MAX_OUTPUT_TOKENS",
    "KAI_LLM_TEMPERATURE",
    "KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT",
    "KAI_LLM_MAX_OUTPUT_TOKENS_LARGE",
    "KAI_OPTIMIZE_MAX_OUTPUT_TOKENS",
    "KAI_SYNTHESIS_MAX_OUTPUT_TOKENS",
    "KAI_LLM_THINKING_ENABLED",
    "KAI_LLM_THINKING_LEVEL",
    "KAI_LLM_STREAM_INCLUDE_THOUGHTS",
    "KAI_OPTIMIZE_STREAM_TIMEOUT_SECONDS",
]
