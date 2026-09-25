"""Synthetic SDK-port proof only; no provider, browser or OAuth endpoint admission."""

import asyncio
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

from hushh_mcp.one_adk import request_secrets
from hushh_mcp.one_adk.mcp_oauth_storage import (
    ConnectOnlyMcpOAuthProvider,
    EphemeralMcpOAuthStorage,
    McpOAuthConnectError,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "token_failure",
    [False, True, "callback_timeout", "issuer_mismatch", "private_token_endpoint", "missing_pkce"],
)
async def test_sdk_authorization_delivers_tokens_once_without_durable_storage(
    caplog, token_failure
):
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    redirect = {}
    visited = []

    async def navigate(url):
        redirect.update(parse_qs(urlsplit(url).query))

    async def callback():
        if token_failure == "callback_timeout":
            await asyncio.sleep(60)
        return "synthetic-code", redirect["state"][0]

    def respond(request):
        visited.append(request.url.path)
        if request.url.path == "/mcp":
            if request.headers.get("authorization") == "Bearer synthetic-access":
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": 'Bearer resource_metadata="https://connector.example/resource"'
                },
            )
        if request.url.path == "/resource":
            return httpx.Response(
                200,
                json={
                    "resource": "https://connector.example/mcp",
                    "authorization_servers": ["https://auth.example"],
                    "scopes_supported": ["read"],
                },
            )
        if "/.well-known/" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "issuer": "https://other.example"
                    if token_failure == "issuer_mismatch"
                    else "https://auth.example",
                    "authorization_endpoint": "https://auth.example/authorize",
                    "token_endpoint": "https://127.0.0.1/token"
                    if token_failure == "private_token_endpoint"
                    else "https://auth.example/token",
                    "registration_endpoint": "https://auth.example/register",
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": []
                    if token_failure == "missing_pkce"
                    else ["S256"],
                },
            )
        if request.url.path == "/register":
            assert token_failure not in {
                "issuer_mismatch",
                "private_token_endpoint",
                "missing_pkce",
            }
            return httpx.Response(
                201,
                json={
                    "client_id": "synthetic-client",
                    "redirect_uris": ["https://app.example/return"],
                    "token_endpoint_auth_method": "none",
                },
            )
        if request.url.path == "/token":
            body = parse_qs(request.content.decode())
            assert body["code"] == ["synthetic-code"]
            assert body["code_verifier"]
            if token_failure:
                return httpx.Response(400, text="synthetic-private-token-body")
            return httpx.Response(
                200,
                json={
                    "access_token": "synthetic-access",
                    "refresh_token": "synthetic-refresh",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": "read",
                },
            )
        raise AssertionError("Unexpected synthetic OAuth request")

    provider = ConnectOnlyMcpOAuthProvider(
        "https://connector.example/mcp",
        OAuthClientMetadata(
            redirect_uris=["https://app.example/return"],
            token_endpoint_auth_method="none",  # noqa: S106 - OAuth public-client method
        ),
        storage,
        navigate,
        callback,
    )
    if token_failure == "callback_timeout":
        storage._deadline = time.monotonic() + 0.02
    try:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(respond), auth=provider
        ) as client:
            if token_failure:
                with pytest.raises(McpOAuthConnectError) as error:
                    await client.get("https://connector.example/mcp")
                assert "synthetic-private-token-body" not in str(error.value)
                if token_failure is True:
                    assert "MCP OAuth protocol event" in caplog.text
                    assert "/token" in visited
                if token_failure in {"issuer_mismatch", "private_token_endpoint", "missing_pkce"}:
                    assert any("/.well-known/" in path for path in visited)
                    assert "/register" not in visited
                    assert "/token" not in visited
                    assert not redirect
                if token_failure == "callback_timeout":
                    assert redirect
                    assert "/token" not in visited
                assert storage._closed
                assert "synthetic-private-token-body" not in caplog.text
                assert "synthetic-code" not in caplog.text
                assert all(record.exc_info is None for record in caplog.records)
                return
            assert (
                await client.get(
                    "https://connector.example/mcp", headers={"MCP-Protocol-Version": "2025-11-25"}
                )
            ).status_code == 200
        token_ref, client_ref = storage._tokens, storage._client
        result = await storage.take_result()
        assert result.tokens.access_token == "synthetic-access"
        assert result.tokens.refresh_token == "synthetic-refresh"
        assert result.client_info.client_id == "synthetic-client"
        assert result.expires_at is not None
        assert "synthetic" not in repr(result)
        assert request_secrets.resolve_request_secret(token_ref) == ""
        assert request_secrets.resolve_request_secret(client_ref) == ""
        with pytest.raises(ValueError, match="expired or changed"):
            await storage.take_result()
    finally:
        storage.close()


@pytest.mark.asyncio
async def test_owner_change_clears_credentials_and_rejects_delivery():
    current = True
    storage = EphemeralMcpOAuthStorage(is_current=lambda: current)
    await storage.set_tokens(OAuthToken(access_token="synthetic-access"))  # noqa: S106 - synthetic SDK fixture
    reference = storage._tokens
    current = False
    with pytest.raises(ValueError, match="expired or changed"):
        await storage.get_tokens()
    assert request_secrets.resolve_request_secret(reference) == ""


@pytest.mark.asyncio
async def test_storage_copies_models_and_clears_incomplete_result():
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    info = OAuthClientInformationFull(
        client_id="synthetic-client", redirect_uris=["https://app.example/return"]
    )
    await storage.set_client_info(info)
    info.client_id = "changed"
    assert (await storage.get_client_info()).client_id == "synthetic-client"
    reference = storage._client
    with pytest.raises(ValueError, match="incomplete"):
        await storage.take_result()
    assert request_secrets.resolve_request_secret(reference) == ""


@pytest.mark.asyncio
async def test_expired_attempt_clears_credentials(monkeypatch):
    from hushh_mcp.one_adk import mcp_oauth_storage

    clock = [100.0]
    monkeypatch.setattr(mcp_oauth_storage.time, "monotonic", lambda: clock[0])
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True, ttl_seconds=10)
    await storage.set_tokens(OAuthToken(access_token="synthetic-access"))  # noqa: S106 - synthetic SDK fixture
    reference = storage._tokens
    clock[0] = 111.0
    with pytest.raises(ValueError, match="expired or changed"):
        await storage.get_tokens()
    assert reference not in request_secrets._values


@pytest.mark.asyncio
async def test_oversized_result_closes_storage_without_echoing_secret():
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    with pytest.raises(ValueError, match="too large") as error:
        await storage.set_tokens(OAuthToken(access_token="synthetic-secret" * 3000))
    assert "synthetic-secret" not in str(error.value)
    with pytest.raises(ValueError, match="expired or changed"):
        await storage.get_tokens()


@pytest.mark.asyncio
async def test_connect_oauth_never_replays_tool_mutations():
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    provider = ConnectOnlyMcpOAuthProvider(
        "https://connector.example/mcp",
        OAuthClientMetadata(redirect_uris=["https://app.example/return"]),
        storage,
    )

    def unexpected(request):
        raise AssertionError("A tool mutation must not reach OAuth transport")

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(unexpected), auth=provider
    ) as client:
        with pytest.raises(McpOAuthConnectError):
            await client.post(
                "https://connector.example/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "send"},
                },
            )
    assert storage._closed


@pytest.mark.asyncio
async def test_fresh_provider_rejects_loaded_refresh_credentials_before_network():
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    await storage.set_tokens(
        OAuthToken(access_token="synthetic-access", refresh_token="synthetic-refresh")  # noqa: S106 - synthetic SDK fixture
    )
    provider = ConnectOnlyMcpOAuthProvider(
        "https://connector.example/mcp",
        OAuthClientMetadata(redirect_uris=["https://app.example/return"]),
        storage,
    )
    flow = provider.async_auth_flow(httpx.Request("GET", "https://connector.example/mcp"))
    with pytest.raises(McpOAuthConnectError):
        await anext(flow)
    assert storage._closed


@pytest.mark.asyncio
async def test_abandoned_connect_generator_clears_storage():
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    provider = ConnectOnlyMcpOAuthProvider(
        "https://connector.example/mcp",
        OAuthClientMetadata(redirect_uris=["https://app.example/return"]),
        storage,
    )
    flow = provider.async_auth_flow(httpx.Request("GET", "https://connector.example/mcp"))
    await anext(flow)
    await flow.aclose()
    assert storage._closed
