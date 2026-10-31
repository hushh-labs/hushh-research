"""CRM transport contracts independent of registry and intent persistence."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from hushh_mcp.services.connected_systems_service import (
    REGISTRY_MCP_ENDPOINT,
    ConnectedSystemConfigurationError,
    ExternalCrmStreamableMcpAdapter,
)


@pytest.mark.asyncio
async def test_missing_omni_gateway_headers_fail_before_streamable_http_call():
    adapter = ExternalCrmStreamableMcpAdapter(endpoint=REGISTRY_MCP_ENDPOINT)

    with pytest.raises(ConnectedSystemConfigurationError) as error:
        await adapter.call_operation(
            operation="schema",
            tool_name="object-schema",
            endpoint=REGISTRY_MCP_ENDPOINT,
            timeout_seconds=1,
            retry_count=0,
            arguments={"target": "Example", "objectType": "Person"},
        )

    assert error.value.code == "CONNECTED_SYSTEM_GATEWAY_AUTH_UNCONFIGURED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("gateway_status", "expected_code"),
    [
        (401, "CONNECTED_SYSTEM_MCP_AUTH_FAILED"),
        (403, "CONNECTED_SYSTEM_MCP_ACCESS_DENIED"),
    ],
)
async def test_gateway_auth_failures_return_safe_configuration_errors(
    monkeypatch, gateway_status, expected_code
):
    import contextlib

    import mcp.client.streamable_http as streamable_mod

    class GatewayStatusError(Exception):
        def __init__(self, status_code: int):
            self.response = type("Response", (), {"status_code": status_code})()
            super().__init__(f"HTTP {status_code}")

    @contextlib.asynccontextmanager
    async def rejected_streamable(*_args, **_kwargs):
        raise GatewayStatusError(gateway_status)
        yield  # pragma: no cover - required only to make this an async generator

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", rejected_streamable)
    adapter = ExternalCrmStreamableMcpAdapter(
        endpoint="https://gateway.invalid/mcp",
        headers=(("client_id", "test-client"), ("client_secret", "test-secret")),
    )

    with pytest.raises(ConnectedSystemConfigurationError) as error:
        await adapter.call_operation(
            operation="schema",
            tool_name="object-schema",
            endpoint="https://gateway.invalid/mcp",
            timeout_seconds=1,
            retry_count=0,
            arguments={"target": "Example", "objectType": "Person"},
        )

    assert error.value.code == expected_code
    assert "gateway" in str(error.value).lower()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("registered_endpoint", "operation_endpoint", "denied"),
    [
        ("https://mcp.stripe.com", None, True),
        ("https://mcp.stripe.com/", None, True),
        ("http://mcp.stripe.com", None, True),
        ("https://mcp.stripe.com./mcp", None, True),
        ("https://mcp\u3002stripe.com/mcp", None, True),
        ("https://mcp.stripe\uff0ecom/mcp", None, True),
        ("https://mcp.stripe.com\uff61/mcp", None, True),
        ("https://MCP.STRIPE.COM/mcp?alias=crm", None, True),
        ("https://mcp.stripe.com:443/custom", None, True),
        ("https://gateway.invalid/mcp", "https://mcp.stripe.com/api", True),
        ("https://gateway.invalid/mcp", None, False),
    ],
)
async def test_stripe_cannot_bypass_governed_tools_through_crm(
    monkeypatch, registered_endpoint, operation_endpoint, denied
):
    import mcp.client.session as session_mod
    import mcp.client.streamable_http as streamable_mod

    calls = []

    @asynccontextmanager
    async def transport(endpoint, **kwargs):
        calls.append((endpoint, kwargs))
        yield None, None, None

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def initialize(self):
            return None

        async def call_tool(self, name, arguments):
            calls.append((name, arguments))
            return SimpleNamespace(content=[], isError=False)

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", transport)
    monkeypatch.setattr(session_mod, "ClientSession", lambda *_: Session())
    adapter = ExternalCrmStreamableMcpAdapter(
        endpoint=registered_endpoint,
        headers=(("Authorization", "Bearer synthetic-owner-credential"),),
    )
    operation = adapter.call_operation(
        operation="update",
        tool_name="stripe_api_write",
        endpoint=operation_endpoint,
        timeout_seconds=1,
        retry_count=4,
        arguments={"method": "POST", "path": "/v1/refunds"},
    )
    if denied:
        with pytest.raises(ConnectedSystemConfigurationError) as error:
            await operation
        assert error.value.code == "CONNECTED_SYSTEM_STRIPE_TRANSPORT_DENIED"
        assert error.value.status_code == 403
        assert calls == []
        return
    assert await operation == {"isError": False, "payload": {"content": []}}
    assert len(calls) == 2
    assert calls[0][0] == registered_endpoint
    assert calls[1][0] == "stripe_api_write"


@pytest.mark.asyncio
async def test_invalid_idna_crm_host_is_denied_before_network(monkeypatch):
    import mcp.client.streamable_http as streamable_mod

    calls = []

    def forbidden_network(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("Invalid endpoint reached the transport")

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", forbidden_network)
    adapter = ExternalCrmStreamableMcpAdapter(endpoint="https://mcp.\ud800stripe.com")
    with pytest.raises(ConnectedSystemConfigurationError) as error:
        await adapter.update_record({})
    assert error.value.code == "CONNECTED_SYSTEM_MCP_ENDPOINT_INVALID"
    assert calls == []
