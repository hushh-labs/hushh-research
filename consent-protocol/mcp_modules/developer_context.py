from __future__ import annotations

import os
from contextvars import ContextVar, Token
from urllib.parse import urlparse

from hushh_mcp.services.developer_registry_service import (
    DEFAULT_PUBLIC_TOOL_GROUPS,
    DeveloperPrincipal,
    DeveloperRegistryService,
    visible_tool_names_for_groups,
)
from mcp_modules.agentforce_contract import (
    AGENTFORCE_PROFILE,
)
from mcp_modules.flat_contract import FLAT_PROFILE

_current_developer_principal: ContextVar[DeveloperPrincipal | None] = ContextVar(
    "hushh_mcp_developer_principal",
    default=None,
)
_current_developer_token: ContextVar[str | None] = ContextVar(
    "hushh_mcp_developer_token",
    default=None,
)


def _configured_token() -> str:
    return str(os.getenv("HUSHH_DEVELOPER_TOKEN", "")).strip()


def _delegates_auth_to_remote_api() -> bool:
    """Whether this stdio process uses a non-loopback consent API.

    A remote-backed stdio bridge has no local copy of the developer registry.
    Trying to authenticate its UAT/production token through
    ``DeveloperRegistryService`` incorrectly opens the contributor-local
    database before the request can reach the authoritative backend. In this
    mode the bridge exposes only the public tool groups and the remote API
    authenticates and authorizes every operation.
    """
    raw_url = str(os.getenv("CONSENT_API_URL", "")).strip()
    if not raw_url:
        return False
    hostname = (urlparse(raw_url).hostname or "").strip().lower()
    return bool(hostname) and hostname not in {"localhost", "127.0.0.1", "::1"}


def set_current_developer_principal(
    principal: DeveloperPrincipal | None,
    *,
    token: str | None = None,
) -> tuple[Token, Token]:
    principal_token = _current_developer_principal.set(principal)
    developer_token = _current_developer_token.set(token)
    return principal_token, developer_token


def reset_current_developer_principal(tokens: tuple[Token, Token]) -> None:
    principal_token, developer_token = tokens
    _current_developer_principal.reset(principal_token)
    _current_developer_token.reset(developer_token)


def get_current_developer_principal() -> DeveloperPrincipal | None:
    principal = _current_developer_principal.get()
    if principal is not None:
        return principal

    raw_token = _configured_token()
    if not raw_token:
        return None
    if _delegates_auth_to_remote_api():
        return None
    principal = DeveloperRegistryService().authenticate_token(raw_token)
    if principal is not None:
        return principal
    if raw_token.startswith("hdo_at_"):
        # Local stdio connectors may be launched with the same short-lived
        # OAuth access token used by Streamable HTTP clients. Resolve that
        # token through the OAuth registry so grant-scoped execution policy,
        # especially catalog_only, is identical on both transports.
        from hushh_mcp.services.developer_oauth_service import DeveloperOAuthService

        return DeveloperOAuthService().authenticate_access_token(raw_token)
    return None


def get_current_visible_tool_names() -> tuple[str, ...]:
    principal = get_current_developer_principal()
    if principal is None:
        return visible_tool_names_for_groups(DEFAULT_PUBLIC_TOOL_GROUPS)
    visible = visible_tool_names_for_groups(principal.allowed_tool_groups)
    return visible


def get_current_schema_profile() -> str:
    principal = get_current_developer_principal()
    if principal is None:
        return "standard"
    if principal.schema_profile in {FLAT_PROFILE, AGENTFORCE_PROFILE}:
        return principal.schema_profile
    return "standard"


def is_tool_allowed(tool_name: str) -> bool:
    from mcp_modules.canonical_contract import canonical_tool_name

    return canonical_tool_name(tool_name) in set(get_current_visible_tool_names())


def get_developer_request_headers() -> dict[str, str]:
    """Header used by the legacy internal user-lookup surface."""
    raw_token = _current_developer_token.get() or _configured_token()
    if not raw_token:
        return {}
    return {"X-MCP-Developer-Token": raw_token}


def get_developer_api_headers() -> dict[str, str]:
    """Header-only registry authentication for developer API requests."""
    raw_token = _current_developer_token.get() or _configured_token()
    if not raw_token:
        return {}
    return {"Authorization": f"Bearer {raw_token}"}
