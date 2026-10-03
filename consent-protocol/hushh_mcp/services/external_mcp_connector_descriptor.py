"""Validation for local external-mcp-connector.v1 descriptors.

Mirrors `crm_registry_descriptor.py`'s shape and strictness, generalized
away from the fixed 5-CRM-operation vocabulary: a connector here declares
just an MCP endpoint and an auth style, not a record schema -- its tool
catalog is discovered live via `external_mcp_client.list_tools()` at apply
time, not enumerated in the descriptor.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hushh_mcp.services.mcp_public_http import UnsafeMcpEndpoint, validate_mcp_endpoint

_CONNECTOR_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


class ExternalMcpConnectorDescriptorError(ValueError):
    pass


def _text(value: Any) -> str:
    return str(value or "").strip()


def _require_https_url(value: Any, label: str) -> str:
    candidate = _text(value)
    try:
        validate_mcp_endpoint(candidate)
    except UnsafeMcpEndpoint:
        raise ExternalMcpConnectorDescriptorError(f"{label} must be a public HTTPS URL.") from None
    return candidate


def _safe_env_name(value: Any, label: str) -> str:
    name = _text(value)
    if not name or not name.replace("_", "").isalnum() or name.upper() != name:
        raise ExternalMcpConnectorDescriptorError(
            f"{label} must name an uppercase environment variable."
        )
    return name


_RESERVED_CONNECTOR_ID_PREFIXES = ("custom_", "google_")
# The only chat-admission mode this registry currently knows how to grant a
# curated (operator-owned) connector: every tool call still gets a review
# card, matching Gmail/Drive/Calendar -- see governed_mcp_toolset.py's
# founder-decision comment on why a curated row never runs unreviewed.
_ALLOWED_CHAT_ADMISSION = {"reviewed"}
_MAX_TOOL_ALLOWLIST = 200


@dataclass(frozen=True)
class ValidatedExternalMcpConnectorDescriptor:
    raw: dict[str, Any]

    @property
    def connector_id(self) -> str:
        return _text(self.raw.get("connectorId"))

    @property
    def auth_style(self) -> str:
        return _text(self.raw.get("authStyle"))


def load_and_validate_descriptor(path: str | Path) -> ValidatedExternalMcpConnectorDescriptor:
    descriptor_path = Path(path).expanduser().resolve()
    try:
        raw = json.loads(descriptor_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ExternalMcpConnectorDescriptorError(
            "Descriptor must be a readable JSON object."
        ) from error
    return validate_descriptor(raw)


def validate_descriptor(raw: Any) -> ValidatedExternalMcpConnectorDescriptor:
    if not isinstance(raw, dict) or raw.get("version") != "external-mcp-connector.v1":
        raise ExternalMcpConnectorDescriptorError(
            "Descriptor version must be external-mcp-connector.v1."
        )

    connector_id = _text(raw.get("connectorId"))
    # The id is written to the registry as given, so it must already be exact:
    # a padded id would pass the pattern yet slip past any per-id guard.
    if raw.get("connectorId") != connector_id or not _CONNECTOR_ID_PATTERN.match(connector_id):
        raise ExternalMcpConnectorDescriptorError(
            "connectorId must be lowercase snake_case, e.g. 'notion'."
        )
    if connector_id.startswith(_RESERVED_CONNECTOR_ID_PREFIXES):
        raise ExternalMcpConnectorDescriptorError(
            "connectorId may not start with 'custom_' or 'google_' -- those "
            "namespaces are managed outside this registry (vault custom "
            "connectors and the Google Workspace adapters, respectively)."
        )
    if not _text(raw.get("displayName")):
        raise ExternalMcpConnectorDescriptorError("displayName is required.")
    _require_https_url(raw.get("mcpEndpoint"), "mcpEndpoint")

    auth_style = _text(raw.get("authStyle"))
    if auth_style not in {"api_key", "oauth"}:
        raise ExternalMcpConnectorDescriptorError("authStyle must be api_key or oauth.")

    if auth_style == "api_key":
        if not _text(raw.get("apiKeyHeaderName")):
            raise ExternalMcpConnectorDescriptorError(
                "apiKeyHeaderName is required for an api_key connector."
            )
    else:
        _require_https_url(raw.get("oauthAuthorizeUrl"), "oauthAuthorizeUrl")
        _require_https_url(raw.get("oauthTokenUrl"), "oauthTokenUrl")
        scopes = raw.get("oauthScopes")
        # An empty list is a real, valid scope request some providers require
        # (HubSpot's remote MCP server advertises scopes_supported: [] and
        # rejects a non-empty scope parameter) -- only the TYPE is enforced
        # here, never non-emptiness.
        if not isinstance(scopes, list) or not all(isinstance(s, str) and _text(s) for s in scopes):
            raise ExternalMcpConnectorDescriptorError(
                "oauthScopes must be a list of scope strings (may be empty)."
            )
        _safe_env_name(raw.get("oauthClientIdEnv"), "oauthClientIdEnv")
        token_auth = _text(raw.get("tokenEndpointAuth")) or "client_secret_post"
        if token_auth not in {"client_secret_post", "none"}:
            raise ExternalMcpConnectorDescriptorError(
                "tokenEndpointAuth must be client_secret_post or none."
            )
        if token_auth == "none":  # noqa: S105 - an auth method name, not a credential
            # A public client (PKCE, no secret) must not name a secret variable.
            if _text(raw.get("oauthClientSecretEnv")):
                raise ExternalMcpConnectorDescriptorError(
                    "A public client (tokenEndpointAuth none) must not set oauthClientSecretEnv."
                )
        else:
            _safe_env_name(raw.get("oauthClientSecretEnv"), "oauthClientSecretEnv")

    if "registeredRedirectUris" in raw:
        uris = raw.get("registeredRedirectUris")
        if not isinstance(uris, list) or not uris:
            raise ExternalMcpConnectorDescriptorError(
                "registeredRedirectUris must be a non-empty list when present."
            )
        for uri in uris:
            _require_https_url(uri, "registeredRedirectUris entry")

    if "chatAdmission" in raw:
        admission = _text(raw.get("chatAdmission"))
        if admission not in _ALLOWED_CHAT_ADMISSION:
            raise ExternalMcpConnectorDescriptorError(
                f"chatAdmission must be one of {sorted(_ALLOWED_CHAT_ADMISSION)}."
            )

    if "toolAllowlist" in raw:
        tools = raw.get("toolAllowlist")
        if (
            not isinstance(tools, list)
            or len(tools) > _MAX_TOOL_ALLOWLIST
            or not all(isinstance(t, str) and _text(t) for t in tools)
        ):
            raise ExternalMcpConnectorDescriptorError(
                f"toolAllowlist must be a list of at most {_MAX_TOOL_ALLOWLIST} tool-name strings."
            )

    return ValidatedExternalMcpConnectorDescriptor(raw=raw)
