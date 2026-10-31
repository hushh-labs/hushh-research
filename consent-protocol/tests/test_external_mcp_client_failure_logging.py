"""A flattened connector failure is diagnosable from its logs without leaking anything."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import pytest

from hushh_mcp.services import external_mcp_client as client

SECRET = "Bearer sk-live-SECRET-token https://private.example/path?code=SECRET-code"


def _failing_transport(error: BaseException):
    @asynccontextmanager
    async def transport(*_args, **_kwargs):
        raise error
        yield  # pragma: no cover - makes this an async generator

    return transport


@pytest.fixture(autouse=True)
def _public_endpoint(monkeypatch):
    # The failure under test is after endpoint admission; keep DNS out of the test.
    monkeypatch.setattr(client, "validate_mcp_endpoint", lambda endpoint: None)


def test_error_types_names_classes_and_follows_groups_and_causes():
    try:
        try:
            raise KeyError(SECRET)
        except KeyError as inner:
            raise ValueError(SECRET) from inner
    except ValueError as outer:
        wrapped = ExceptionGroup(SECRET, [outer])
    types = client._error_types(wrapped)
    assert types.startswith("ExceptionGroup")
    assert "ValueError" in types and "KeyError" in types
    assert "SECRET" not in types and "Bearer" not in types and "private.example" not in types


def test_error_types_stops_on_cycles():
    first, second = RuntimeError("a"), RuntimeError("b")
    first.__cause__, second.__cause__ = second, first
    assert client._error_types(first) == "RuntimeError<RuntimeError"


@pytest.mark.asyncio
async def test_list_tools_still_reports_unreachable_and_logs_only_class_names(monkeypatch, caplog):
    boom = ExceptionGroup(SECRET, [ValueError(SECRET)])
    monkeypatch.setattr(
        "mcp.client.streamable_http.streamablehttp_client", _failing_transport(boom)
    )
    with caplog.at_level(logging.WARNING, logger="external_mcp_client"):
        with pytest.raises(client.ExternalMcpError) as caught:
            await client.list_tools(
                endpoint="https://mcp.example.com/mcp",
                headers={"Authorization": f"Bearer {SECRET}"},
            )
    # The caller-facing contract is unchanged.
    assert caught.value.code == "EXTERNAL_MCP_UNREACHABLE"
    assert str(caught.value) == "Could not reach the external connector."
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "list_tools_failed" in logged
    assert "ExceptionGroup" in logged and "ValueError" in logged
    for forbidden in ("SECRET", "Bearer", "private.example", "sk-live", "mcp.example.com"):
        assert forbidden not in logged


@pytest.mark.asyncio
async def test_list_tools_auth_failure_is_still_an_auth_error(monkeypatch):
    class Unauthorized(Exception):
        response = type("Response", (), {"status_code": 401})()

    monkeypatch.setattr(
        "mcp.client.streamable_http.streamablehttp_client", _failing_transport(Unauthorized(SECRET))
    )
    with pytest.raises(client.ExternalMcpAuthError):
        await client.list_tools(endpoint="https://mcp.example.com/mcp")


@pytest.mark.asyncio
async def test_call_tool_logs_class_names_with_its_existing_status(monkeypatch, caplog):
    monkeypatch.setattr(
        "mcp.client.streamable_http.streamablehttp_client",
        _failing_transport(RuntimeError(SECRET)),
    )
    with caplog.at_level(logging.WARNING, logger="external_mcp_client"):
        with pytest.raises(client.ExternalMcpError) as caught:
            await client.call_tool(
                "search", {"query": SECRET}, endpoint="https://mcp.example.com/mcp"
            )
    assert caught.value.code == "EXTERNAL_MCP_CALL_FAILED"
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "call_tool_failed" in logged and "RuntimeError" in logged
    assert "SECRET" not in logged and "search" not in logged
