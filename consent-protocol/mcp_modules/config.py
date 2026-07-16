# mcp/config.py
"""
MCP Server configuration.
"""

import os

from hushh_mcp.runtime_settings import get_app_runtime_settings
from mcp_modules.public_contract import get_public_contract, get_public_tool_names


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.environ.get(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _read_developer_token() -> str:
    return str(os.environ.get("HUSHH_DEVELOPER_TOKEN", "")).strip()


# FastAPI backend URL (for consent API calls)
_DEFAULT_PORT = str(os.environ.get("PORT", "8000")).strip() or "8000"
FASTAPI_URL = os.environ.get("CONSENT_API_URL", f"http://127.0.0.1:{_DEFAULT_PORT}")

# Public origin external connectors can reach for direct HTTP fetches (for
# example the scoped-export download lane). FASTAPI_URL is loopback when the
# remote MCP is mounted in-process on Cloud Run, so download URLs handed to
# connectors must use this instead. Falls back to FASTAPI_URL, which is
# correct for stdio/local development where the backend is directly reachable.
CONSENT_API_PUBLIC_ORIGIN = (
    str(os.environ.get("CONSENT_API_PUBLIC_ORIGIN", "")).strip().rstrip("/") or FASTAPI_URL
)

# Optional frontend origin used only for internal/backend-generated app links.
APP_FRONTEND_ORIGIN = get_app_runtime_settings().app_frontend_origin or "http://localhost:3000"

# Production mode: requires user approval via dashboard
PRODUCTION_MODE = os.environ.get("PRODUCTION_MODE", "true").lower() == "true"
ENVIRONMENT = str(os.environ.get("ENVIRONMENT", "development")).strip().lower()
DEVELOPER_API_ENABLED = (
    False if ENVIRONMENT == "production" else _env_truthy("DEVELOPER_API_ENABLED", "true")
)

# Developer token used by the stdio launcher and local MCP hosts.
HUSHH_DEVELOPER_TOKEN = _read_developer_token()

# How long to wait for user to approve consent (in seconds)
CONSENT_TIMEOUT_SECONDS = int(os.environ.get("CONSENT_TIMEOUT_SECONDS", "120"))

# ============================================================================
# SERVER INFO
# ============================================================================

_PUBLIC_CONTRACT = get_public_contract()
_PUBLIC_TOOL_NAMES = get_public_tool_names()

SERVER_INFO = {
    "name": "Hushh Consent MCP Server",
    "version": _PUBLIC_CONTRACT["server"]["version"],
    "protocol": "HushhMCP",
    "transport": "stdio",
    "description": "Consent-first scoped information access for private agents. Search dynamic scopes, request explicit approval, poll by reference, then retrieve the approved encrypted export.",
    "connector_capabilities": {
        "crypto_modes": ["local", "host"],
        "envelope_versions": [2],
        "wrapping_algorithms": ["X25519-AES256-GCM"],
        "resource_fetch": True,
        "inline_ciphertext": False,
        "maximum_resource_bytes_env": "HUSHH_CONSENT_EXPORT_MAX_RAW_BYTES",
        "maximum_model_result_chars_env": "HUSHH_MCP_LOCAL_DECRYPT_MAX_JSON_CHARS",
    },
    "tools_count": len(_PUBLIC_TOOL_NAMES),
    "tools": [
        {"name": tool["name"], "purpose": tool["description"]} for tool in _PUBLIC_CONTRACT["tools"]
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

# No external alias exists for internal vault/PKM authorities.
SCOPE_API_MAP: dict[str, str] = {"cap.one.invoke": "cap.one.invoke"}


def resolve_scope_api(scope: str) -> str | None:
    """Resolve scope input to canonical dot notation.

    Accepts:
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
