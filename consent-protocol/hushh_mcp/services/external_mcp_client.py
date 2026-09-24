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
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("external_mcp_client")

_DEFAULT_TIMEOUT_SECONDS = 20.0
_MAX_RESULT_BYTES = 32_000


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


def _normalize_and_cap(result: Any) -> ExternalMcpToolResult:
    is_error = bool(getattr(result, "isError", False) or getattr(result, "is_error", False))
    texts: list[str] = []
    for item in getattr(result, "content", None) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            texts.append(text)
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        # MCP structured output is authoritative when supplied. Do not discard
        # it when a provider omits the compatibility TextContent block.
        payload = structured
    elif len(texts) == 1:
        try:
            parsed = json.loads(texts[0])
        except json.JSONDecodeError:
            parsed = {"text": texts[0]}
        payload = parsed if isinstance(parsed, dict) else {"value": parsed}
    else:
        payload = {"content": texts}

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


async def list_tools(
    *, endpoint: str, headers: dict[str, str] | None = None, timeout_seconds: float | None = None
) -> list[dict[str, Any]]:
    """Probe a connector's live tool catalog (name, description, input schema)."""

    async def _run() -> list[dict[str, Any]]:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        client_kwargs: dict[str, Any] = {"headers": dict(headers)} if headers else {}
        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _unused,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.list_tools()
        return [
            {
                "name": tool.name,
                "description": getattr(tool, "description", None) or "",
                "inputSchema": getattr(tool, "inputSchema", None) or {},
            }
            for tool in result.tools
        ]

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_seconds or _DEFAULT_TIMEOUT_SECONDS)
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
) -> ExternalMcpToolResult:
    """Invoke one tool on an external connector's MCP server. Raw result,
    size-capped and lightly normalized -- no CRM-shaped response-contract
    mapping, since an arbitrary connector's tools share no fixed shape."""

    async def _run() -> ExternalMcpToolResult:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        client_kwargs: dict[str, Any] = {"headers": dict(headers)} if headers else {}
        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _unused,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(name, arguments)
        return _normalize_and_cap(result)

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
