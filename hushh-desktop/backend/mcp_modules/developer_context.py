from __future__ import annotations

import os
from contextvars import ContextVar, Token

from hushh_mcp.services.developer_registry_service import (
    DEFAULT_PUBLIC_TOOL_GROUPS,
    DeveloperPrincipal,
    DeveloperRegistryService,
    visible_tool_names_for_groups,
)

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
    return DeveloperRegistryService().authenticate_token(raw_token)


def get_current_visible_tool_names() -> tuple[str, ...]:
    principal = get_current_developer_principal()
    if principal is None:
        return visible_tool_names_for_groups(DEFAULT_PUBLIC_TOOL_GROUPS)
    return visible_tool_names_for_groups(principal.allowed_tool_groups)


def is_tool_allowed(tool_name: str) -> bool:
    return tool_name in set(get_current_visible_tool_names())


def get_developer_request_query() -> dict[str, str]:
    raw_token = _current_developer_token.get() or _configured_token()
    if not raw_token:
        return {}
    return {"token": raw_token}


def get_developer_request_headers() -> dict[str, str]:
    raw_token = _current_developer_token.get() or _configured_token()
    if not raw_token:
        return {}
    return {"X-MCP-Developer-Token": raw_token}
