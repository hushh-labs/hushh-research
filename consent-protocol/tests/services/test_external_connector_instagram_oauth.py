"""Instagram owner grant and owned-media boundaries, without a live Meta account."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from hushh_mcp.services import external_connector_instagram_oauth as instagram

REDIRECT = "https://one.example/one/profile/connectors/oauth/return"
OWNER = "owner-a"


@pytest.mark.asyncio
async def test_provider_transport_caps_response_and_redacts_error_body(monkeypatch):
    private_detail = "PRIVATE_PROVIDER_RESPONSE_SENTINEL"
    cases = (
        (
            httpx.Response(
                200, stream=httpx.ByteStream(b"x" * (instagram._MAX_RESPONSE_BYTES + 1))
            ),
            "provider_response_invalid",
        ),
        (
            httpx.Response(400, json={"error": private_detail}),
            "grant_rejected",
        ),
    )
    real_client = httpx.AsyncClient
    for response, expected in cases:
        client = real_client(
            transport=httpx.MockTransport(lambda _request, result=response: result)
        )
        monkeypatch.setattr(instagram.httpx, "AsyncClient", lambda client=client, **_: client)
        with pytest.raises(instagram.InstagramConnectorError, match=expected) as caught:
            await instagram.ExternalConnectorInstagramOAuth._request_json(
                "GET", "https://graph.instagram.com/v25.0/me"
            )
        assert private_detail not in str(caught.value)


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(
        instagram,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(app_frontend_origin="https://one.example"),
    )
    monkeypatch.setenv("INSTAGRAM_APP_ID", "synthetic-client")
    monkeypatch.setenv("INSTAGRAM_APP_SECRET", "synthetic-secret")
    connector = SimpleNamespace(
        owner_user_id=None,
        auth_style="oauth",
        transport_kind="instagram_graph_rest",
        mcp_endpoint=instagram.GRAPH_BASE,
        oauth_authorize_url=instagram.AUTHORIZE_URL,
        oauth_token_url=instagram.TOKEN_URL,
        oauth_scopes=instagram.SCOPES,
        oauth_client_id_env="INSTAGRAM_APP_ID",
        oauth_client_secret_env="INSTAGRAM_APP_SECRET",  # noqa: S106 - env var name
        capability_policy=instagram.POLICY,
        registered_redirect_uris=(REDIRECT,),
    )
    credentials = SimpleNamespace(
        encrypt_secret=Mock(return_value={"ciphertext": "sealed", "iv": "nonce"}),
        seal_credential=Mock(return_value={"ciphertext": "sealed-grant"}),
        open_credential=Mock(),
    )
    lifecycle = SimpleNamespace(
        start_attempt=AsyncMock(
            return_value={"expires_at": datetime.now(UTC) + timedelta(minutes=10)}
        ),
        claim_attempt=AsyncMock(),
        finalize=AsyncMock(),
        mark_verified=AsyncMock(return_value=True),
        read=AsyncMock(),
        claim_refresh=AsyncMock(return_value=True),
        settle_refresh=AsyncMock(return_value=True),
        disconnect=AsyncMock(),
        record_revocation=AsyncMock(),
    )
    subject = instagram.ExternalConnectorInstagramOAuth(
        registry=SimpleNamespace(get_connector=AsyncMock(return_value=connector)),
        credentials=credentials,
        lifecycle=lifecycle,
        state_codec=SimpleNamespace(
            _signed_state=lambda attempt: f"signed-{attempt}",
            _verify_state=lambda state: state.removeprefix("signed-"),
        ),
    )
    return subject


@pytest.mark.asyncio
async def test_start_binds_owner_and_exact_return_without_exposing_credential(service):
    with pytest.raises(instagram.InstagramConnectorError, match="redirect_not_registered"):
        await service.start(
            user_id=OWNER,
            redirect_uri="https://other.example/return",
            flow="web",
            profile="selected",
        )
    service.lifecycle.start_attempt.assert_not_awaited()

    result = await service.start(
        user_id=OWNER, redirect_uri=REDIRECT, flow="web", profile="selected"
    )
    query = parse_qs(urlsplit(result["authorizeUrl"]).query)
    assert urlsplit(result["authorizeUrl"]).netloc == "www.instagram.com"
    assert query["redirect_uri"] == [REDIRECT]
    assert set(query["scope"][0].split(",")) == set(instagram.SCOPES)
    assert query["state"] == [f"signed-{result['attemptId']}"]
    assert service.lifecycle.start_attempt.await_args.kwargs["user_id"] == OWNER
    assert service.lifecycle.start_attempt.await_args.kwargs["redirect_uri"] == REDIRECT
    assert "synthetic-secret" not in result["authorizeUrl"]


@pytest.mark.asyncio
async def test_complete_rejects_other_owner_and_missing_scope_before_token_exchange(service):
    service.lifecycle.claim_attempt.return_value = None
    service._short_token = AsyncMock()
    with pytest.raises(instagram.InstagramConnectorError, match="attempt_unavailable"):
        await service.complete(
            state="signed-attempt", code="synthetic-code", expected_user_id="other"
        )
    service.lifecycle.claim_attempt.assert_awaited_once_with(attempt_id="attempt", user_id="other")
    service._short_token.assert_not_awaited()

    service.lifecycle.claim_attempt.return_value = {
        "connector_id": "instagram",
        "flow": "web",
        "oauth_client_id": "synthetic-client",
        "redirect_uri": REDIRECT,
    }
    service._short_token.return_value = {
        "data": [
            {
                "access_token": "synthetic-short",
                "user_id": "123",
                "permissions": "instagram_business_basic",
            }
        ]
    }
    service._long_token = AsyncMock()
    with pytest.raises(instagram.InstagramConnectorError, match="insufficient_scope"):
        await service.complete(
            state="signed-attempt", code="synthetic-code", expected_user_id=OWNER
        )
    service._long_token.assert_not_awaited()
    service.lifecycle.finalize.assert_not_awaited()


@pytest.mark.asyncio
async def test_complete_seals_verified_professional_identity_and_rejects_identity_switch(service):
    service.lifecycle.claim_attempt.return_value = {
        "connector_id": "instagram",
        "flow": "web",
        "oauth_client_id": "synthetic-client",
        "redirect_uri": REDIRECT,
    }
    service._short_token = AsyncMock(
        return_value={
            "data": [
                {
                    "access_token": "synthetic-short",
                    "user_id": "123",
                    "permissions": ",".join(instagram.SCOPES),
                }
            ]
        }
    )
    service._long_token = AsyncMock(
        return_value={
            "access_token": "synthetic-long",
            "expires_in": 3600,
        }
    )
    service._graph_get = AsyncMock(
        return_value={
            "id": "different-app-scoped-id",
            "user_id": "456",
            "username": "owner.business",
            "account_type": "Business",
        }
    )
    with pytest.raises(instagram.InstagramConnectorError, match="provider_identity_invalid"):
        await service.complete(
            state="signed-attempt", code="synthetic-code", expected_user_id=OWNER
        )
    service.lifecycle.finalize.assert_not_awaited()

    service._graph_get.return_value["id"] = "123"

    async def finalize(*, attempt_id, user_id, seal):
        assert (attempt_id, user_id) == ("attempt", OWNER)
        seal({}, {"connection_generation": 4, "credential_version": 2})
        return {"connection_generation": 5, "credential_version": 3}

    service.lifecycle.finalize.side_effect = finalize
    assert await service.complete(
        state="signed-attempt", code="synthetic-code", expected_user_id=OWNER
    ) == {"status": "connected", "connectorId": "instagram"}
    sealed = service.credentials.seal_credential.call_args.kwargs
    assert (sealed["user_id"], sealed["connector_id"]) == (OWNER, "instagram")
    assert (sealed["generation"], sealed["version"]) == (5, 3)
    assert sealed["secret"]["instagramUserId"] == "456"
    assert sealed["secret"]["accessToken"] == "synthetic-long"
    service.lifecycle.mark_verified.assert_awaited_once_with(
        user_id=OWNER,
        connector_id="instagram",
        generation=5,
        version=3,
        policy_hash=instagram.POLICY_HASH,
    )


@pytest.mark.asyncio
async def test_owned_media_uses_granted_account_and_rechecks_connection_before_return(service):
    row = {"status": "connected", "connection_generation": 5, "credential_version": 2}
    service.current_credential = AsyncMock(
        return_value=(
            row,
            {
                "instagramUserId": "456",
                "accessToken": "synthetic-long",
            },
        )
    )
    service.lifecycle.read.return_value = dict(row)
    service._graph_get = AsyncMock(
        return_value={
            "data": [{"id": "88", "permalink": "https://www.instagram.com/p/example/"}],
            "paging": {"cursors": {"after": "next_page"}},
        }
    )
    result = await service.owned_media(user_id=OWNER)
    assert result["posts"][0]["permalink"] == "https://www.instagram.com/p/example/"
    assert result["nextCursor"] == "next_page"
    assert service._graph_get.await_args.args == ("456/media",)
    assert service._graph_get.await_args.kwargs["access_token"] == "synthetic-long"

    service.lifecycle.read.return_value = {**row, "connection_generation": 6}
    with pytest.raises(instagram.InstagramConnectorError, match="connection_changed"):
        await service.owned_media(user_id=OWNER)
    service._graph_get.return_value["data"][0]["permalink"] = "https://other.example/p/example/"
    service.lifecycle.read.return_value = dict(row)
    with pytest.raises(instagram.InstagramConnectorError, match="provider_response_invalid"):
        await service.owned_media(user_id=OWNER)


@pytest.mark.asyncio
async def test_refresh_seals_next_version_and_rejects_disconnect_race(service):
    row = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": instagram.POLICY_HASH,
        "envelope_version": 2,
        "credential_expires_at": datetime.now(UTC) + timedelta(hours=1),
        "connection_generation": 5,
        "credential_version": 2,
    }
    old = {
        "oauthClientId": "synthetic-client",
        "grantedScopes": list(instagram.SCOPES),
        "instagramUserId": "456",
        "accessToken": "synthetic-old",
        "issuedAt": (datetime.now(UTC) - timedelta(days=2)).isoformat(),
    }
    service.credentials.open_credential.return_value = old
    service.lifecycle.read.side_effect = [dict(row), {**row, "credential_version": 3}]
    provider_get = AsyncMock(
        return_value={"access_token": "synthetic-new", "expires_in": 60 * 24 * 3600}
    )
    service._request_json = provider_get
    updated, credential = await service.current_credential(user_id=OWNER)
    assert updated["credential_version"] == 3
    assert credential is old
    assert provider_get.await_args.args == ("GET", instagram.REFRESH_URL)
    assert provider_get.await_args.kwargs["params"] == {
        "grant_type": "ig_refresh_token",
        "access_token": "synthetic-old",
    }
    sealed = service.credentials.seal_credential.call_args.kwargs
    assert (sealed["generation"], sealed["version"]) == (5, 3)
    assert sealed["secret"]["accessToken"] == "synthetic-new"
    assert service.lifecycle.settle_refresh.await_args.kwargs["generation"] == 5

    service.lifecycle.read.side_effect = [dict(row), {**row, "connection_generation": 6}]
    with pytest.raises(instagram.InstagramConnectorError, match="connection_changed"):
        await service.current_credential(user_id=OWNER)


@pytest.mark.asyncio
async def test_disconnect_scrubs_grant_and_records_revocation_fence(service):
    service.lifecycle.disconnect.return_value = {
        "credential_ciphertext": "sealed-grant",
        "connection_generation": 5,
    }
    result = await service.disconnect(user_id=OWNER)
    assert result == {
        "status": "revoked",
        "connectorId": "instagram",
        "revocationOutcome": "unavailable",
    }
    service.lifecycle.disconnect.assert_awaited_once_with(user_id=OWNER, connector_id="instagram")
    service.lifecycle.record_revocation.assert_awaited_once_with(
        user_id=OWNER,
        connector_id="instagram",
        generation=6,
        outcome="unavailable",
        release_fence=True,
    )
