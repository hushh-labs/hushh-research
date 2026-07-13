# hushh_mcp/constants.py

from __future__ import annotations

import re
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
    BROKERAGE_TRANSFER_WRITE = "brokerage.transfer.write"

    # ==================== PKM OPERATIONS ====================
    # Internal projection authorities. Never expose these through developer
    # scope discovery or accept them from an external consent request.
    PKM_READ = "pkm.read"
    PKM_WRITE = "pkm.write"

    # ==================== AGENT OPERATIONS ====================
    # Invocation is control-plane authority only. It may create or resume a One
    # task, but it never grants PKM reads, specialist data access, or mutations.
    CAP_ONE_INVOKE = "cap.one.invoke"

    AGENT_KAI_ANALYZE = "agent.kai.analyze"

    AGENT_NAV_REVIEW = "agent.nav.review"

    AGENT_KYC_PROCESS = "agent.kyc.process"
    AGENT_KYC_REDRAFT_LLM = "agent.kyc.redraft.llm"

    # ==================== LIVE LOCATION CAPABILITIES ====================
    # Capability scopes for One Location Agent. These are workflow/action
    # scopes, not durable attr.location.* PKM scopes.
    CAP_LOCATION_LIVE_SHARE = "cap.location.live.share"
    CAP_LOCATION_LIVE_VIEW = "cap.location.live.view"
    CAP_LOCATION_LIVE_REQUEST = "cap.location.live.request"
    CAP_LOCATION_LIVE_REVOKE = "cap.location.live.revoke"
    CAP_LOCATION_LIVE_REFER_REQUEST = "cap.location.live.refer_request"

    # ============ MARKETPLACE / PERSONAL INFORMATION AGENT CAPABILITIES ============
    # Capability scopes for the One Personal Information Agent — the marketplace
    # chatbot that lets an owner query, publish, and manage their own PKM data
    # slices. Workflow/action scopes, not durable attr.* PKM scopes. VIEW is
    # read-only; MANAGE gates owner-confirmed publication and access changes.
    CAP_PKM_MARKETPLACE_VIEW = "cap.pkm.marketplace.view"
    CAP_PKM_MARKETPLACE_MANAGE = "cap.pkm.marketplace.manage"

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
        return bool(_DYNAMIC_SCOPE_PATTERN.fullmatch(str(scope or "").strip()))

    @classmethod
    def is_external_requestable_scope(cls, scope: str) -> bool:
        """Return whether an external app may request ``scope``.

        External information authority is always a discovered semantic branch
        (``attr.<domain>.<scope>.*``). Exact manifest paths, broad PKM
        authorities, and vault authority are internal projection details.
        """
        normalized = str(scope or "").strip()
        return normalized == cls.CAP_ONE_INVOKE.value or bool(
            _EXTERNAL_DYNAMIC_SCOPE_PATTERN.fullmatch(normalized)
        )

    @classmethod
    def is_retired_scope(cls, scope: str) -> bool:
        """Return whether ``scope`` is a historical, non-authorizing value."""
        return str(scope or "").strip() in RETIRED_SCOPE_VALUES

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
        if scope in ACTIVE_RESERVED_SCOPE_VALUES:
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
            cls.BROKERAGE_TRANSFER_WRITE,
            cls.PKM_READ,
            cls.PKM_WRITE,
        ]

    @classmethod
    def agent_scopes(cls):
        """Return all agent operation scopes."""
        return [
            cls.AGENT_KAI_ANALYZE,
            cls.AGENT_NAV_REVIEW,
            cls.AGENT_KYC_PROCESS,
            cls.AGENT_KYC_REDRAFT_LLM,
        ]

    @classmethod
    def capability_scopes(cls):
        """Return workflow capability scopes that are not durable attr.* PKM scopes."""
        return [
            cls.CAP_ONE_INVOKE,
            cls.CAP_LOCATION_LIVE_SHARE,
            cls.CAP_LOCATION_LIVE_VIEW,
            cls.CAP_LOCATION_LIVE_REQUEST,
            cls.CAP_LOCATION_LIVE_REVOKE,
            cls.CAP_LOCATION_LIVE_REFER_REQUEST,
            cls.CAP_PKM_MARKETPLACE_VIEW,
            cls.CAP_PKM_MARKETPLACE_MANAGE,
        ]

    @classmethod
    def external_scopes(cls):
        """Return reserved scopes that may be requested by external apps.

        Dynamic ``attr.*`` authorities are discovered per user and therefore
        cannot be enumerated here.
        """
        return [cls.CAP_ONE_INVOKE]


# ==================== Scope Policy v2 ====================

SCOPE_POLICY_VERSION = 2

# Slugs are deterministic, lowercase, path-safe identifiers. Compatibility
# parsing still accepts domain-level and exact attr paths internally; the
# external request surface is deliberately narrower and accepts one semantic
# branch wildcard only.
_SCOPE_SLUG = r"[a-z](?:[a-z0-9_]{0,62}[a-z0-9])?"
_DYNAMIC_SCOPE_PATTERN = re.compile(
    rf"attr\.{_SCOPE_SLUG}\.(?:\*|{_SCOPE_SLUG}(?:\.{_SCOPE_SLUG})*(?:\.\*)?)"
)
_EXTERNAL_DYNAMIC_SCOPE_PATTERN = re.compile(rf"attr\.{_SCOPE_SLUG}\.{_SCOPE_SLUG}\.\*")

ACTIVE_RESERVED_SCOPE_VALUES: frozenset[str] = frozenset(scope.value for scope in ConsentScope)
INTERNAL_ONLY_SCOPE_VALUES: frozenset[str] = frozenset(
    {
        ConsentScope.VAULT_OWNER.value,
        ConsentScope.PKM_READ.value,
        ConsentScope.PKM_WRITE.value,
    }
)
EXTERNAL_REQUESTABLE_RESERVED_SCOPE_VALUES: frozenset[str] = frozenset(
    {ConsentScope.CAP_ONE_INVOKE.value}
)

# These values remain valid historical audit text only. They are deliberately
# absent from ConsentScope so no active enforcement path can authorize them.
RETIRED_SCOPE_VALUES: frozenset[str] = frozenset(
    {
        "agent.one.orchestrate",
        "portfolio.analyze",
        "portfolio.read",
        "chat.history.read",
        "chat.history.write",
        "embedding.profile.read",
        "embedding.profile.compute",
        "pkm.metadata",
        "agent.kai.debate",
        "agent.kai.infer",
        "agent.kai.chat",
        "agent.kai.execute",
        "agent.nav.revoke",
        "agent.kyc.draft",
        "agent.kyc.writeback",
        "cap.pkm.marketplace.publish",
        "external.sec.filings",
        "external.news.api",
        "external.market.data",
        "external.renaissance.data",
    }
)


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

# Standard model for agent work across the codebase (One specialists, Kai
# debate agents, HushhAgent manifest default, portfolio import). Keep every
# agent lane on the same generation; the voice head uses the dedicated Live
# model via AGENT_ONE_ADK_MODEL instead.
GEMINI_MODEL = "gemini-3.5-flash"

# Full path format (for ADK and direct API calls)
GEMINI_MODEL_FULL = "models/gemini-3.5-flash"

# Vertex AI model (for Google Cloud deployments)
GEMINI_MODEL_VERTEX = "gemini-3.5-flash"

# ==================== Kai Portfolio Import Defaults ====================

# Portfolio import extraction is prompt-first and optimized for lower latency.
KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL = "gemini-3.5-flash"
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
