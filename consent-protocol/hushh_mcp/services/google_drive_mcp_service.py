"""Read-only official Drive MCP adapter using the existing Google grant owner.

This is a provider boundary, not agent invocation authority: callers must derive
the owner from their authenticated, consent-checked context. Connecting Google
does not authorize onward sharing, PKM capture, or a delegated information read.
Do not register an unrestricted generic dispatcher in place of this adapter.
"""

from __future__ import annotations

import json
import time
from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry
from referencing.exceptions import NoSuchResource, Unresolvable

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult, call_tool, list_tools
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)

GOOGLE_DRIVE_MCP_ENDPOINT = "https://drivemcp.googleapis.com/mcp/v1"
# Explicit reviewed capabilities, not server-supplied annotations, names with
# read-like prefixes, or model assertions. Cumulative Google tokens can contain
# other permissions, so OAuth read scopes alone are not execution policy.
GOOGLE_DRIVE_READ_TOOLS = frozenset(
    {
        "get_file_metadata",
        "get_file_permissions",
        "list_recent_files",
        "read_file_content",
        "search_files",
    }
)
_MAX_SCHEMA_BYTES = 16_000
_MAX_DESCRIPTION_LENGTH = 700
_MAX_ARGUMENT_BYTES = 4_096
_CATALOG_TTL_SECONDS = 300


def _reject_reference(uri: str) -> Any:
    """Provider schemas must never cause a second, unpinned network fetch."""
    raise NoSuchResource(ref=uri)


_OFFLINE_REGISTRY = Registry(retrieve=_reject_reference)


def _safe_read_capability(value: object) -> dict[str, Any] | None:
    """Admit only bounded official read schemas as untrusted model-facing data."""
    if not isinstance(value, dict):
        return None
    name = value.get("name")
    if not isinstance(name, str) or name not in GOOGLE_DRIVE_READ_TOOLS:
        return None
    schema = value.get("inputSchema")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return None
    try:
        if len(json.dumps(schema, allow_nan=False).encode("utf-8")) > _MAX_SCHEMA_BYTES:
            return None
        Draft202012Validator.check_schema(schema)
    except (SchemaError, TypeError, ValueError, RecursionError):
        # A malformed provider schema is unavailable, never interpreted as a
        # permissive object contract. Error text can contain provider payloads.
        return None
    pending = [schema]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            if any(
                key in node for key in ("$id", "$dynamicRef", "$recursiveRef", "$dynamicAnchor")
            ):
                return None
            ref = node.get("$ref")
            if ref is not None and (not isinstance(ref, str) or not ref.startswith("#/")):
                return None
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)
    description = value.get("description")
    return {
        "name": name,
        "description": description[:_MAX_DESCRIPTION_LENGTH]
        if isinstance(description, str)
        else "",
        "inputSchema": schema,
    }


class GoogleDriveMcpService:
    def __init__(self, *, connections: GoogleConnectionService | None = None) -> None:
        self._connections = connections or get_google_connection_service()
        self._catalog: tuple[float, list[dict[str, Any]]] | None = None

    async def discover_read_tools(self) -> list[dict[str, Any]]:
        """Discover official tool descriptions/schemas without an owner grant.

        The public catalog is capability metadata. It supplies no execution
        authority, credential, or private file result.
        """
        if self._catalog is not None and self._catalog[0] > time.monotonic():
            return deepcopy(self._catalog[1])
        tools = await list_tools(endpoint=GOOGLE_DRIVE_MCP_ENDPOINT)
        approved: dict[str, dict[str, Any]] = {}
        duplicated: set[str] = set()
        for tool in tools:
            capability = _safe_read_capability(tool)
            if capability:
                name = capability["name"]
                if name in approved:
                    approved.pop(name)
                    duplicated.add(name)
                elif name not in duplicated:
                    approved[name] = capability
        result = [approved[name] for name in sorted(approved)]
        self._catalog = (time.monotonic() + _CATALOG_TTL_SECONDS, result)
        return deepcopy(result)

    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult:
        if (
            not user_id
            or not isinstance(tool_name, str)
            or tool_name not in GOOGLE_DRIVE_READ_TOOLS
        ):
            raise GoogleConnectionError("This Drive operation is not available", status_code=403)
        if not isinstance(arguments, dict):
            raise GoogleConnectionError("Drive request is invalid", status_code=400)
        try:
            if len(json.dumps(arguments, allow_nan=False).encode("utf-8")) > _MAX_ARGUMENT_BYTES:
                raise ValueError("oversized")
        except (TypeError, ValueError, RecursionError):
            raise GoogleConnectionError("Drive request is invalid", status_code=400) from None
        catalog = await self.discover_read_tools()
        capability = next((item for item in catalog if item["name"] == tool_name), None)
        if capability is None:
            raise GoogleConnectionError("This Drive operation is unavailable", status_code=403)
        try:
            Draft202012Validator(capability["inputSchema"], registry=_OFFLINE_REGISTRY).validate(
                arguments
            )
        except (ValidationError, SchemaError, Unresolvable, TypeError, ValueError):
            raise GoogleConnectionError("Drive request is invalid", status_code=400) from None
        # No bearer is accepted from a model/client and none is returned to it.
        access_token = await self._connections.access_token(
            user_id=user_id, service="drive", access_level="read"
        )
        # Contents are untrusted information, never instructions or mutation
        # authority. The shared MCP client bounds the response and request time;
        # this adapter has no result cache, persistence, or automatic retries.
        return await call_tool(
            tool_name,
            arguments,
            endpoint=GOOGLE_DRIVE_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {access_token}"},
        )
