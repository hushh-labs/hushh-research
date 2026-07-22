"""Published names and compatibility aliases for the one public MCP catalog."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from mcp_modules.flat_contract import get_flat_contract, get_flat_tool_names

_PUBLISHED_NAMES = {
    "search_user_scopes": "search-user-scopes",
    "prepare_campaign_context": "prepare-campaign-context",
    "request_consent": "request-consent",
    "check_consent_status": "check-consent-status",
    "get_encrypted_scoped_export": "get-encrypted-scoped-export",
}
_INTERNAL_NAMES = {published: internal for internal, published in _PUBLISHED_NAMES.items()}


def canonical_tool_name(name: str) -> str | None:
    """Resolve a published v0.4 name or accepted v0.3 underscore alias."""

    value = str(name or "").strip()
    if value in _PUBLISHED_NAMES:
        return value
    return _INTERNAL_NAMES.get(value)


def published_tool_name(name: str) -> str | None:
    internal = canonical_tool_name(name)
    return _PUBLISHED_NAMES.get(internal or "")


def get_published_tool_names() -> tuple[str, ...]:
    return tuple(_PUBLISHED_NAMES[name] for name in get_flat_tool_names())


def get_published_contract_tools() -> list[dict[str, Any]]:
    """Return the one externally visible five-tool catalog.

    Handler identities stay underscore-delimited internally.  The published
    hyphenated identifiers satisfy constrained hosts while old callers remain
    accepted by ``canonical_tool_name`` during the v0.3 migration window.
    """

    tools: list[dict[str, Any]] = []
    for definition in get_flat_contract()["tools"]:
        tool = deepcopy(definition)
        tool["name"] = _PUBLISHED_NAMES[str(definition["name"])]
        internal_name = str(definition["name"])
        title = str(tool.get("title") or "")
        tool["inputSchema"]["title"] = f"{title} input"
        tool["outputSchema"]["title"] = f"{title} output"
        tool["annotations"] = {
            "title": title,
            "readOnlyHint": internal_name
            in {
                "search_user_scopes",
                "check_consent_status",
                "get_encrypted_scoped_export",
            },
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        }
        tools.append(tool)
    return tools
