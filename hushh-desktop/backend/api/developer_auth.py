from __future__ import annotations

import logging
import os

from fastapi import HTTPException, Request, status

from hushh_mcp.services.developer_registry_service import (
    DeveloperPrincipal,
    DeveloperRegistryService,
)

logger = logging.getLogger(__name__)


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def environment() -> str:
    return str(os.getenv("ENVIRONMENT", "development")).strip().lower()


def developer_api_enabled() -> bool:
    current_environment = environment()
    if current_environment == "production":
        return _env_truthy("DEVELOPER_API_ENABLED", "false")
    return _env_truthy("DEVELOPER_API_ENABLED", "true")


def remote_mcp_enabled() -> bool:
    if not developer_api_enabled():
        return False
    return _env_truthy("REMOTE_MCP_ENABLED", "false")


def developer_api_disabled_error() -> HTTPException:
    current_environment = environment()
    is_production = current_environment == "production"
    return HTTPException(
        status_code=status.HTTP_410_GONE,
        detail={
            "error_code": (
                "DEVELOPER_API_DISABLED_IN_PRODUCTION"
                if is_production
                else "DEVELOPER_API_DISABLED"
            ),
            "message": (
                "Developer API is disabled in production."
                if is_production
                else "Developer API is not enabled in this environment."
            ),
        },
    )


def remote_mcp_disabled_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={
            "error_code": "REMOTE_MCP_DISABLED",
            "message": "Remote MCP is not enabled in this environment.",
        },
    )


def _resolve_bearer_token(authorization: str | None = None) -> str:
    bearer = str(authorization or "").strip()
    if bearer.lower().startswith("bearer "):
        return bearer[7:].strip()
    return ""


def _resolve_query_token(token: str | None = None) -> str:
    return str(token or "").strip()


def _resolve_developer_token(
    *,
    token: str | None,
    authorization: str | None,
) -> tuple[str, str]:
    """
    Resolve the developer token from either an Authorization: Bearer header or
    a ?token= query parameter, in that order of preference.

    Returns a (raw_token, source) tuple where source is "bearer", "query", or
    "" when neither carries a value. Bearer is preferred because tokens passed
    in URLs leak via Referer headers, server access logs, browser history, and
    proxy/CDN logs (CWE-598). Query support is retained so existing developer
    API and remote MCP clients keep working.
    """
    bearer_token = _resolve_bearer_token(authorization)
    if bearer_token:
        return bearer_token, "bearer"

    query_token = _resolve_query_token(token)
    if query_token:
        return query_token, "query"

    return "", ""


def _warn_query_token_leak_risk(*, request: Request | None) -> None:
    path = ""
    client_ip = ""
    if request is not None:
        try:
            path = request.url.path
        except Exception:
            path = ""
        client_ip = request.client.host if request.client else ""
    logger.warning(
        "Developer token received via query parameter; prefer Authorization: Bearer header "
        "to avoid URL-leak vectors (Referer, access logs, browser history).",
        extra={
            "event_type": "developer_token_query_param_use",
            "path": path,
            "client_ip": client_ip,
        },
    )


def authenticate_developer_principal(
    *,
    token: str | None = None,
    authorization: str | None = None,
    request: Request | None = None,
) -> DeveloperPrincipal:
    if not developer_api_enabled():
        raise developer_api_disabled_error()

    raw_token, source = _resolve_developer_token(token=token, authorization=authorization)
    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error_code": "DEVELOPER_TOKEN_REQUIRED",
                "message": (
                    "Developer token is required. Pass it as 'Authorization: Bearer <token>' "
                    "(preferred) or '?token=<token>' (legacy)."
                ),
            },
        )

    if source == "query":
        _warn_query_token_leak_risk(request=request)

    client_ip = request.client.host if request and request.client else None
    user_agent = request.headers.get("user-agent") if request else None
    principal = DeveloperRegistryService().authenticate_token(
        raw_token,
        ip_address=client_ip,
        user_agent=user_agent,
    )
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "DEVELOPER_TOKEN_INVALID",
                "message": "Developer token is invalid or revoked.",
            },
        )
    return principal


def try_authenticate_developer_principal(
    *,
    token: str | None = None,
    authorization: str | None = None,
    request: Request | None = None,
) -> DeveloperPrincipal | None:
    if not developer_api_enabled():
        return None

    raw_token, source = _resolve_developer_token(token=token, authorization=authorization)
    if not raw_token:
        return None

    if source == "query":
        _warn_query_token_leak_risk(request=request)

    client_ip = request.client.host if request and request.client else None
    user_agent = request.headers.get("user-agent") if request else None
    return DeveloperRegistryService().authenticate_token(
        raw_token,
        ip_address=client_ip,
        user_agent=user_agent,
    )
