"""Real SDK handshake with synthetic HTTP/OAuth; not a live provider proof."""

import asyncio
import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from hushh_mcp.one_adk.mcp_oauth_connection import McpOAuthConnection
from hushh_mcp.one_adk.mcp_oauth_storage import McpOAuthConnectError


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_connection_handshake_and_owner_bound_single_delivery(monkeypatch, cancel):
    methods = []

    def respond(request):
        path = request.url.path
        if path == "/mcp":
            if request.headers.get("authorization") != "Bearer synthetic-access":
                return httpx.Response(
                    401,
                    headers={
                        "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/resource"'
                    },
                )
            message = json.loads(request.content)
            methods.append(message["method"])
            if message["method"] == "initialize":
                return httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {},
                            "serverInfo": {"name": "synthetic", "version": "1"},
                        },
                    },
                )
            return httpx.Response(202)
        if path == "/resource":
            return httpx.Response(
                200,
                json={
                    "resource": "https://mcp.example/mcp",
                    "authorization_servers": ["https://auth.example"],
                },
            )
        if "/.well-known/" in path:
            return httpx.Response(
                200,
                json={
                    "issuer": "https://auth.example",
                    "authorization_endpoint": "https://auth.example/authorize",
                    "token_endpoint": "https://auth.example/token",
                    "registration_endpoint": "https://auth.example/register",
                    "code_challenge_methods_supported": ["S256"],
                    "authorization_response_iss_parameter_supported": True,
                },
            )
        if path == "/register":
            return httpx.Response(
                201,
                json={
                    "client_id": "synthetic-client",
                    "redirect_uris": ["https://app.example/return"],
                    "token_endpoint_auth_method": "none",
                },
            )
        if path == "/token":
            return httpx.Response(
                200,
                json={
                    "access_token": "synthetic-access",
                    "refresh_token": "synthetic-refresh",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
            )
        raise AssertionError("Unexpected synthetic endpoint")

    attempt = McpOAuthConnection(
        owner_id="owner",
        connector_id="custom_fixture",
        revision="revision",
        endpoint="https://mcp.example/mcp",
        redirect_uri="https://app.example/return",
    )
    monkeypatch.setattr(
        attempt._provider,
        "create_http_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond), auth=attempt._provider),
    )
    try:
        url = await attempt.start()
        if cancel:
            task = attempt._task
            attempt.close()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert attempt._task is None
            assert attempt._redirect.cancelled()
            assert attempt._provider.context.current_tokens is None
            return
        state = parse_qs(urlsplit(url).query)["state"][0]
        values = dict(
            owner_id="owner",
            connector_id="custom_fixture",
            revision="revision",
            code="synthetic-code",
            state=state,
            issuer="https://auth.example",
        )
        with pytest.raises(McpOAuthConnectError):
            await attempt.complete(**{**values, "owner_id": "other"})
        result = await attempt.complete(**values)
        assert result.tokens.access_token == "synthetic-access"
        assert "initialize" in methods
        assert "tools/call" not in methods
        assert attempt._task is None
        assert attempt._redirect.cancelled()
        assert attempt._provider.context.current_tokens is None
        with pytest.raises(McpOAuthConnectError):
            await attempt.complete(**values)
    finally:
        attempt.close()
