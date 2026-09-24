"""Generic Streamable-HTTP MCP client for external connectors.

Hushh already runs a proven MCP client inside
`connected_systems_service.py`'s `ExternalCrmStreamableMcpAdapter._call_tool`
-- but that path is wired for one fixed CRM-record shape (5 operation names,
3 response-contract "versions" with named path segments). An external
connector's tool catalog does not share that shape, so this module extracts
just the transport-agnostic part -- `ClientSession` + `streamablehttp_client`
from the official `mcp` SDK -- with no response-contract mapping: callers get
the tool's raw result back, lightly normalized and size-capped.

Every tool description and every tool result from an external server is
untrusted data, never an instruction to a model. Callers must not
interpolate a raw result into a system/developer prompt; treat it as content
to summarize or display, the same caution issue #6581 raised about server
descriptions.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client, validate_mcp_endpoint

logger = logging.getLogger("external_mcp_client")

_DEFAULT_TIMEOUT_SECONDS = 20.0
_MAX_RESULT_BYTES = 32_000
_MAX_CATALOG_PAGES = 20
_MAX_CATALOG_TOOLS = 500
_MAX_CATALOG_BYTES = 1_000_000
_MAX_SCHEMA_DEPTH = 32
_MAX_SCHEMA_NODES = 4096


class ExternalMcpError(RuntimeError):
    def __init__(self, message: str, *, code: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class ExternalMcpTimeoutError(ExternalMcpError):
    def __init__(self) -> None:
        super().__init__(
            "The external connector did not respond in time.",
            code="EXTERNAL_MCP_TIMEOUT",
            status_code=504,
        )


class ExternalMcpAuthError(ExternalMcpError):
    def __init__(self) -> None:
        super().__init__(
            "The external connector rejected this credential.",
            code="EXTERNAL_MCP_AUTH_FAILED",
            status_code=401,
        )


@dataclass(frozen=True)
class ExternalMcpToolResult:
    is_error: bool
    payload: dict[str, Any]
    truncated: bool


def _http_status_from_error(error: BaseException, *, _seen: set[int] | None = None) -> int | None:
    seen = _seen if _seen is not None else set()
    if id(error) in seen:
        return None
    seen.add(id(error))
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    nested = getattr(error, "exceptions", None)
    if isinstance(nested, (tuple, list)):
        for child in nested:
            status = _http_status_from_error(child, _seen=seen)
            if status is not None:
                return status
    for nested_error in (getattr(error, "__cause__", None), getattr(error, "__context__", None)):
        if isinstance(nested_error, BaseException):
            status = _http_status_from_error(nested_error, _seen=seen)
            if status is not None:
                return status
    return None


def _normalize_and_cap(
    result: Any, *, project: Callable[[dict[str, Any]], dict[str, Any]] | None = None
) -> ExternalMcpToolResult:
    is_error = bool(getattr(result, "isError", False) or getattr(result, "is_error", False))
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        # MCP's structured result is authoritative; content text is its
        # compatibility mirror and can be absent or much larger.
        payload = structured
    else:
        texts: list[str] = []
        for item in getattr(result, "content", None) or []:
            text = getattr(item, "text", None)
            if isinstance(text, str):
                texts.append(text)
        if len(texts) == 1:
            try:
                parsed = json.loads(texts[0])
            except json.JSONDecodeError:
                parsed = {"text": texts[0]}
            payload = parsed if isinstance(parsed, dict) else {"value": parsed}
        else:
            payload = {"content": texts}

    if project is not None and not is_error:
        payload = project(payload)

    serialized = json.dumps(payload)
    if len(serialized.encode("utf-8")) <= _MAX_RESULT_BYTES:
        return ExternalMcpToolResult(is_error=is_error, payload=payload, truncated=False)
    # An oversized result from an untrusted external server must never reach
    # a prompt context whole; cap it rather than pass it through.
    truncated_text = serialized[: _MAX_RESULT_BYTES // 2]
    return ExternalMcpToolResult(
        is_error=is_error,
        payload={"truncated": True, "preview": truncated_text},
        truncated=True,
    )


def validate_tool_schema(schema: Any) -> dict[str, Any]:
    """Admit bounded object schemas without fetching provider-controlled references.

    Keep the provider's validation contract intact: unsupported schemas fail
    admission instead of silently dropping constraints. Descriptions remain
    untrusted content and do not determine execution permission.
    """
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ExternalMcpError("Invalid connector schema.", code="MCP_SCHEMA_INVALID")
    schema_maps = {"$defs", "properties", "patternProperties", "dependentSchemas"}
    schema_arrays = {"allOf", "anyOf", "oneOf", "prefixItems"}
    schema_values = {
        "additionalProperties",
        "unevaluatedProperties",
        "propertyNames",
        "items",
        "unevaluatedItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
    }
    pending = [(schema, 0, "schema")]
    nodes = 0
    while pending:
        value, depth, kind = pending.pop()
        nodes += 1
        if depth > _MAX_SCHEMA_DEPTH or nodes > _MAX_SCHEMA_NODES:
            raise ExternalMcpError("Connector schema is too large.", code="MCP_SCHEMA_LIMIT")
        if isinstance(value, dict) and kind == "schema":
            # Remote refs and rebasing IDs may otherwise turn validation into
            # server-side requests, or change the meaning of local references.
            for key in ("$ref", "$dynamicRef"):
                reference = value.get(key)
                if reference is not None and (
                    not isinstance(reference, str) or not reference.startswith("#")
                ):
                    raise ExternalMcpError(
                        "Unsupported connector schema reference.", code="MCP_SCHEMA_INVALID"
                    )
            if "$id" in value or "$recursiveRef" in value:
                raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
            dialect = value.get("$schema")
            if dialect is not None and dialect != Draft202012Validator.META_SCHEMA["$id"]:
                raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
        if isinstance(value, dict):
            for key, child in value.items():
                child_kind = "data"
                if kind == "map":
                    child_kind = "schema"
                elif kind == "schema":
                    if key in schema_maps:
                        child_kind = "map"
                    elif key in schema_arrays:
                        child_kind = "array"
                    elif key in schema_values:
                        child_kind = "schema"
                pending.append((child, depth + 1, child_kind))
        elif isinstance(value, list):
            pending.extend(
                (child, depth + 1, "schema" if kind == "array" else "data") for child in value
            )
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError:
        raise ExternalMcpError("Invalid connector schema.", code="MCP_SCHEMA_INVALID") from None
    return schema


async def _list_session_tools(session: Any) -> list[dict[str, Any]]:
    """Read a complete bounded catalog; never present a partial list as complete."""
    catalog: list[dict[str, Any]] = []
    names: set[str] = set()
    cursors: set[str] = set()
    cursor: str | None = None
    size = 0
    for _ in range(_MAX_CATALOG_PAGES):
        page = await session.list_tools(**({"cursor": cursor} if cursor else {}))
        for tool in page.tools:
            name = tool.name
            if not isinstance(name, str) or not name or name in names:
                raise ExternalMcpError("Invalid connector catalog.", code="MCP_CATALOG_INVALID")
            item = {
                "name": name,
                "description": getattr(tool, "description", None) or "",
                "inputSchema": getattr(tool, "inputSchema", None) or {},
            }
            validate_tool_schema(item["inputSchema"])
            size += len(json.dumps(item).encode("utf-8"))
            if len(catalog) >= _MAX_CATALOG_TOOLS or size > _MAX_CATALOG_BYTES:
                raise ExternalMcpError("Connector catalog is too large.", code="MCP_CATALOG_LIMIT")
            names.add(name)
            catalog.append(item)
        cursor = getattr(page, "nextCursor", None)
        if cursor is None:
            return sorted(catalog, key=lambda item: item["name"])
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ExternalMcpError("Invalid connector continuation.", code="MCP_CATALOG_INVALID")
        cursors.add(cursor)
    raise ExternalMcpError("Connector catalog is too large.", code="MCP_CATALOG_LIMIT")


async def list_tools(
    *, endpoint: str, headers: dict[str, str] | None = None, timeout_seconds: float | None = None
) -> list[dict[str, Any]]:
    """Probe a connector's live tool catalog (name, description, input schema)."""

    async def _run() -> list[dict[str, Any]]:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        validate_mcp_endpoint(endpoint)
        client_kwargs: dict[str, Any] = {
            "headers": dict(headers) if headers else None,
            "httpx_client_factory": create_public_mcp_http_client,
        }
        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _unused,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                return await _list_session_tools(session)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_seconds or _DEFAULT_TIMEOUT_SECONDS)
    except ExternalMcpError:
        raise
    except TimeoutError as error:
        raise ExternalMcpTimeoutError() from error
    except Exception as error:
        status = _http_status_from_error(error)
        if status in {401, 403}:
            raise ExternalMcpAuthError() from error
        raise ExternalMcpError(
            "Could not reach the external connector.", code="EXTERNAL_MCP_UNREACHABLE"
        ) from error


async def call_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    endpoint: str,
    headers: dict[str, str] | None = None,
    timeout_seconds: float | None = None,
    project: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> ExternalMcpToolResult:
    """Invoke one tool on an external connector's MCP server. Raw result,
    size-capped and lightly normalized -- no CRM-shaped response-contract
    mapping, since an arbitrary connector's tools share no fixed shape."""

    async def _run() -> ExternalMcpToolResult:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        validate_mcp_endpoint(endpoint)
        client_kwargs: dict[str, Any] = {
            "headers": dict(headers) if headers else None,
            "httpx_client_factory": create_public_mcp_http_client,
        }
        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _unused,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(name, arguments)
        return _normalize_and_cap(result, project=project)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_seconds or _DEFAULT_TIMEOUT_SECONDS)
    except ExternalMcpError:
        raise
    except TimeoutError as error:
        raise ExternalMcpTimeoutError() from error
    except Exception as error:
        status = _http_status_from_error(error)
        # Provider/SDK exceptions can contain authorization headers, arguments,
        # URLs, and returned document text. Never retain their traceback or
        # model-supplied tool name in application diagnostics.
        logger.warning("external_mcp_client.call_tool_failed status=%s", status)
        if status in {401, 403}:
            raise ExternalMcpAuthError() from error
        raise ExternalMcpError(
            "The external connector request failed.", code="EXTERNAL_MCP_CALL_FAILED"
        ) from error
