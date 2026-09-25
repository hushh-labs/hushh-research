"""Synthetic SDK-port proof only; no provider, browser or OAuth endpoint admission."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from mcp.client.auth.oauth2 import OAuthClientProvider
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

from hushh_mcp.one_adk import request_secrets
from hushh_mcp.one_adk.mcp_oauth_storage import EphemeralMcpOAuthStorage


@pytest.mark.asyncio
async def test_sdk_authorization_delivers_tokens_once_without_durable_storage():
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    redirect = {}

    async def navigate(url):
        redirect.update(parse_qs(urlsplit(url).query))

    async def callback():
        return "synthetic-code", redirect["state"][0]

    def respond(request):
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
                    "issuer": "https://auth.example",
                    "authorization_endpoint": "https://auth.example/authorize",
                    "token_endpoint": "https://auth.example/token",
                    "registration_endpoint": "https://auth.example/register",
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"],
                },
            )
        if request.url.path == "/register":
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

    provider = OAuthClientProvider(
        "https://connector.example/mcp",
        OAuthClientMetadata(
            redirect_uris=["https://app.example/return"],
            token_endpoint_auth_method="none",  # noqa: S106 - OAuth public-client method
        ),
        storage,
        navigate,
        callback,
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(respond), auth=provider
        ) as client:
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
