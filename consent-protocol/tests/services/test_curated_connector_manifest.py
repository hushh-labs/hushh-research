"""Curated connector manifests: one contract test over EVERY checked-in manifest,
strict-parser negatives, and public-client (PKCE, no secret) adapter behaviour.

Adding a provider means adding `config/curated_connectors/<id>.json`; the
parametrized tests below pick it up automatically, so a new provider gets the
security checks without any new test code."""

from __future__ import annotations

import copy
import json
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services import external_connector_curated_oauth as oauth
from hushh_mcp.services import external_connector_google_oauth as google_oauth
from hushh_mcp.services.curated_connector_manifest import (
    MANIFEST_DIR,
    REGISTRATION_SPEC_DIR,
    CuratedConnectorManifestError,
    all_catalog_entries,
    all_manifests,
    all_registration_specs,
    clear_manifest_cache,
    clear_registration_spec_cache,
    get_manifest,
    get_registration_spec,
    load_manifest_file,
    load_registration_spec_file,
    manifest_errors,
    parse_manifest,
    parse_registration_spec,
    registration_spec_errors,
)
from hushh_mcp.services.external_connector_registry_service import ExternalMcpConnectorDefinition
from hushh_mcp.services.external_mcp_connector_descriptor import validate_descriptor

MANIFESTS = all_manifests()
REGISTRATION_SPECS = all_registration_specs()
# A name that changes data must never be listed as a free read. This is a
# tripwire on top of the exact-name list and the server's own read-only
# annotation, not a substitute for reading the tool list.
WRITE_LIKE = re.compile(
    r"(create|update|delete|remove|manage|move|write|send|post|patch|put|archive|merge|"
    r"duplicate|spawn|stop|upload|attach|convert|edit|set|add|insert)",
    re.IGNORECASE,
)


def test_there_is_at_least_one_manifest_and_none_failed_to_load():
    assert MANIFESTS, "no curated connector manifests found"
    assert manifest_errors() == {}


def test_attio_registration_spec_is_valid_but_never_becomes_a_runtime_manifest():
    assert registration_spec_errors() == {}
    assert set(REGISTRATION_SPECS) == {"attio"}
    assert get_manifest("attio") is None
    assert get_registration_spec("attio") == REGISTRATION_SPECS["attio"]
    assert not (MANIFEST_DIR / "attio.json").exists()

    spec = REGISTRATION_SPECS["attio"]
    assert spec.display_name == "Attio"
    assert spec.description == "Connect Attio after setup is complete."
    assert spec.is_public_client is True
    assert spec.client_id_env == "ATTIO_OAUTH_CLIENT_ID"
    assert spec.secret_env_names == ("ATTIO_OAUTH_CLIENT_ID",)
    assert spec.registration_url == "https://app.attio.com/oauth/register"
    assert spec.redirect_uris["uat"] == (
        "https://uat.one.hushh.ai/one/profile/connectors/oauth/return",
    )


def test_catalog_entries_project_only_reviewed_display_metadata_and_setup_state():
    entries = all_catalog_entries()
    assert set(entries) == {"hubspot", "notion", "attio"}
    assert entries["hubspot"].catalog_state == "setup_pending"
    assert entries["notion"].catalog_state == "setup_pending"
    assert entries["attio"].catalog_state == "discovery_pending"
    assert entries["attio"].display_name == "Attio"
    assert entries["attio"].description == "Connect Attio after setup is complete."
    assert not hasattr(entries["attio"], "mcp_endpoint")


@pytest.fixture
def raw() -> dict:
    return json.loads((MANIFEST_DIR / "hubspot.json").read_text(encoding="utf-8"))


# --- contract over every checked-in manifest ---------------------------------


@pytest.mark.parametrize("connector_id", sorted(MANIFESTS))
class TestEveryManifest:
    def test_file_name_matches_connector_id(self, connector_id):
        assert (MANIFEST_DIR / f"{connector_id}.json").is_file()

    def test_secret_names_follow_the_convention(self, connector_id):
        manifest = MANIFESTS[connector_id]
        assert manifest.client_id_env == f"{connector_id.upper()}_OAUTH_CLIENT_ID"
        if manifest.is_public_client:
            assert manifest.client_secret_env is None
            assert manifest.registration_url is not None
        else:
            assert manifest.client_secret_env == f"{connector_id.upper()}_OAUTH_CLIENT_SECRET"
            assert manifest.registration_url is None

    def test_free_reads_are_a_subset_of_the_allowlist(self, connector_id):
        manifest = MANIFESTS[connector_id]
        assert manifest.free_read_tools <= set(manifest.tool_allowlist)

    def test_no_free_read_looks_like_a_write(self, connector_id):
        for name in MANIFESTS[connector_id].free_read_tools:
            assert not WRITE_LIKE.search(name), f"{connector_id}: {name} looks like a write"

    def test_at_least_one_tool_keeps_review(self, connector_id):
        """A provider must always have something that still needs a review card;
        otherwise a change could run with no approval at all."""
        manifest = MANIFESTS[connector_id]
        assert set(manifest.tool_allowlist) - manifest.free_read_tools

    def test_every_environment_yields_a_valid_descriptor(self, connector_id):
        manifest = MANIFESTS[connector_id]
        for environment in manifest.redirect_uris:
            descriptor = validate_descriptor(manifest.to_descriptor(environment)).raw
            assert descriptor["chatAdmission"] == "reviewed"
            assert descriptor["toolAllowlist"] == list(manifest.tool_allowlist)
            assert all(uri.startswith("https://") for uri in descriptor["registeredRedirectUris"])
            assert ("oauthClientSecretEnv" in descriptor) == (not manifest.is_public_client)

    def test_the_pin_matches_the_descriptor_row(self, connector_id):
        manifest = MANIFESTS[connector_id]
        descriptor = manifest.to_descriptor(next(iter(manifest.redirect_uris)))
        assert (
            descriptor["mcpEndpoint"],
            descriptor["oauthAuthorizeUrl"],
            descriptor["oauthTokenUrl"],
            tuple(descriptor["oauthScopes"]),
            descriptor["oauthClientIdEnv"],
            descriptor.get("oauthClientSecretEnv"),
        ) == manifest.pin()

    def test_a_row_built_from_the_manifest_is_served(self, connector_id):
        manifest = MANIFESTS[connector_id]
        descriptor = manifest.to_descriptor(next(iter(manifest.redirect_uris)))
        row = ExternalMcpConnectorDefinition.from_row(
            {
                "connector_id": connector_id,
                "display_name": descriptor["displayName"],
                "description": descriptor["description"],
                "mcp_endpoint": descriptor["mcpEndpoint"],
                "auth_style": "oauth",
                "oauth_authorize_url": descriptor["oauthAuthorizeUrl"],
                "oauth_token_url": descriptor["oauthTokenUrl"],
                "oauth_scopes": " ".join(descriptor["oauthScopes"]),
                "oauth_client_id_env": descriptor["oauthClientIdEnv"],
                "oauth_client_secret_env": descriptor.get("oauthClientSecretEnv"),
                "is_active": True,
                "transport_kind": "mcp",
                "capability_policy": {"version": 1, "chat": "reviewed"},
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


# --- strict parser -----------------------------------------------------------


def test_the_committed_manifests_round_trip_through_the_file_loader():
    for connector_id in MANIFESTS:
        assert load_manifest_file(MANIFEST_DIR / f"{connector_id}.json") == MANIFESTS[connector_id]


def test_the_committed_registration_specs_round_trip_without_a_runtime_descriptor():
    for connector_id, spec in REGISTRATION_SPECS.items():
        assert load_registration_spec_file(REGISTRATION_SPEC_DIR / f"{connector_id}.json") == spec
        assert not hasattr(spec, "to_descriptor")


@pytest.mark.parametrize(
    "mutate,message",
    [
        (lambda m: m.update(version="curated-connector.v2"), "version"),
        (lambda m: m.update(surprise=True), "unknown keys"),
        (lambda m: m.update(connectorId="google_drive"), "connectorId"),
        (lambda m: m.update(connectorId="custom_thing"), "connectorId"),
        (lambda m: m.update(connectorId="Bad-Id"), "connectorId"),
        (lambda m: m.update(displayName=""), "displayName"),
        (lambda m: m.update(mcpEndpoint="http://mcp.hubspot.com/"), "mcpEndpoint"),
        (lambda m: m.update(mcpEndpoint="https://localhost/"), "mcpEndpoint"),
        (lambda m: m["oauth"].update(tokenUrl="http://mcp.hubspot.com/t"), "tokenUrl"),
        (lambda m: m["oauth"].update(authorizeUrl="https://127.0.0.1/a"), "authorizeUrl"),
        (lambda m: m["oauth"].update(scopes="default"), "scopes"),
        (lambda m: m["oauth"].update(tokenEndpointAuth="client_secret_basic"), "tokenEndpointAuth"),
        (lambda m: m["oauth"].update(clientIdEnv="OTHER_CLIENT_ID"), "clientIdEnv"),
        (lambda m: m["oauth"].update(clientSecretEnv="OTHER_SECRET"), "clientSecretEnv"),
        (lambda m: m["oauth"].pop("clientSecretEnv"), "clientSecretEnv"),
        (
            lambda m: m["oauth"].update(registrationUrl="https://mcp.hubspot.com/register"),
            "confidential client",
        ),
        (lambda m: m["oauth"].update(extra=1), "unknown keys"),
        (lambda m: m["tools"].update(allowlist=[]), "allowlist"),
        (lambda m: m["tools"].update(allowlist=["a", "a"]), "allowlist"),
        (lambda m: m["tools"].update(allowlist=["bad name"]), "allowlist"),
        (lambda m: m["tools"].update(freeRead=["not_in_allowlist"]), "subset"),
        (lambda m: m["tools"].update(extra=[]), "unknown keys"),
        (lambda m: m.update(environments={}), "environments"),
        (
            lambda m: m.update(
                environments={"prod": {"registeredRedirectUris": ["https://a.test/"]}}
            ),
            "environment",
        ),
        (
            lambda m: m["environments"]["uat"].update(registeredRedirectUris=[]),
            "registeredRedirectUris",
        ),
        (
            lambda m: m["environments"]["uat"].update(
                registeredRedirectUris=["http://uat.test/cb"]
            ),
            "registeredRedirectUris",
        ),
    ],
)
def test_the_parser_rejects_anything_unreviewed(raw, mutate, message):
    candidate = copy.deepcopy(raw)
    mutate(candidate)
    with pytest.raises(CuratedConnectorManifestError, match=message):
        parse_manifest(candidate)


def test_a_public_client_must_not_name_a_secret_variable():
    notion = json.loads((MANIFEST_DIR / "notion.json").read_text(encoding="utf-8"))
    notion["oauth"]["clientSecretEnv"] = "NOTION_OAUTH_CLIENT_SECRET"
    with pytest.raises(CuratedConnectorManifestError, match="public client"):
        parse_manifest(notion)


def test_a_public_client_must_pin_a_public_registration_endpoint():
    notion = json.loads((MANIFEST_DIR / "notion.json").read_text(encoding="utf-8"))
    notion["oauth"].pop("registrationUrl")
    with pytest.raises(CuratedConnectorManifestError, match="registrationUrl"):
        parse_manifest(notion)
    notion["oauth"]["registrationUrl"] = "http://mcp.notion.com/register"
    with pytest.raises(CuratedConnectorManifestError, match="registrationUrl"):
        parse_manifest(notion)


@pytest.mark.parametrize(
    "mutate,message",
    [
        (lambda spec: spec.update(tools={"allowlist": ["guessed"]}), "unknown keys"),
        (lambda spec: spec.update(displayName=""), "displayName"),
        (
            lambda spec: spec["oauth"].update(tokenEndpointAuth="client_secret_post"),
            "registration-only spec",
        ),
        (
            lambda spec: spec["oauth"].update(clientSecretEnv="ATTIO_OAUTH_CLIENT_SECRET"),
            "public client",
        ),
        (lambda spec: spec["oauth"].pop("registrationUrl"), "registrationUrl"),
        (
            lambda spec: spec["oauth"].update(registrationUrl="http://app.attio.com/register"),
            "registrationUrl",
        ),
    ],
)
def test_registration_spec_rejects_runtime_tools_and_unsafe_client_shapes(mutate, message):
    raw = json.loads((REGISTRATION_SPEC_DIR / "attio.json").read_text(encoding="utf-8"))
    mutate(raw)
    with pytest.raises(CuratedConnectorManifestError, match=message):
        parse_registration_spec(raw)


def test_an_empty_scope_list_is_valid(raw):
    raw["oauth"]["scopes"] = []
    assert parse_manifest(raw).scopes == ()


def test_to_descriptor_rejects_an_environment_without_redirects(raw):
    with pytest.raises(CuratedConnectorManifestError, match="redirect addresses"):
        parse_manifest(raw).to_descriptor("production")


def test_an_unknown_provider_has_no_manifest_and_no_free_reads():
    assert get_manifest("no_such_provider") is None
    assert oauth.curated_free_read_tools("no_such_provider") == frozenset()


def test_one_bad_manifest_does_not_take_the_others_down(tmp_path, monkeypatch):
    from hushh_mcp.services import curated_connector_manifest as module

    good = (MANIFEST_DIR / "hubspot.json").read_text(encoding="utf-8")
    (tmp_path / "hubspot.json").write_text(good, encoding="utf-8")
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "wrongname.json").write_text(good, encoding="utf-8")
    monkeypatch.setattr(module, "MANIFEST_DIR", tmp_path)
    clear_manifest_cache()
    try:
        assert module.get_manifest("hubspot") is not None
        assert set(module.manifest_errors()) == {"broken.json", "wrongname.json"}
    finally:
        monkeypatch.undo()
        clear_manifest_cache()


def test_a_registration_only_spec_fails_closed_if_a_runtime_manifest_is_added(
    tmp_path, monkeypatch
):
    from hushh_mcp.services import curated_connector_manifest as module

    runtime_dir = tmp_path / "runtime"
    registration_dir = tmp_path / "registration"
    runtime_dir.mkdir()
    registration_dir.mkdir()
    runtime = json.loads((MANIFEST_DIR / "notion.json").read_text(encoding="utf-8"))
    runtime["connectorId"] = "attio"
    runtime["oauth"]["clientIdEnv"] = "ATTIO_OAUTH_CLIENT_ID"
    (runtime_dir / "attio.json").write_text(json.dumps(runtime), encoding="utf-8")
    (registration_dir / "attio.json").write_text(
        (REGISTRATION_SPEC_DIR / "attio.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "MANIFEST_DIR", runtime_dir)
    monkeypatch.setattr(module, "REGISTRATION_SPEC_DIR", registration_dir)
    clear_manifest_cache()
    clear_registration_spec_cache()
    try:
        assert module.get_manifest("attio") is not None
        assert module.get_registration_spec("attio") is None
        assert set(module.registration_spec_errors()) == {"attio.json"}
    finally:
        monkeypatch.undo()
        clear_manifest_cache()
        clear_registration_spec_cache()


# --- public client (PKCE, no secret) ------------------------------------------

NOTION = MANIFESTS["notion"]
REDIRECT = NOTION.redirect_uris["uat"][0]


@pytest.fixture
def notion_row() -> ExternalMcpConnectorDefinition:
    return ExternalMcpConnectorDefinition(
        connector_id="notion",
        display_name=NOTION.display_name,
        description=NOTION.description,
        mcp_endpoint=NOTION.mcp_endpoint,
        auth_style="oauth",
        oauth_authorize_url=NOTION.authorize_url,
        oauth_token_url=NOTION.token_url,
        oauth_scopes=NOTION.scopes,
        oauth_client_id_env=NOTION.client_id_env,
        oauth_client_secret_env=None,
        api_key_header_name=None,
        is_active=True,
        transport_kind="mcp",
        capability_policy={"version": 1, "chat": "reviewed"},
        registered_redirect_uris=(REDIRECT,),
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
            claim_refresh=AsyncMock(),
            settle_refresh=AsyncMock(),
            read=AsyncMock(),
        ),
        state_codec=SimpleNamespace(
            _pkce_challenge=lambda verifier: f"challenge-{verifier}",
            _signed_state=lambda attempt_id: f"state-{attempt_id}",
            _verify_state=lambda state: state.removeprefix("state-"),
        ),
    )


@pytest.mark.asyncio
async def test_a_public_client_needs_only_a_client_id(service, notion_row, monkeypatch):
    service.registry.get_connector = AsyncMock(return_value=notion_row)
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "public-client-id")
    monkeypatch.delenv("NOTION_OAUTH_CLIENT_SECRET", raising=False)
    row, client_id, client_secret = await service._configuration("notion")
    assert row is notion_row
    assert (client_id, client_secret) == ("public-client-id", None)


@pytest.mark.asyncio
async def test_a_public_client_never_reads_a_secret_variable(service, notion_row, monkeypatch):
    service.registry.get_connector = AsyncMock(return_value=notion_row)
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "public-client-id")
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_SECRET", "must-not-be-used")
    _, _, client_secret = await service._configuration("notion")
    assert client_secret is None


@pytest.mark.asyncio
async def test_a_public_client_without_a_client_id_is_unavailable(service, notion_row, monkeypatch):
    service.registry.get_connector = AsyncMock(return_value=notion_row)
    monkeypatch.delenv("NOTION_OAUTH_CLIENT_ID", raising=False)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_unavailable"):
        await service._configuration("notion")


@pytest.mark.asyncio
async def test_a_row_that_names_a_secret_for_a_public_client_is_rejected(
    service, notion_row, monkeypatch
):
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "public-client-id")
    drifted = replace(
        notion_row,
        oauth_client_secret_env="NOTION_OAUTH_CLIENT_SECRET",  # noqa: S106 - variable name
    )
    service.registry.get_connector = AsyncMock(return_value=drifted)
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"):
        await service._configuration("notion")


@pytest.mark.asyncio
async def test_a_row_that_adds_an_unreviewed_redirect_is_never_served(
    service, notion_row, monkeypatch
):
    env_read = Mock(return_value="public-client-id")
    monkeypatch.setattr(oauth, "getenv", env_read)
    service.registry.get_connector = AsyncMock(
        return_value=replace(
            notion_row,
            registered_redirect_uris=(
                REDIRECT,
                "https://unreviewed.example/one/profile/connectors/oauth/return",
            ),
        )
    )
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"):
        await service._configuration("notion")
    env_read.assert_not_called()


def test_a_valid_manifest_row_keeps_the_development_loopback_callback(monkeypatch, notion_row):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setattr(
        google_oauth,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(app_frontend_origin="http://localhost:3000"),
    )
    assert oauth.registered_redirect_uris(notion_row) == (
        REDIRECT,
        "http://localhost:3000/one/profile/connectors/oauth/return",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("mcp_endpoint", "https://evil.example/mcp"),
        ("oauth_token_url", "https://evil.example/token"),
        ("oauth_authorize_url", "https://evil.example/authorize"),
        ("oauth_scopes", ("default", "admin")),
        ("oauth_client_id_env", "SOME_OTHER_ENV"),
    ],
)
async def test_a_row_that_differs_from_the_manifest_is_never_served(
    service, notion_row, monkeypatch, field, value
):
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "public-client-id")
    service.registry.get_connector = AsyncMock(return_value=replace(notion_row, **{field: value}))
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"):
        await service._configuration("notion")


def test_client_auth_sends_the_secret_only_when_there_is_one():
    auth = oauth.ExternalConnectorCuratedOAuth._client_auth
    assert auth("id", None) == {"client_id": "id"}
    assert auth("id", "") == {"client_id": "id"}
    assert auth("id", "secret") == {"client_id": "id", "client_secret": "secret"}


@pytest.mark.asyncio
async def test_a_public_client_exchange_sends_no_secret(service, notion_row):
    attempt = dict(
        connector_id="notion",
        oauth_client_id="public-client-id",
        redirect_uri=REDIRECT,
        user_id="u1",
        attempt_id="attempt-1",
        code_verifier_ciphertext="ct",
        code_verifier_iv="iv",
    )
    service.lifecycle.claim_attempt = AsyncMock(return_value=attempt)
    service._configuration = AsyncMock(return_value=(notion_row, "public-client-id", None))
    service._post = AsyncMock(
        return_value={
            "access_token": "t",
            "token_type": "bearer",
            "expires_in": 28800,
            "refresh_token": "r",
        }
    )
    await service._exchange(state="state-attempt-1", code="code", owner="u1")
    sent = service._post.await_args.kwargs["data"]
    assert "client_secret" not in sent
    assert sent["client_id"] == "public-client-id"
    assert sent["code_verifier"] == "v"
    assert sent["grant_type"] == "authorization_code"


@pytest.mark.asyncio
async def test_a_public_client_refresh_sends_no_secret(service, notion_row):
    stale = {
        "status": "connected",
        "envelope_version": 2,
        "verified_policy_hash": None,
        "credential_expires_at": datetime.now(UTC) + timedelta(seconds=30),
        "connection_generation": 3,
        "credential_version": 2,
    }
    fresh = {**stale, "credential_expires_at": datetime.now(UTC) + timedelta(hours=1)}
    service.lifecycle.read = AsyncMock(side_effect=[stale, fresh])
    service.lifecycle.claim_refresh = AsyncMock(return_value=True)
    service.lifecycle.settle_refresh = AsyncMock(return_value=True)
    service._configuration = AsyncMock(return_value=(notion_row, "public-client-id", None))
    service.credentials.open_credential = Mock(
        side_effect=[
            {"oauthClientId": "public-client-id", "accessToken": "old", "refreshToken": "r1"},
            {"oauthClientId": "public-client-id", "accessToken": "new", "refreshToken": "r2"},
        ]
    )
    service._post = AsyncMock(
        return_value={
            "access_token": "new",
            "token_type": "bearer",
            "expires_in": 3600,
            "refresh_token": "r2",
        }
    )
    service.credentials.seal_credential = Mock(return_value={"ciphertext": "next", "iv": "iv"})

    await service.current_credential(connector_id="notion", user_id="u1")

    sent = service._post.await_args.kwargs["data"]
    assert sent == {
        "grant_type": "refresh_token",
        "refresh_token": "r1",
        "client_id": "public-client-id",
    }


@pytest.mark.asyncio
async def test_a_public_client_authorize_url_uses_pkce_and_the_default_scope(
    service, notion_row, monkeypatch
):
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "public-client-id")
    monkeypatch.setattr(oauth, "connector_feature_enabled", lambda *_: True)
    service.registry.get_connector = AsyncMock(return_value=notion_row)
    started = await service.start(connector_id="notion", user_id="u1", redirect_uri=REDIRECT)
    url = started["authorizeUrl"] if "authorizeUrl" in started else started["authorization_url"]
    assert url.startswith("https://mcp.notion.com/authorize?")
    assert "code_challenge_method=S256" in url
    assert "scope=default" in url
    assert "client_secret" not in url
    assert "client_id=public-client-id" in url
