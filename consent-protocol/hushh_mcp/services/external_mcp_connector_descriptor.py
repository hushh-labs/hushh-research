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
from urllib.parse import urlparse

_CONNECTOR_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


class ExternalMcpConnectorDescriptorError(ValueError):
    pass


def _text(value: Any) -> str:
    return str(value or "").strip()


def _require_https_url(value: Any, label: str) -> str:
    candidate = _text(value)
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ExternalMcpConnectorDescriptorError(f"{label} must be an HTTPS URL.")
    return candidate


def _safe_env_name(value: Any, label: str) -> str:
    name = _text(value)
    if not name or not name.replace("_", "").isalnum() or name.upper() != name:
        raise ExternalMcpConnectorDescriptorError(
            f"{label} must name an uppercase environment variable."
        )
    return name


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
    if not isinstance(raw, dict) or raw.get("version") != "external-mcp-connector.v1":
        raise ExternalMcpConnectorDescriptorError(
            "Descriptor version must be external-mcp-connector.v1."
        )

    connector_id = _text(raw.get("connectorId"))
    if not _CONNECTOR_ID_PATTERN.match(connector_id):
        raise ExternalMcpConnectorDescriptorError(
            "connectorId must be lowercase snake_case, e.g. 'notion'."
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
        if not isinstance(scopes, list) or not scopes or not all(_text(s) for s in scopes):
            raise ExternalMcpConnectorDescriptorError(
                "oauthScopes must be a non-empty list of scope strings."
            )
        _safe_env_name(raw.get("oauthClientIdEnv"), "oauthClientIdEnv")
        _safe_env_name(raw.get("oauthClientSecretEnv"), "oauthClientSecretEnv")

    return ValidatedExternalMcpConnectorDescriptor(raw=raw)
