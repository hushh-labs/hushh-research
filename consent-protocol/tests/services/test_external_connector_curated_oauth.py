"""Curated (operator-registered) connector OAuth: admission predicate, PKCE
start/exchange, refresh-with-rotation, and policy-hash-gated reconnect --
mocked lifecycle/credentials, no live HubSpot grants."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from hushh_mcp.services import external_connector_curated_oauth as oauth
from hushh_mcp.services.external_connector_registry_service import ExternalMcpConnectorDefinition

GOOD_REDIRECT = "https://uat.one.hushh.ai/one/profile/connectors/oauth/return"
MCP_ENDPOINT = "https://mcp.hubspot.com/"
AUTHORIZE_URL = "https://mcp.hubspot.com/oauth/authorize/user"
TOKEN_URL = "https://mcp.hubspot.com/oauth/v3/token"
CLIENT_ID_ENV = "HUBSPOT_OAUTH_CLIENT_ID"
CLIENT_SECRET_ENV = "HUBSPOT_OAUTH_CLIENT_SECRET"
DEFAULT_REFRESH_TOKEN = "r1"


@pytest.fixture
def connector() -> ExternalMcpConnectorDefinition:
    return ExternalMcpConnectorDefinition(
        connector_id="hubspot",
        display_name="HubSpot",
        description="Connect HubSpot so Kai can read and act on your CRM.",
        mcp_endpoint=MCP_ENDPOINT,
        auth_style="oauth",
        oauth_authorize_url=AUTHORIZE_URL,
        oauth_token_url=TOKEN_URL,
        oauth_scopes=(),
        oauth_client_id_env=CLIENT_ID_ENV,
        oauth_client_secret_env=CLIENT_SECRET_ENV,
        api_key_header_name=None,
        is_active=True,
        transport_kind="mcp",
        capability_policy={"version": 1, "chat": "reviewed"},
        registered_redirect_uris=(GOOD_REDIRECT,),
        owner_user_id=None,
    )


@pytest.fixture
def service() -> oauth.ExternalConnectorCuratedOAuth:
    return oauth.ExternalConnectorCuratedOAuth(
        registry=SimpleNamespace(get_connector=AsyncMock()),
        credentials=SimpleNamespace(
            encrypt_secret=Mock(return_value={"ciphertext": "ct", "iv": "iv", "algorithm": "alg"}),
            decrypt_secret=Mock(return_value=json.dumps({"verifier": "v"})),
            seal_credential=Mock(),
            open_credential=Mock(),
        ),
        lifecycle=SimpleNamespace(
            start_attempt=AsyncMock(),
            claim_attempt=AsyncMock(),
            finalize=AsyncMock(),
            claim_refresh=AsyncMock(),
            settle_refresh=AsyncMock(),
            read=AsyncMock(),
            mark_verified=AsyncMock(),
            disconnect=AsyncMock(),
            record_revocation=AsyncMock(),
        ),
        state_codec=SimpleNamespace(
            _pkce_challenge=lambda verifier: f"challenge-{verifier}",
            _signed_state=lambda attempt_id: f"state-{attempt_id}",
            _verify_state=lambda state: state.removeprefix("state-"),
        ),
    )


def _row(**overrides) -> dict:
    base = dict(
        status="connected",
        envelope_version=2,
        verified_policy_hash=None,
        credential_expires_at=datetime.now(UTC) + timedelta(hours=1),
        connection_generation=3,
        credential_version=2,
    )
    base.update(overrides)
    return base


# --- admission predicate + policy hash -------------------------------------


def test_is_curated_oauth_connector_false_for_none():
    assert oauth.is_curated_oauth_connector(None) is False


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({}, True),
        ({"owner_user_id": "user-1"}, False),
        ({"auth_style": "api_key"}, False),
        ({"transport_kind": "google_drive_rest"}, False),
        ({"capability_policy": {"chat": "unreviewed"}}, False),
        ({"capability_policy": {}}, False),
        ({"connector_id": "google_drive"}, False),
    ],
)
def test_is_curated_oauth_connector_matrix(connector, overrides, expected):
    assert oauth.is_curated_oauth_connector(replace(connector, **overrides)) is expected


def test_curated_policy_hash_ignores_cosmetic_fields_but_reacts_to_functional_ones(connector):
    baseline = oauth.curated_policy_hash(connector)
    cosmetic = replace(connector, display_name="Something else", description="other")
    assert oauth.curated_policy_hash(cosmetic) == baseline
    functional = replace(connector, mcp_endpoint="https://mcp.hubspot.com/other")
    assert oauth.curated_policy_hash(functional) != baseline


# --- _configuration ----------------------------------------------------------


@pytest.mark.asyncio
async def test_configuration_rejects_when_connector_is_not_curated(service, connector, monkeypatch):
    service.registry.get_connector = AsyncMock(return_value=replace(connector, owner_user_id="u1"))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_unavailable") as caught:
        await service._configuration("hubspot")
    assert caught.value.status_code == 503


@pytest.mark.asyncio
async def test_configuration_rejects_when_env_vars_are_missing(service, connector, monkeypatch):
    service.registry.get_connector = AsyncMock(return_value=connector)
    monkeypatch.setattr(oauth, "getenv", lambda name, default="": "")
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_unavailable"):
        await service._configuration("hubspot")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"connector_id": "notion"},
        {"mcp_endpoint": "https://mcp.hubspot.com/other"},
        {"oauth_authorize_url": "https://mcp.hubspot.com/other"},
        {"oauth_token_url": "https://mcp.hubspot.com/other"},
        {"oauth_scopes": ("crm.read",)},
        {"oauth_client_id_env": "DATABASE_URL"},
        {"oauth_client_secret_env": "DATABASE_URL"},
    ],
)
async def test_configuration_rejects_unpinned_endpoint_scope_or_secret_binding(
    service, connector, monkeypatch, overrides
):
    service.registry.get_connector = AsyncMock(return_value=replace(connector, **overrides))
    monkeypatch.setattr(oauth, "getenv", lambda name, default="": "synthetic")

    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"):
        await service._configuration("hubspot")


# --- connection_available ------------------------------------------------


@pytest.mark.asyncio
async def test_connection_available_false_when_feature_disabled(service, connector, monkeypatch):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: False)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    assert await service.connection_available("hubspot", user_id="u1") is False
    service._configuration.assert_not_called()


@pytest.mark.asyncio
async def test_connection_available_false_when_not_configured(service, monkeypatch):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    service._configuration = AsyncMock(
        side_effect=oauth.CuratedConnectorOAuthError("connector_unavailable", status_code=503)
    )
    assert await service.connection_available("hubspot", user_id="u1") is False


@pytest.mark.asyncio
async def test_connection_available_reflects_registered_redirects(service, connector, monkeypatch):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    assert await service.connection_available("hubspot", user_id="u1") is True
    service._configuration.return_value = (
        replace(connector, registered_redirect_uris=()),
        "client-1",
        "secret-1",
    )
    assert await service.connection_available("hubspot", user_id="u1") is False


# --- start -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_rejects_when_feature_disabled(service, monkeypatch):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: False)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_unavailable") as caught:
        await service.start(
            connector_id="hubspot", user_id="u1", redirect_uri=GOOD_REDIRECT, flow="web"
        )
    assert caught.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "redirect_uri,flow",
    [("https://evil.invalid/return", "web"), (GOOD_REDIRECT, "bogus")],
)
async def test_start_rejects_unregistered_redirect_or_unknown_flow(
    service, connector, monkeypatch, redirect_uri, flow
):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="redirect_not_registered"):
        await service.start(
            connector_id="hubspot", user_id="u1", redirect_uri=redirect_uri, flow=flow
        )


@pytest.mark.asyncio
async def test_start_omits_scope_param_when_connector_has_no_scopes(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.lifecycle.start_attempt = AsyncMock(
        return_value={"expires_at": datetime.now(UTC) + timedelta(minutes=10)}
    )
    result = await service.start(
        connector_id="hubspot", user_id="u1", redirect_uri=GOOD_REDIRECT, flow="web"
    )
    assert "scope=" not in result["authorizeUrl"]
    assert result["connectorId"] == "hubspot"


@pytest.mark.asyncio
async def test_start_includes_scope_param_when_connector_has_scopes(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    scoped = replace(connector, oauth_scopes=("crm.read", "crm.write"))
    service._configuration = AsyncMock(return_value=(scoped, "client-1", "secret-1"))
    service.lifecycle.start_attempt = AsyncMock(
        return_value={"expires_at": datetime.now(UTC) + timedelta(minutes=10)}
    )
    result = await service.start(
        connector_id="hubspot", user_id="u1", redirect_uri=GOOD_REDIRECT, flow="web"
    )
    assert "scope=crm.read+crm.write" in result["authorizeUrl"]


# --- _post ---------------------------------------------------------------


def _install_transport(monkeypatch, handler):
    original = httpx.AsyncClient
    captured: dict = {}

    def factory(**kwargs):
        captured.update(kwargs)
        kwargs.pop("transport", None)
        return original(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return captured


@pytest.mark.asyncio
async def test_post_rejects_caller_chosen_endpoint(service, connector):
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"):
        await service._post(
            "https://attacker.invalid", token_url=connector.oauth_token_url, data={}
        )


@pytest.mark.asyncio
async def test_post_never_follows_redirects(service, connector, monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"access_token": "x"})

    captured = _install_transport(monkeypatch, handler)
    await service._post(connector.oauth_token_url, token_url=connector.oauth_token_url, data={})
    assert captured["follow_redirects"] is False
    assert captured["trust_env"] is False
    assert captured["transport"]._max_response_bytes == oauth.RESPONSE_LIMIT


@pytest.mark.asyncio
async def test_post_bounds_response_size_before_json_parsing(service, connector, monkeypatch):
    class Oversized(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"x" * (oauth.RESPONSE_LIMIT + 1)
            raise AssertionError("must stop reading immediately at response budget")

    def handler(request):
        return httpx.Response(200, stream=Oversized())

    _install_transport(monkeypatch, handler)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="provider_response_too_large"):
        await service._post(connector.oauth_token_url, token_url=connector.oauth_token_url, data={})


@pytest.mark.asyncio
async def test_post_maps_public_transport_response_limit_error(service, connector, monkeypatch):
    class LimitedResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def aiter_bytes(self):
            raise oauth.McpResponseLimitError()
            yield b""

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def stream(self, *args, **kwargs):
            return LimitedResponse()

    monkeypatch.setattr(oauth, "create_public_mcp_http_client", lambda **kwargs: Client())
    with pytest.raises(
        oauth.CuratedConnectorOAuthError, match="provider_response_too_large"
    ) as caught:
        await service._post(connector.oauth_token_url, token_url=connector.oauth_token_url, data={})
    assert caught.value.status_code == 502


@pytest.mark.asyncio
async def test_post_maps_unsafe_dns_answer_to_provider_unavailable(service, connector, monkeypatch):
    class UnsafeResponse:
        async def __aenter__(self):
            raise oauth.UnsafeMcpEndpoint()

        async def __aexit__(self, *args):
            return None

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def stream(self, *args, **kwargs):
            return UnsafeResponse()

    monkeypatch.setattr(oauth, "create_public_mcp_http_client", lambda **kwargs: Client())
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="provider_unavailable") as caught:
        await service._post(connector.oauth_token_url, token_url=connector.oauth_token_url, data={})
    assert caught.value.status_code == 503


@pytest.mark.asyncio
async def test_post_maps_invalid_grant_to_grant_rejected(service, connector, monkeypatch):
    def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})

    _install_transport(monkeypatch, handler)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="grant_rejected") as caught:
        await service._post(connector.oauth_token_url, token_url=connector.oauth_token_url, data={})
    assert caught.value.status_code == 401


@pytest.mark.asyncio
async def test_post_maps_other_provider_errors_to_provider_unavailable(
    service, connector, monkeypatch
):
    def handler(request):
        return httpx.Response(500, json={"error": "internal"})

    _install_transport(monkeypatch, handler)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="provider_unavailable") as caught:
        await service._post(connector.oauth_token_url, token_url=connector.oauth_token_url, data={})
    assert caught.value.status_code == 503


# --- _token_fields ---------------------------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        {"access_token": ""},
        {"token_type": "Basic"},
        {"expires_in": -1},
        {"expires_in": True},
        {"expires_in": 9999999},
        {"refresh_token": 12345},
    ],
)
def test_token_fields_rejects_invalid_or_unbounded_values(service, change):
    token = {"access_token": "synthetic", "token_type": "Bearer", "expires_in": 3600, **change}
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="provider_response_invalid"):
        service._token_fields(token)


def test_token_fields_accepts_a_valid_bearer_token_without_refresh(service):
    fields = service._token_fields(
        {"access_token": "tok", "token_type": "Bearer", "expires_in": 3600}
    )
    assert fields["accessToken"] == "tok"
    assert fields["refreshToken"] is None


# --- _seal_activation --------------------------------------------------------


def test_seal_activation_requires_a_refresh_token(service):
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="offline_consent_required"):
        service._seal_activation(
            {"user_id": "u1", "connector_id": "hubspot"},
            {"connection_generation": 4, "credential_version": 2},
            {
                "accessToken": "tok",
                "refreshToken": None,
                "expiresAt": datetime.now(UTC).isoformat(),
            },
        )


def test_seal_activation_increments_generation_and_version(service):
    sealed = {"ciphertext": "c", "iv": "i", "algorithm": "a", "expires_at": datetime.now(UTC)}
    service.credentials.seal_credential = Mock(return_value=sealed)
    result = service._seal_activation(
        {"user_id": "u1", "connector_id": "hubspot"},
        {"connection_generation": 4, "credential_version": 2},
        {
            "accessToken": "tok",
            "refreshToken": "r1",
            "expiresAt": datetime.now(UTC).isoformat(),
        },
    )
    assert result is sealed
    kwargs = service.credentials.seal_credential.call_args.kwargs
    assert kwargs["generation"] == 5
    assert kwargs["version"] == 3


# --- _exchange -----------------------------------------------------------


@pytest.mark.asyncio
async def test_exchange_rejects_replay_or_other_user(service):
    service.lifecycle.claim_attempt = AsyncMock(return_value=None)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="attempt_unavailable") as caught:
        await service._exchange(state="state-attempt-1", code="code", owner="u1")
    assert caught.value.status_code == 409


@pytest.mark.asyncio
async def test_exchange_rejects_when_client_id_drifted(service, connector):
    attempt = dict(
        connector_id="hubspot",
        oauth_client_id="old-client",
        redirect_uri=GOOD_REDIRECT,
        user_id="u1",
        attempt_id="attempt-1",
        code_verifier_ciphertext="ct",
        code_verifier_iv="iv",
    )
    service.lifecycle.claim_attempt = AsyncMock(return_value=attempt)
    service._configuration = AsyncMock(return_value=(connector, "new-client", "secret-1"))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="attempt_configuration_changed"):
        await service._exchange(state="state-attempt-1", code="code", owner="u1")


@pytest.mark.asyncio
async def test_exchange_rejects_when_redirect_drifted(service, connector):
    attempt = dict(
        connector_id="hubspot",
        oauth_client_id="client-1",
        redirect_uri="https://old-redirect.invalid/return",
        user_id="u1",
        attempt_id="attempt-1",
        code_verifier_ciphertext="ct",
        code_verifier_iv="iv",
    )
    service.lifecycle.claim_attempt = AsyncMock(return_value=attempt)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="attempt_configuration_changed"):
        await service._exchange(state="state-attempt-1", code="code", owner="u1")


@pytest.mark.asyncio
async def test_exchange_stamps_oauth_client_id_onto_the_credential(service, connector):
    attempt = dict(
        connector_id="hubspot",
        oauth_client_id="client-1",
        redirect_uri=GOOD_REDIRECT,
        user_id="u1",
        attempt_id="attempt-1",
        code_verifier_ciphertext="ct",
        code_verifier_iv="iv",
    )
    service.lifecycle.claim_attempt = AsyncMock(return_value=attempt)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service._post = AsyncMock(
        return_value={
            "access_token": "tok",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "r1",
        }
    )
    returned_attempt, credential = await service._exchange(
        state="state-attempt-1", code="code", owner="u1"
    )
    assert returned_attempt is attempt
    assert credential["oauthClientId"] == "client-1"
    assert credential["refreshToken"] == "r1"


# --- complete --------------------------------------------------------------


def _web_attempt(**overrides) -> dict:
    base = dict(
        connector_id="hubspot",
        oauth_client_id="client-1",
        redirect_uri=GOOD_REDIRECT,
        user_id="user-1",
        attempt_id="attempt-1",
        flow="web",
        code_verifier_ciphertext="ct",
        code_verifier_iv="iv",
    )
    base.update(overrides)
    return base


def _wire_successful_exchange(service, connector, *, refresh_token=DEFAULT_REFRESH_TOKEN):
    attempt = _web_attempt()
    service.lifecycle.claim_attempt = AsyncMock(return_value=attempt)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    token = {"access_token": "tok", "token_type": "Bearer", "expires_in": 3600}
    if refresh_token is not None:
        token["refresh_token"] = refresh_token
    service._post = AsyncMock(return_value=token)
    return attempt


@pytest.mark.asyncio
async def test_complete_rejects_non_web_flow(service, connector):
    _wire_successful_exchange(service, connector)
    service.lifecycle.claim_attempt = AsyncMock(return_value=_web_attempt(flow="native"))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="attempt_flow_mismatch"):
        await service.complete(state="state-attempt-1", code="code", expected_user_id="user-1")


@pytest.mark.asyncio
async def test_complete_requires_a_refresh_token(service, connector):
    _wire_successful_exchange(service, connector, refresh_token=None)

    async def _finalize(*, attempt_id, user_id, seal):
        return seal(_web_attempt(), {"connection_generation": 4, "credential_version": 1})

    service.lifecycle.finalize = AsyncMock(side_effect=_finalize)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="offline_consent_required"):
        await service.complete(state="state-attempt-1", code="code", expected_user_id="user-1")


@pytest.mark.asyncio
async def test_complete_rejects_duplicate_finalization(service, connector):
    _wire_successful_exchange(service, connector)
    service.lifecycle.finalize = AsyncMock(return_value=None)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="attempt_unavailable"):
        await service.complete(state="state-attempt-1", code="code", expected_user_id="user-1")


@pytest.mark.asyncio
async def test_complete_reports_connected_when_verify_succeeds(service, connector):
    _wire_successful_exchange(service, connector)

    async def _finalize(*, attempt_id, user_id, seal):
        assert attempt_id == "attempt-1"
        return seal(_web_attempt(), {"connection_generation": 4, "credential_version": 1})

    service.lifecycle.finalize = AsyncMock(side_effect=_finalize)
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC),
        }
    )
    service.verify = AsyncMock(return_value=True)

    result = await service.complete(state="state-attempt-1", code="code", expected_user_id="user-1")

    assert result == {"connectorId": "hubspot", "status": "connected"}
    service.verify.assert_awaited_once_with(connector_id="hubspot", user_id="user-1")


@pytest.mark.asyncio
async def test_complete_reports_verifying_when_verify_fails(service, connector):
    _wire_successful_exchange(service, connector)

    async def _finalize(*, attempt_id, user_id, seal):
        return seal(_web_attempt(), {"connection_generation": 4, "credential_version": 1})

    service.lifecycle.finalize = AsyncMock(side_effect=_finalize)
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC),
        }
    )
    service.verify = AsyncMock(
        side_effect=oauth.CuratedConnectorOAuthError("provider_unavailable", status_code=503)
    )

    result = await service.complete(state="state-attempt-1", code="code", expected_user_id="user-1")

    assert result == {"connectorId": "hubspot", "status": "verifying"}


# --- current_credential ------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [None, _row(status="revoked"), _row(status="needs_reauth"), _row(envelope_version=1)],
)
async def test_current_credential_requires_reconnect_for_a_dead_or_legacy_row(service, row):
    service.lifecycle.read = AsyncMock(return_value=row)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="reconnect_required") as caught:
        await service.current_credential(connector_id="hubspot", user_id="u1")
    assert caught.value.status_code == 401


@pytest.mark.asyncio
async def test_current_credential_requires_reconnect_on_policy_hash_drift(service, connector):
    service.lifecycle.read = AsyncMock(return_value=_row(verified_policy_hash="stale-hash"))
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="reconnect_required"):
        await service.current_credential(connector_id="hubspot", user_id="u1")


@pytest.mark.asyncio
async def test_current_credential_requires_reconnect_on_client_id_mismatch(service, connector):
    hash_ = oauth.curated_policy_hash(connector)
    service.lifecycle.read = AsyncMock(return_value=_row(verified_policy_hash=hash_))
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={
            "oauthClientId": "a-different-client",
            "accessToken": "tok",
            "refreshToken": "r",
        }
    )
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="reconnect_required"):
        await service.current_credential(connector_id="hubspot", user_id="u1")


@pytest.mark.asyncio
async def test_current_credential_returns_cached_credential_when_far_from_expiry(
    service, connector
):
    hash_ = oauth.curated_policy_hash(connector)
    row = _row(verified_policy_hash=hash_)
    service.lifecycle.read = AsyncMock(return_value=row)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    credential = {"oauthClientId": "client-1", "accessToken": "tok", "refreshToken": "r"}
    service.credentials.open_credential = Mock(return_value=credential)

    result_row, result_credential = await service.current_credential(
        connector_id="hubspot", user_id="u1"
    )

    assert result_row is row
    assert result_credential is credential
    service.lifecycle.claim_refresh.assert_not_awaited()


@pytest.mark.asyncio
async def test_current_credential_refresh_in_progress_when_claim_fails(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth.asyncio, "sleep", AsyncMock())
    hash_ = oauth.curated_policy_hash(connector)
    row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
    )
    service.lifecycle.read = AsyncMock(return_value=row)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={"oauthClientId": "client-1", "accessToken": "tok", "refreshToken": "r"}
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=None)
    service._post = AsyncMock()

    with pytest.raises(oauth.CuratedConnectorOAuthError, match="refresh_in_progress") as caught:
        await service.current_credential(connector_id="hubspot", user_id="u1")
    assert caught.value.status_code == 409
    service._post.assert_not_called()


@pytest.mark.asyncio
async def test_current_credential_keeps_prior_refresh_token_when_provider_omits_rotation(
    service, connector
):
    hash_ = oauth.curated_policy_hash(connector)
    stale_row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
    )
    fresh_row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(hours=1),
        credential_version=3,
    )
    service.lifecycle.read = AsyncMock(side_effect=[stale_row, fresh_row])
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        side_effect=[
            {
                "oauthClientId": "client-1",
                "accessToken": "old-tok",
                "refreshToken": "prior-refresh",
            },
            {
                "oauthClientId": "client-1",
                "accessToken": "new-tok",
                "refreshToken": "prior-refresh",
            },
        ]
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)
    service._post = AsyncMock(
        return_value={"access_token": "new-tok", "token_type": "Bearer", "expires_in": 3600}
    )
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC) + timedelta(hours=1),
        }
    )

    result_row, result_credential = await service.current_credential(
        connector_id="hubspot", user_id="u1"
    )

    assert result_row is fresh_row
    assert result_credential["refreshToken"] == "prior-refresh"
    sealed_secret = service.credentials.seal_credential.call_args.kwargs["secret"]
    assert sealed_secret["refreshToken"] == "prior-refresh"


@pytest.mark.asyncio
async def test_current_credential_rotates_refresh_token_when_provider_issues_a_new_one(
    service, connector
):
    hash_ = oauth.curated_policy_hash(connector)
    stale_row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
    )
    fresh_row = _row(verified_policy_hash=hash_, credential_version=3)
    service.lifecycle.read = AsyncMock(side_effect=[stale_row, fresh_row])
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={
            "oauthClientId": "client-1",
            "accessToken": "old-tok",
            "refreshToken": "old-refresh",
        }
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)
    service._post = AsyncMock(
        return_value={
            "access_token": "new-tok",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "rotated-refresh",
        }
    )
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC) + timedelta(hours=1),
        }
    )

    await service.current_credential(connector_id="hubspot", user_id="u1")

    sealed_secret = service.credentials.seal_credential.call_args.kwargs["secret"]
    assert sealed_secret["refreshToken"] == "rotated-refresh"


@pytest.mark.asyncio
async def test_current_credential_marks_needs_reauth_on_grant_rejected(service, connector):
    hash_ = oauth.curated_policy_hash(connector)
    row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
    )
    service.lifecycle.read = AsyncMock(return_value=row)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={
            "oauthClientId": "client-1",
            "accessToken": "old-tok",
            "refreshToken": "old-refresh",
        }
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)
    service._post = AsyncMock(
        side_effect=oauth.CuratedConnectorOAuthError("grant_rejected", status_code=401)
    )

    with pytest.raises(oauth.CuratedConnectorOAuthError, match="grant_rejected"):
        await service.current_credential(connector_id="hubspot", user_id="u1")

    service.lifecycle.settle_refresh.assert_awaited_once()
    assert service.lifecycle.settle_refresh.call_args.kwargs["rejected"] is True


@pytest.mark.asyncio
async def test_current_credential_rejects_when_settle_loses_the_refresh_race(service, connector):
    hash_ = oauth.curated_policy_hash(connector)
    row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
    )
    service.lifecycle.read = AsyncMock(return_value=row)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={
            "oauthClientId": "client-1",
            "accessToken": "old-tok",
            "refreshToken": "old-refresh",
        }
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=False)
    service._post = AsyncMock(
        return_value={"access_token": "new-tok", "token_type": "Bearer", "expires_in": 3600}
    )
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC) + timedelta(hours=1),
        }
    )

    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connection_changed"):
        await service.current_credential(connector_id="hubspot", user_id="u1")


@pytest.mark.asyncio
async def test_current_credential_rejects_when_reread_generation_moved(service, connector):
    hash_ = oauth.curated_policy_hash(connector)
    stale_row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
        connection_generation=3,
    )
    moved_row = _row(verified_policy_hash=hash_, connection_generation=4)
    service.lifecycle.read = AsyncMock(side_effect=[stale_row, moved_row])
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={
            "oauthClientId": "client-1",
            "accessToken": "old-tok",
            "refreshToken": "old-refresh",
        }
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)
    service._post = AsyncMock(
        return_value={"access_token": "new-tok", "token_type": "Bearer", "expires_in": 3600}
    )
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC) + timedelta(hours=1),
        }
    )

    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connection_changed"):
        await service.current_credential(connector_id="hubspot", user_id="u1")


# --- disconnect --------------------------------------------------------


@pytest.mark.asyncio
async def test_disconnect_records_revocation_when_a_credential_existed(service):
    service.lifecycle.disconnect = AsyncMock(
        return_value={"credential_ciphertext": "blob", "connection_generation": 5}
    )
    result = await service.disconnect(connector_id="hubspot", user_id="u1")
    assert result == {
        "status": "revoked",
        "connectorId": "hubspot",
        "revocationOutcome": "unavailable",
    }
    service.lifecycle.record_revocation.assert_awaited_once_with(
        user_id="u1",
        connector_id="hubspot",
        generation=6,
        outcome="unavailable",
        release_fence=True,
    )


@pytest.mark.asyncio
async def test_disconnect_skips_revocation_when_nothing_to_revoke(service):
    service.lifecycle.disconnect = AsyncMock(return_value={"credential_ciphertext": None})
    result = await service.disconnect(connector_id="hubspot", user_id="u1")
    assert result["revocationOutcome"] == "not_attempted"
    service.lifecycle.record_revocation.assert_not_awaited()


def test_curated_policy_hash_ignores_the_tool_allowlist_but_not_the_chat_marker(connector):
    baseline = oauth.curated_policy_hash(connector)
    narrowed = replace(
        connector,
        capability_policy={**connector.capability_policy, "tools": ["search_crm_objects"]},
    )
    assert oauth.curated_policy_hash(narrowed) == baseline
    widened = replace(
        connector, capability_policy={**connector.capability_policy, "tools": ["a", "b", "c"]}
    )
    assert oauth.curated_policy_hash(widened) == baseline
    unmarked = replace(connector, capability_policy={"version": 1})
    assert oauth.curated_policy_hash(unmarked) != baseline


# --- verify ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verify_proves_the_bearer_reaches_the_endpoint_before_marking_verified(
    service, connector, monkeypatch
):
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.current_credential = AsyncMock(
        return_value=(
            {"connection_generation": 4, "credential_version": 9},
            {"accessToken": "synthetic-token"},
        )
    )
    list_tools = AsyncMock(return_value=[{"name": "search_crm_objects"}])
    monkeypatch.setattr(oauth, "list_tools", list_tools)
    service.lifecycle.mark_verified = AsyncMock(return_value=True)

    assert await service.verify(connector_id="hubspot", user_id="u1") is True

    list_tools.assert_awaited_once_with(
        endpoint=MCP_ENDPOINT, headers={"Authorization": "Bearer synthetic-token"}
    )
    service.lifecycle.mark_verified.assert_awaited_once_with(
        user_id="u1",
        connector_id="hubspot",
        generation=4,
        version=9,
        policy_hash=oauth.curated_policy_hash(connector),
    )


@pytest.mark.asyncio
async def test_verify_does_not_mark_verified_when_the_server_rejects_the_token(
    service, connector, monkeypatch
):
    from hushh_mcp.services.external_mcp_client import ExternalMcpAuthError

    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.current_credential = AsyncMock(
        return_value=(
            {"connection_generation": 4, "credential_version": 9},
            {"accessToken": "synthetic-token"},
        )
    )
    monkeypatch.setattr(oauth, "list_tools", AsyncMock(side_effect=ExternalMcpAuthError()))
    service.lifecycle.mark_verified = AsyncMock(return_value=True)

    with pytest.raises(ExternalMcpAuthError):
        await service.verify(connector_id="hubspot", user_id="u1")

    service.lifecycle.mark_verified.assert_not_awaited()


# --- committed descriptor <-> reviewed runtime pin ---------------------------


def test_committed_hubspot_manifest_yields_a_row_that_satisfies_its_own_pin():
    """The registry row applied from the committed manifest must satisfy the
    manifest pin, otherwise HubSpot silently reads as unavailable."""
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    manifest = get_manifest("hubspot")
    assert manifest is not None
    descriptor = manifest.to_descriptor("uat")
    row = ExternalMcpConnectorDefinition.from_row(
        {
            "connector_id": descriptor["connectorId"],
            "display_name": descriptor["displayName"],
            "description": descriptor["description"],
            "mcp_endpoint": descriptor["mcpEndpoint"],
            "auth_style": descriptor["authStyle"],
            "oauth_authorize_url": descriptor["oauthAuthorizeUrl"],
            "oauth_token_url": descriptor["oauthTokenUrl"],
            "oauth_scopes": " ".join(descriptor["oauthScopes"]),
            "oauth_client_id_env": descriptor["oauthClientIdEnv"],
            "oauth_client_secret_env": descriptor["oauthClientSecretEnv"],
            "is_active": True,
            "transport_kind": "mcp",
            "capability_policy": {"version": 1, "chat": descriptor["chatAdmission"]},
            "registered_redirect_uris": descriptor["registeredRedirectUris"],
        }
    )
    assert oauth.is_curated_oauth_connector(row)
    assert (
        row.mcp_endpoint,
        row.oauth_authorize_url,
        row.oauth_token_url,
        row.oauth_scopes,
        row.oauth_client_id_env,
        row.oauth_client_secret_env,
    ) == manifest.pin()
    # The shipped HubSpot pin is unchanged from the reviewed original, so no
    # existing connection is invalidated by moving it onto a manifest.
    assert manifest.pin() == (
        "https://mcp.hubspot.com/",
        "https://mcp.hubspot.com/oauth/authorize/user",
        "https://mcp.hubspot.com/oauth/v3/token",
        (),
        "HUBSPOT_OAUTH_CLIENT_ID",
        "HUBSPOT_OAUTH_CLIENT_SECRET",
    )


# --- refresh robustness (review findings) ------------------------------------


def _near_expiry_setup(service, connector):
    hash_ = oauth.curated_policy_hash(connector)
    row = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
        user_id="u1",
        connector_id="hubspot",
    )
    service.lifecycle.read = AsyncMock(return_value=row)
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={"oauthClientId": "client-1", "accessToken": "old", "refreshToken": "old-r"}
    )
    service._post = AsyncMock(
        return_value={
            "access_token": "new",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "rotated",
        }
    )
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC) + timedelta(hours=1),
        }
    )
    return row


@pytest.mark.asyncio
async def test_concurrent_refresh_loser_uses_the_winners_fresh_credential(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth.asyncio, "sleep", AsyncMock())
    stale = _near_expiry_setup(service, connector)
    fresh = {**stale, "credential_expires_at": datetime.now(UTC) + timedelta(hours=1)}
    service.lifecycle.read = AsyncMock(side_effect=[stale, fresh])
    service.lifecycle.claim_refresh = AsyncMock(return_value=None)
    service.credentials.open_credential = Mock(
        return_value={"oauthClientId": "client-1", "accessToken": "won", "refreshToken": "r"}
    )

    row, credential = await service.current_credential(connector_id="hubspot", user_id="u1")

    assert row is fresh and credential["accessToken"] == "won"
    service._post.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_refresh_loser_rejects_a_credential_for_another_client(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth.asyncio, "sleep", AsyncMock())
    stale = _near_expiry_setup(service, connector)
    fresh = {**stale, "credential_expires_at": datetime.now(UTC) + timedelta(hours=1)}
    service.lifecycle.read = AsyncMock(side_effect=[stale, fresh, fresh, fresh])
    service.lifecycle.claim_refresh = AsyncMock(return_value=None)
    service.credentials.open_credential = Mock(
        side_effect=[
            {"oauthClientId": "client-1", "accessToken": "old", "refreshToken": "r"},
            {"oauthClientId": "other-client", "accessToken": "x", "refreshToken": "r"},
        ]
    )
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="refresh_in_progress"):
        await service.current_credential(connector_id="hubspot", user_id="u1")


@pytest.mark.asyncio
async def test_rotated_token_persist_is_retried_after_a_transient_storage_error(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth.asyncio, "sleep", AsyncMock())
    stale = _near_expiry_setup(service, connector)
    fresh = {**stale, "credential_expires_at": datetime.now(UTC) + timedelta(hours=1)}
    service.lifecycle.read = AsyncMock(side_effect=[stale, fresh])
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(
        side_effect=[oauth.ConnectorLifecycleError("connector_storage_unavailable"), True]
    )

    await service.current_credential(connector_id="hubspot", user_id="u1")

    assert service.lifecycle.settle_refresh.await_count == 2
    for call in service.lifecycle.settle_refresh.await_args_list:
        assert call.kwargs["envelope"] is service.credentials.seal_credential.return_value


@pytest.mark.asyncio
async def test_persist_failure_after_provider_rotation_releases_the_lease(
    service, connector, monkeypatch
):
    monkeypatch.setattr(oauth.asyncio, "sleep", AsyncMock())
    _near_expiry_setup(service, connector)
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    storage_down = oauth.ConnectorLifecycleError("connector_storage_unavailable")

    async def settle(**kwargs):
        if kwargs.get("envelope") is not None:
            raise storage_down
        return True

    service.lifecycle.settle_refresh = AsyncMock(side_effect=settle)

    with pytest.raises(oauth.ConnectorLifecycleError):
        await service.current_credential(connector_id="hubspot", user_id="u1")

    persist_attempts = [
        c for c in service.lifecycle.settle_refresh.await_args_list if c.kwargs.get("envelope")
    ]
    assert len(persist_attempts) == 3
    release = service.lifecycle.settle_refresh.await_args_list[-1].kwargs
    assert release.get("envelope") is None and release.get("rejected", False) is False


@pytest.mark.asyncio
async def test_cancelled_refresh_still_releases_the_lease(service, connector):
    import asyncio

    _near_expiry_setup(service, connector)
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)
    service._post = AsyncMock(side_effect=asyncio.CancelledError())

    with pytest.raises(asyncio.CancelledError):
        await service.current_credential(connector_id="hubspot", user_id="u1")

    service.lifecycle.settle_refresh.assert_awaited_once()
    assert service.lifecycle.settle_refresh.await_args.kwargs.get("envelope") is None


@pytest.mark.asyncio
async def test_refresh_uses_a_shorter_provider_timeout_than_the_turn_deadline(service, connector):
    _near_expiry_setup(service, connector)
    stale_then_fresh = [
        service.lifecycle.read.return_value,
        {
            **service.lifecycle.read.return_value,
            "credential_expires_at": datetime.now(UTC) + timedelta(hours=1),
        },
    ]
    service.lifecycle.read = AsyncMock(side_effect=stale_then_fresh)
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)

    await service.current_credential(connector_id="hubspot", user_id="u1")

    assert service._post.await_args.kwargs["timeout_seconds"] == oauth._REFRESH_POST_TIMEOUT < 20


# --- hot-path round trips ------------------------------------------------------


@pytest.mark.asyncio
async def test_current_credential_reuses_the_callers_connector_and_skips_the_purge(
    service, connector
):
    hash_ = oauth.curated_policy_hash(connector)
    row = _row(verified_policy_hash=hash_)
    service.lifecycle.read = AsyncMock(return_value=row)
    service.registry.get_connector = AsyncMock()
    service.credentials.open_credential = Mock(
        return_value={"oauthClientId": "client-1", "accessToken": "tok", "refreshToken": "r"}
    )
    monkey_env = {"HUBSPOT_OAUTH_CLIENT_ID": "client-1", "HUBSPOT_OAUTH_CLIENT_SECRET": "secret-1"}
    original = oauth.getenv
    oauth.getenv = lambda name, default="": monkey_env.get(name, default)
    try:
        await service.current_credential(connector_id="hubspot", user_id="u1", connector=connector)
    finally:
        oauth.getenv = original

    service.registry.get_connector.assert_not_awaited()
    service.lifecycle.read.assert_awaited_once_with(
        user_id="u1", connector_id="hubspot", purge=False
    )


@pytest.mark.asyncio
async def test_configuration_ignores_a_passed_connector_for_a_different_id(service, connector):
    other = replace(connector, connector_id="notion")
    service.registry.get_connector = AsyncMock(return_value=None)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_unavailable"):
        await service._configuration("hubspot", other)
    service.registry.get_connector.assert_awaited_once_with("hubspot")


# --- reviewed free-read pin -----------------------------------------------------


def test_hubspot_free_reads_are_pinned_and_are_only_reads():
    reads = oauth.curated_free_read_tools("hubspot")
    assert len(reads) == 10
    # Nothing that can change data is ever on the list.
    assert not any(name.startswith("manage_") for name in reads)
    assert {"manage_crm_objects", "manage_custom_properties"}.isdisjoint(reads)


def test_pinned_free_reads_are_all_in_the_committed_tool_allowlist():
    """A pinned read the manifest does not expose could never run; catch drift."""
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    manifest = get_manifest("hubspot")
    assert manifest is not None
    assert oauth.curated_free_read_tools("hubspot") <= set(manifest.tool_allowlist)


def test_an_unlisted_provider_has_no_free_reads():
    assert oauth.curated_free_read_tools("no_such_provider") == frozenset()
    assert oauth.curated_free_read_tools("") == frozenset()


# --- provider token revocation on disconnect --------------------------------------

REVOKE_URL = "https://mcp.notion.com/token"


@pytest.fixture
def revoking(service, connector, monkeypatch):
    """A public-client provider (Notion) that declares a revocation endpoint."""
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    manifest = replace(get_manifest("notion"), revocation_url=REVOKE_URL)
    monkeypatch.setattr(oauth, "get_manifest", lambda connector_id: manifest)
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "client-1")
    # The registry row is never consulted: a deactivated or drifted row must not stop a
    # person's own grant being revoked.
    service._configuration = AsyncMock(
        side_effect=oauth.CuratedConnectorOAuthError("connector_unavailable", status_code=503)
    )
    service.lifecycle.disconnect = AsyncMock(
        return_value={
            "credential_ciphertext": "blob",
            "connection_generation": 5,
            "envelope_version": 2,
        }
    )
    service.credentials.open_credential = Mock(
        return_value={
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
            "oauthClientId": "client-1",
        }
    )
    return service


def _revocation_requests(monkeypatch, status=200):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(status)

    _install_transport(monkeypatch, handler)
    return seen


@pytest.mark.asyncio
async def test_disconnect_revokes_the_refresh_token_at_a_declared_endpoint(revoking, monkeypatch):
    seen = _revocation_requests(monkeypatch)
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "revoked"
    (request,) = seen
    assert str(request.url) == REVOKE_URL and request.method == "POST"
    body = dict(item.split("=", 1) for item in request.content.decode().split("&"))
    assert body == {
        "token": "refresh-1",
        "token_type_hint": "refresh_token",
        "client_id": "client-1",
    }
    # A revoked token clears the durable reconnect fence; nothing else does.
    revoking.lifecycle.record_revocation.assert_awaited_once_with(
        user_id="u1", connector_id="notion", generation=6, outcome="revoked"
    )


@pytest.mark.asyncio
async def test_disconnect_falls_back_to_the_access_token_without_a_refresh_token(
    revoking, monkeypatch
):
    revoking.credentials.open_credential = Mock(
        return_value={"accessToken": "access-1", "oauthClientId": "client-1"}
    )
    seen = _revocation_requests(monkeypatch)
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "revoked"
    assert b"token=access-1" in seen[0].content
    assert b"token_type_hint=access_token" in seen[0].content


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 429, 500, 503])
async def test_a_provider_refusal_is_recorded_as_failed_and_the_local_scrub_stands(
    revoking, monkeypatch, status
):
    _revocation_requests(monkeypatch, status=status)
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result == {"status": "revoked", "connectorId": "notion", "revocationOutcome": "failed"}
    revoking.lifecycle.record_revocation.assert_awaited_once_with(
        user_id="u1", connector_id="notion", generation=6, outcome="failed"
    )


@pytest.mark.asyncio
async def test_a_network_failure_is_recorded_as_failed(revoking, monkeypatch):
    def handler(request):
        raise httpx.ConnectError("down")

    _install_transport(monkeypatch, handler)
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "failed"


@pytest.mark.asyncio
async def test_a_stalled_provider_is_cut_off_and_recorded_as_failed(revoking, monkeypatch):
    class Stalled(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(30)
            yield b""

    def handler(request):
        return httpx.Response(200, stream=Stalled())

    _install_transport(monkeypatch, handler)
    real_timeout = asyncio.timeout
    monkeypatch.setattr(oauth.asyncio, "timeout", lambda _seconds: real_timeout(0.1))
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "failed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", ["legacy_envelope", "client_changed", "undecryptable", "client_not_mounted"]
)
async def test_an_unverifiable_credential_is_never_presented_to_the_provider(
    revoking, monkeypatch, case
):
    seen = _revocation_requests(monkeypatch)
    if case == "legacy_envelope":
        revoking.lifecycle.disconnect.return_value["envelope_version"] = 1
    elif case == "client_changed":
        revoking.credentials.open_credential = Mock(
            return_value={"refreshToken": "refresh-1", "oauthClientId": "another-client"}
        )
    elif case == "undecryptable":
        from hushh_mcp.services.external_connector_credentials_service import (
            ExternalConnectorCredentialError,
        )

        revoking.credentials.open_credential = Mock(
            side_effect=ExternalConnectorCredentialError("synthetic")
        )
    else:
        monkeypatch.delenv("NOTION_OAUTH_CLIENT_ID")
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "failed"
    assert seen == []


@pytest.mark.asyncio
async def test_a_non_public_revocation_endpoint_is_refused(revoking, monkeypatch):
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    internal = replace(get_manifest("notion"), revocation_url="https://127.0.0.1/revoke")
    monkeypatch.setattr(oauth, "get_manifest", lambda connector_id: internal)
    seen = _revocation_requests(monkeypatch)
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "failed"
    assert seen == []


@pytest.mark.asyncio
async def test_a_confidential_client_sends_its_secret_with_the_revocation(revoking, monkeypatch):
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    confidential = replace(get_manifest("hubspot"), revocation_url=REVOKE_URL)
    monkeypatch.setattr(oauth, "get_manifest", lambda connector_id: confidential)
    monkeypatch.setenv("HUBSPOT_OAUTH_CLIENT_ID", "client-1")
    monkeypatch.setenv("HUBSPOT_OAUTH_CLIENT_SECRET", "secret-1")
    seen = _revocation_requests(monkeypatch)
    await revoking.disconnect(connector_id="hubspot", user_id="u1")
    assert b"client_secret=secret-1" in seen[0].content


@pytest.mark.asyncio
async def test_a_confidential_client_with_no_secret_mounted_sends_nothing(revoking, monkeypatch):
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    confidential = replace(get_manifest("hubspot"), revocation_url=REVOKE_URL)
    monkeypatch.setattr(oauth, "get_manifest", lambda connector_id: confidential)
    monkeypatch.setenv("HUBSPOT_OAUTH_CLIENT_ID", "client-1")
    monkeypatch.delenv("HUBSPOT_OAUTH_CLIENT_SECRET", raising=False)
    seen = _revocation_requests(monkeypatch)
    result = await revoking.disconnect(connector_id="hubspot", user_id="u1")
    assert result["revocationOutcome"] == "failed" and seen == []


@pytest.mark.asyncio
async def test_a_deactivated_connector_is_still_revoked_on_disconnect(revoking, monkeypatch):
    """An operator deactivating a provider must not strand a person's grant at the provider."""
    seen = _revocation_requests(monkeypatch)
    result = await revoking.disconnect(connector_id="notion", user_id="u1")
    assert result["revocationOutcome"] == "revoked" and len(seen) == 1
    revoking._configuration.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_provider_without_a_declared_endpoint_keeps_the_unavailable_outcome(
    service, monkeypatch
):
    """HubSpot and Attio publish no revocation endpoint: nothing is sent anywhere."""
    seen = _revocation_requests(monkeypatch)
    service.lifecycle.disconnect = AsyncMock(
        return_value={"credential_ciphertext": "blob", "connection_generation": 5}
    )
    result = await service.disconnect(connector_id="hubspot", user_id="u1")
    assert result["revocationOutcome"] == "unavailable"
    assert seen == []
    service.lifecycle.record_revocation.assert_awaited_once_with(
        user_id="u1",
        connector_id="hubspot",
        generation=6,
        outcome="unavailable",
        release_fence=True,
    )


# --- a refresh that loses a race with a disconnect must not leave a live token behind ---


def _racing_refresh(service, connector, monkeypatch, *, stored, reread):
    from hushh_mcp.services.curated_connector_manifest import get_manifest

    manifest = replace(get_manifest("hubspot"), revocation_url="https://mcp.hubspot.com/revoke")
    monkeypatch.setattr(oauth, "get_manifest", lambda connector_id: manifest)
    hash_ = oauth.curated_policy_hash(connector)
    stale = _row(
        verified_policy_hash=hash_,
        credential_expires_at=datetime.now(UTC) + timedelta(seconds=10),
        connection_generation=3,
    )
    service.lifecycle.read = AsyncMock(side_effect=[stale, reread] if reread else [stale])
    service._configuration = AsyncMock(return_value=(connector, "client-1", "secret-1"))
    service.credentials.open_credential = Mock(
        return_value={"oauthClientId": "client-1", "accessToken": "old", "refreshToken": "old-r"}
    )
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=stored)
    service._post = AsyncMock(
        return_value={
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "token_type": "Bearer",
            "expires_in": 3600,
        }
    )
    service.credentials.seal_credential = Mock(
        return_value={
            "ciphertext": "c",
            "iv": "i",
            "algorithm": "a",
            "expires_at": datetime.now(UTC) + timedelta(hours=1),
        }
    )
    service._revoke = AsyncMock()


@pytest.mark.asyncio
async def test_a_disconnect_during_the_refresh_revokes_the_token_that_could_not_be_stored(
    service, connector, monkeypatch
):
    _racing_refresh(service, connector, monkeypatch, stored=False, reread=None)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connection_changed"):
        await service.current_credential(connector_id="hubspot", user_id="u1")
    service._revoke.assert_awaited_once()
    data = service._revoke.await_args.kwargs["data"]
    assert data["token"] == "new-refresh" and data["token_type_hint"] == "refresh_token"
    assert service._revoke.await_args.kwargs["url"] == "https://mcp.hubspot.com/revoke"


@pytest.mark.asyncio
async def test_a_connection_that_moved_after_the_refresh_also_revokes_the_new_token(
    service, connector, monkeypatch
):
    hash_ = oauth.curated_policy_hash(connector)
    _racing_refresh(
        service,
        connector,
        monkeypatch,
        stored=True,
        reread=_row(verified_policy_hash=hash_, connection_generation=4),
    )
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connection_changed"):
        await service.current_credential(connector_id="hubspot", user_id="u1")
    service._revoke.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_failed_revoke_of_the_unstored_token_never_masks_the_real_outcome(
    service, connector, monkeypatch, caplog
):
    _racing_refresh(service, connector, monkeypatch, stored=False, reread=None)
    service._revoke.side_effect = oauth.CuratedConnectorOAuthError("provider_unavailable")
    with caplog.at_level("WARNING", logger=oauth.logger.name):
        with pytest.raises(oauth.CuratedConnectorOAuthError, match="connection_changed"):
            await service.current_credential(connector_id="hubspot", user_id="u1")
    assert "unstored_revoke_failed" in caplog.text
    assert "new-refresh" not in caplog.text


@pytest.mark.asyncio
async def test_a_refresh_that_succeeds_never_revokes_anything(service, connector, monkeypatch):
    hash_ = oauth.curated_policy_hash(connector)
    _racing_refresh(
        service,
        connector,
        monkeypatch,
        stored=True,
        reread=_row(verified_policy_hash=hash_, connection_generation=3),
    )
    await service.current_credential(connector_id="hubspot", user_id="u1")
    service._revoke.assert_not_awaited()


# --- a connection that needs signing in again is not "never connected" -----------


@pytest.mark.asyncio
@pytest.mark.parametrize("row", [None, _row(status="revoked")])
async def test_never_connected_or_disconnected_is_the_quiet_kind(service, row):
    service.lifecycle.read = AsyncMock(return_value=row)
    with pytest.raises(oauth.CuratedNotConnectedError):
        await service.current_credential(connector_id="hubspot", user_id="u1")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [_row(status="needs_reauth"), _row(status="error"), _row(envelope_version=1)],
    ids=["needs_reauth", "error", "legacy_envelope"],
)
async def test_a_connection_that_stopped_working_is_not_the_quiet_kind(service, row):
    """The provider rejected the refresh token: the person did connect it, so chat must say so."""
    service.lifecycle.read = AsyncMock(return_value=row)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="reconnect_required") as caught:
        await service.current_credential(connector_id="hubspot", user_id="u1")
    assert not isinstance(caught.value, oauth.CuratedNotConnectedError)
    assert caught.value.status_code == 401


# --- token endpoint rejections leave a trace -------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "logged"),
    [
        ({"error": "invalid_client"}, "error=invalid.client"),
        ({"error": "server_error"}, "error=server.error"),
        ({"error": "PRIVATE_PROVIDER_TEXT"}, "error=other"),
        ({}, "error=other"),
    ],
)
async def test_a_token_endpoint_rejection_is_logged_with_a_fixed_vocabulary(
    service, connector, monkeypatch, caplog, body, logged
):
    def handler(request):
        return httpx.Response(400, json=body)

    _install_transport(monkeypatch, handler)
    with caplog.at_level("WARNING", logger=oauth.logger.name):
        with pytest.raises(oauth.CuratedConnectorOAuthError):
            await service._post(
                connector.oauth_token_url, token_url=connector.oauth_token_url, data={"code": "x"}
            )
    line = next(
        r.getMessage() for r in caplog.records if "curated_oauth.token_endpoint" in r.getMessage()
    )
    assert "status=400" in line and logged in line
    assert "mcp.hubspot.com" in line
    assert "PRIVATE_PROVIDER_TEXT" not in caplog.text
    # Nothing the redactor would mask: no long snake_case token in the line.
    from mcp_modules.log_redaction import redact_log_value

    assert redact_log_value(line) == line
