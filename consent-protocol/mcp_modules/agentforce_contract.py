"""Strict UAT-only Agentforce projection of the Hussh consent MCP catalog.

The canonical standard and generic ``flat`` profiles retain their existing
machine identifiers. This projection is intentionally separate because
Agentforce currently publishes a narrower tool-name character set and only
handles shallow primitive fields reliably.

Salesforce currently does not support user-level authentication or
personalized MCP responses. The profile is therefore for registration and
schema UAT only; :mod:`mcp_server` fails personalized tool execution closed.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from mcp_modules.flat_contract import get_flat_contract

AGENTFORCE_PROFILE = "agentforce"
AGENTFORCE_MAX_TOOLS = 20
AGENTFORCE_MAX_PROPERTY_CHARS = 255
AGENTFORCE_MAX_REQUEST_SECONDS = 55.0

# Salesforce's current external-MCP documentation permits letters, numbers,
# dots, slashes, and hyphens. Keep the existing canonical identifiers intact
# in the standard/flat profiles and expose this non-breaking UAT alias set.
_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9./-]{1,128}$")
_AGENTFORCE_TOOL_ALIASES = {
    "search_user_scopes": "search-user-scopes",
    "request_consent": "request-consent",
    "check_consent_status": "check-consent-status",
    "get_encrypted_scoped_export": "get-encrypted-scoped-export",
}
_CANONICAL_TOOL_NAMES = {alias: canonical for canonical, alias in _AGENTFORCE_TOOL_ALIASES.items()}
_READ_ONLY_TOOLS = {"search_user_scopes", "check_consent_status"}


def get_agentforce_tool_names() -> tuple[str, ...]:
    """Return the Agentforce-visible aliases in lifecycle order."""

    return tuple(_AGENTFORCE_TOOL_ALIASES.values())


def canonical_agentforce_tool_name(name: str) -> str | None:
    """Resolve one Agentforce alias to its canonical Hussh handler name."""

    return _CANONICAL_TOOL_NAMES.get(str(name or "").strip())


def _tool_annotations(canonical_name: str, title: str) -> dict[str, Any]:
    return {
        "title": title,
        "readOnlyHint": canonical_name in _READ_ONLY_TOOLS,
        "destructiveHint": False,
        "idempotentHint": canonical_name in _READ_ONLY_TOOLS,
        "openWorldHint": False,
    }


def get_agentforce_contract() -> dict[str, Any]:
    """Project the canonical flat lifecycle into the Agentforce UAT catalog."""

    tools: list[dict[str, Any]] = []
    for flat_tool in get_flat_contract()["tools"]:
        canonical_name = str(flat_tool["name"])
        agentforce_name = _AGENTFORCE_TOOL_ALIASES[canonical_name]
        title = str(flat_tool["title"])
        tool = deepcopy(flat_tool)
        tool["name"] = agentforce_name
        tool["annotations"] = _tool_annotations(canonical_name, title)
        tool["inputSchema"]["title"] = f"{title} input"
        tool["outputSchema"]["title"] = f"{title} output"
        tools.append(tool)
    return {"profile": AGENTFORCE_PROFILE, "tools": tools}


def agentforce_contract_errors(contract: dict[str, Any] | None = None) -> list[str]:
    """Return deterministic violations of the documented Agentforce subset."""

    active_contract = contract or get_agentforce_contract()
    tools = active_contract.get("tools")
    if not isinstance(tools, list):
        return ["tools must be an array"]
    errors: list[str] = []
    if not 1 <= len(tools) <= AGENTFORCE_MAX_TOOLS:
        errors.append(f"tool count must be between 1 and {AGENTFORCE_MAX_TOOLS}")

    names: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            errors.append("tool must be an object")
            continue
        name = str(tool.get("name") or "")
        if not _TOOL_NAME_PATTERN.fullmatch(name):
            errors.append(f"tool name is not Agentforce-compatible: {name!r}")
        if name in names:
            errors.append(f"duplicate tool name: {name}")
        names.add(name)
        for key in ("title", "description"):
            if not str(tool.get(key) or "").strip():
                errors.append(f"{name}: {key} is required")
        for schema_key in ("inputSchema", "outputSchema"):
            _schema_errors(name, schema_key, tool.get(schema_key), errors)
    return errors


def _schema_errors(
    tool_name: str,
    schema_name: str,
    schema: object,
    errors: list[str],
) -> None:
    if not isinstance(schema, dict) or schema.get("type") != "object":
        errors.append(f"{tool_name}: {schema_name} must be an object schema")
        return
    if schema.get("additionalProperties") is not False:
        errors.append(f"{tool_name}: {schema_name} must reject undeclared fields")
    properties = schema.get("properties")
    required = schema.get("required")
    if not isinstance(properties, dict) or not isinstance(required, list):
        errors.append(f"{tool_name}: {schema_name} needs properties and required")
        return
    for field_name in required:
        if field_name not in properties:
            errors.append(f"{tool_name}: {schema_name} requires an undeclared field")
    for field_name, field in properties.items():
        if not isinstance(field_name, str) or len(field_name) > AGENTFORCE_MAX_PROPERTY_CHARS:
            errors.append(f"{tool_name}: {schema_name} has an oversized field name")
        if not isinstance(field, dict):
            errors.append(f"{tool_name}: {schema_name}.{field_name} must be an object")
            continue
        for metadata_key in ("title", "description"):
            value = str(field.get(metadata_key) or "")
            if not value.strip() or len(value) > AGENTFORCE_MAX_PROPERTY_CHARS:
                errors.append(
                    f"{tool_name}: {schema_name}.{field_name} needs a bounded {metadata_key}"
                )
        field_type = field.get("type")
        if field_type in {"string", "number", "integer", "boolean"}:
            continue
        if field_type == "array":
            items = field.get("items")
            if not isinstance(items, dict) or items.get("type") != "string":
                errors.append(
                    f"{tool_name}: {schema_name}.{field_name} must be an array of strings"
                )
            continue
        errors.append(f"{tool_name}: {schema_name}.{field_name} is not a supported primitive")
