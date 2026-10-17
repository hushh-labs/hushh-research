"""Private registry credential projection; storage authority remains unchanged."""

from __future__ import annotations

from typing import Any, Literal

from hushh_mcp.services.external_mcp_client import ExternalMcpError


def registered_credential_headers(
    connector: Any, secret: dict[str, Any]
) -> tuple[dict[str, str], Literal["api_key", "oauth"]]:
    if connector.auth_style == "api_key":
        kind: Literal["api_key", "oauth"] = "api_key"
        header = connector.api_key_header_name or "Authorization"
        if header.lower() not in {"authorization", "x-api-key", "api-key"}:
            raise ExternalMcpError("Unsupported credential header.", code="MCP_CREDENTIAL_INVALID")
        credential = secret.get("apiKey")
    elif connector.auth_style == "oauth":
        kind, header = "oauth", "Authorization"
        token = secret.get("accessToken")
        credential = f"Bearer {token}" if isinstance(token, str) and token else None
    else:
        raise ExternalMcpError("Unsupported credential type.", code="MCP_CREDENTIAL_INVALID")
    if (
        not isinstance(credential, str)
        or not credential.strip()
        or any(ord(c) < 32 or ord(c) == 127 for c in credential)
    ):
        raise ExternalMcpError("Reconnect this service.", code="MCP_CREDENTIAL_INVALID")
    return {header: credential}, kind
