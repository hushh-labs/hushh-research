"""CRM MCP network transport; official Stripe tools use their governed connector."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from hushh_mcp.services.connected_systems_errors import (
    ConnectedSystemConfigurationError,
    ConnectedSystemsError,
)
from hushh_mcp.services.stripe_mcp_policy import official_stripe_endpoint

logger = logging.getLogger(__name__)


def require_crm_endpoint(endpoint: str) -> None:
    try:
        stripe_host = official_stripe_endpoint(endpoint)
    except ValueError:
        raise ConnectedSystemConfigurationError(
            "The connected system endpoint is invalid.",
            code="CONNECTED_SYSTEM_MCP_ENDPOINT_INVALID",
        ) from None
    if stripe_host:
        raise ConnectedSystemConfigurationError(
            "Connect Stripe through its governed read-only connector.",
            code="CONNECTED_SYSTEM_STRIPE_TRANSPORT_DENIED",
            status_code=403,
        )


async def call_crm_mcp_tool(
    name: str,
    tool_arguments: dict[str, Any],
    *,
    endpoint: str,
    headers: tuple[tuple[str, str], ...],
    timeout_seconds: float,
) -> dict[str, Any]:
    require_crm_endpoint(endpoint)

    async def _run() -> dict[str, Any]:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        client_kwargs: dict[str, Any] = {}
        if headers:
            client_kwargs["headers"] = dict(headers)

        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(name, tool_arguments)
        return _normalize_mcp_tool_result(result)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_seconds)
    except ConnectedSystemsError:
        raise
    except TimeoutError as error:
        raise ConnectedSystemsError(
            "Connected system request timed out.",
            code="CONNECTED_SYSTEM_MCP_TIMEOUT",
            status_code=504,
        ) from error
    except Exception as error:
        gateway_status = _http_status_from_error(error)
        logger.exception(
            "connected_systems.crm_mcp_request_failed tool=%s endpoint_configured=%s "
            "headers_present=%s gateway_status=%s tool_argument_keys=%s",
            name,
            bool(endpoint),
            bool(headers),
            gateway_status,
            sorted(str(key) for key in tool_arguments),
        )
        if gateway_status in {401, 403}:
            code = (
                "CONNECTED_SYSTEM_MCP_AUTH_FAILED"
                if gateway_status == 401
                else "CONNECTED_SYSTEM_MCP_ACCESS_DENIED"
            )
            message = (
                "The connected system gateway rejected this environment's authentication."
                if gateway_status == 401
                else "The connected system gateway denied this environment access."
            )
            raise ConnectedSystemConfigurationError(
                message,
                code=code,
                status_code=502,
            ) from error
        raise ConnectedSystemsError(
            "Connected system request failed.",
            code="CONNECTED_SYSTEM_MCP_FAILED",
            status_code=502,
        ) from error


def _http_status_from_error(error: BaseException, *, _seen: set[int] | None = None) -> int | None:
    """Find a nested HTTP status without serialising a provider exception."""
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


def _normalize_mcp_tool_result(result: Any) -> dict[str, Any]:
    is_error = bool(getattr(result, "isError", False) or getattr(result, "is_error", False))
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
        if isinstance(parsed, dict):
            return {"isError": is_error, "payload": parsed}
        return {"isError": is_error, "payload": {"value": parsed}}
    return {"isError": is_error, "payload": {"content": texts}}
