from __future__ import annotations

import os
import threading
import time
from contextvars import ContextVar, Token
from urllib.parse import urlparse

import httpx

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
_oauth_token_lock = threading.Lock()
_oauth_access_token: tuple[str, float] | None = None
_OAUTH_TOKEN_REFRESH_SKEW_SECONDS = 60.0
_OAUTH_TOKEN_REQUEST_TIMEOUT_SECONDS = 10.0


def _configured_token() -> str:
    developer_token = str(os.getenv("HUSHH_DEVELOPER_TOKEN", "")).strip()
    return developer_token or _client_credentials_access_token()


def _client_credentials_access_token() -> str:
    """Return one in-memory OAuth client-credentials token for this bridge.

    Client credentials are accepted only for operations-provisioned developer
    apps by the remote OAuth service.  This connector caches the returned
    bearer token only in process memory and renews it before expiry.  It never
    persists or logs the client secret, access token, or token response.
    """
    global _oauth_access_token

    client_id = str(os.getenv("HUSHH_OAUTH_CLIENT_ID", "")).strip()
    client_secret = str(os.getenv("HUSHH_OAUTH_CLIENT_SECRET", "")).strip()
    if not client_id or not client_secret:
        return ""

    now = time.monotonic()
    cached = _oauth_access_token
    if cached is not None and cached[1] > now:
        return cached[0]

    with _oauth_token_lock:
        now = time.monotonic()
        cached = _oauth_access_token
        if cached is not None and cached[1] > now:
            return cached[0]

        configured_url = str(os.getenv("HUSHH_OAUTH_TOKEN_URL", "")).strip()
        api_origin = str(os.getenv("CONSENT_API_URL", "")).strip().rstrip("/")
        token_url = configured_url or f"{api_origin}/oauth/token"
        if not token_url or urlparse(token_url).scheme not in {"http", "https"}:
            return ""
        try:
            response = httpx.post(
                token_url,
                data={"grant_type": "client_credentials", "scope": "mcp:tools"},
                auth=(client_id, client_secret),
                timeout=_OAUTH_TOKEN_REQUEST_TIMEOUT_SECONDS,
            )
            if response.status_code != 200:
                return ""
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return ""

        access_token = str(payload.get("access_token") or "").strip()
        token_type = str(payload.get("token_type") or "").strip().lower()
        if not access_token or token_type != "bearer":  # noqa: S105 - OAuth token type
            return ""
        try:
            expires_in = max(1, int(payload.get("expires_in") or 0))
        except (TypeError, ValueError):
            return ""
        refresh_after = now + max(1.0, expires_in - _OAUTH_TOKEN_REFRESH_SKEW_SECONDS)
        _oauth_access_token = (access_token, refresh_after)
        return access_token


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
