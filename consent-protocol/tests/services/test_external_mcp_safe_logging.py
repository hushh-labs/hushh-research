"""Provider exceptions must not put document or credential text into logs."""

from contextlib import asynccontextmanager

import pytest

from hushh_mcp.services.external_mcp_client import ExternalMcpError, call_tool


@pytest.mark.asyncio
async def test_tool_failure_logs_only_sanitized_status(monkeypatch, caplog):
    @asynccontextmanager
    async def failed_transport(*args, **kwargs):
        raise RuntimeError("synthetic-private-document-and-bearer-value")
        yield  # pragma: no cover - establishes an async context manager

    monkeypatch.setattr("mcp.client.streamable_http.streamablehttp_client", failed_transport)
    with caplog.at_level("WARNING", logger="external_mcp_client"):
        with pytest.raises(ExternalMcpError) as error:
            await call_tool(
                "synthetic-private-tool-argument",
                {},
                endpoint="https://example.test/mcp",
            )
    assert error.value.code == "EXTERNAL_MCP_CALL_FAILED"
    assert "synthetic-private" not in caplog.text
    assert "call_tool_failed status=None" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)
