# mcp/config.py
"""
MCP Server configuration.
"""

import os


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.environ.get(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _read_developer_token() -> str:
    """Resolve the developer token with backwards-compatible env fallback."""
    hushh_token = str(os.environ.get("HUSHH_DEVELOPER_TOKEN", "")).strip()
    if hushh_token:
        return hushh_token
    return str(os.environ.get("MCP_DEVELOPER_TOKEN", "")).strip()


# FastAPI backend URL (for consent API calls)
_DEFAULT_PORT = str(os.environ.get("PORT", "8000")).strip() or "8000"
FASTAPI_URL = os.environ.get("CONSENT_API_URL", f"http://127.0.0.1:{_DEFAULT_PORT}")

# Optional frontend URL used only for internal/backend-generated app links.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")

# Production mode: requires user approval via dashboard
PRODUCTION_MODE = os.environ.get("PRODUCTION_MODE", "true").lower() == "true"
ENVIRONMENT = str(os.environ.get("ENVIRONMENT", "development")).strip().lower()
DEVELOPER_API_ENABLED = (
    False if ENVIRONMENT == "production" else _env_truthy("DEVELOPER_API_ENABLED", "true")
)

# Developer token used by the stdio launcher and local MCP hosts.
# `MCP_DEVELOPER_TOKEN` is kept as a compatibility alias for older imports/envs.
HUSHH_DEVELOPER_TOKEN = _read_developer_token()
MCP_DEVELOPER_TOKEN = HUSHH_DEVELOPER_TOKEN

# How long to wait for user to approve consent (in seconds)
CONSENT_TIMEOUT_SECONDS = int(os.environ.get("CONSENT_TIMEOUT_SECONDS", "120"))

# ============================================================================
# SERVER INFO
# ============================================================================

SERVER_INFO = {
    "name": "Hushh Consent MCP Server",
    "version": "1.0.0",
    "protocol": "HushhMCP",
    "transport": "stdio",
    "description": "Consent-first personal data access for AI agents; no data without explicit user approval. Scopes are dynamic from the Personal Knowledge Model registry; use discover_user_domains to get per-user scope strings.",
    "tools_count": 6,
    "tools": [
        {"name": "request_consent", "purpose": "Request user consent for a data scope"},
        {
            "name": "validate_token",
            "purpose": "Validate a consent token (signature, expiry, scope)",
        },
        {
            "name": "discover_user_domains",
            "purpose": "Discover which domains a user has and scope strings to request",
        },
        {
            "name": "list_scopes",
            "purpose": "List dynamic consent scope categories from backend registry",
        },
        {
            "name": "get_encrypted_scoped_export",
            "purpose": "Fetch the encrypted wrapped-key export for any approved dynamic scope",
        },
        {
            "name": "check_consent_status",
            "purpose": "Check status of a pending consent request",
        },
    ],
    "compliance": [
        "Consent First",
        "Scoped Access",
        "Zero Knowledge",
        "Cryptographic Signatures",
        "TrustLink Delegation",
    ],
}

# ============================================================================
# SCOPE MAPPINGS
# ============================================================================

# Canonical PKM scopes.
SCOPE_API_MAP = {
    "pkm.read": "pkm.read",
    "pkm.write": "pkm.write",
}


def resolve_scope_api(scope: str) -> str | None:
    """Resolve scope input to canonical dot notation.

    Accepts:
    - canonical static scopes (pkm.read/write)
    - canonical dynamic scopes (attr.{domain}.*, attr.{domain}.{subintent}.*,
      or specific paths like attr.{domain}.{attribute})

    Returns None if scope format is invalid.
    """
    import re

    value = str(scope or "").strip()
    if not value:
        return None

    # Static scope normalization
    static = SCOPE_API_MAP.get(value)
    if static:
        return static

    # Canonical dynamic scope (domain, nested subintent, optional wildcard)
    if re.match(r"^attr\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?$", value):
        return value

    return None
