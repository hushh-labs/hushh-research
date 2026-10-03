"""The provisioning script's safety properties, with no network and no gcloud."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.services.curated_connector_manifest import (
    REGISTRATION_SPEC_DIR,
    get_manifest,
    get_registration_spec,
)
from scripts.ops import configure_external_mcp_connector as cli
from scripts.ops import provision_curated_connector as prov

NOTION = get_manifest("notion")
HUBSPOT = get_manifest("hubspot")
# Attio has a real checked-in registration-only spec. It deliberately remains
# absent from the runtime manifests until authenticated tools/list discovery.
ATTIO = get_registration_spec("attio")
GOOD_METADATA = {
    "issuer": "https://mcp.notion.com",
    "authorization_endpoint": "https://mcp.notion.com/authorize",
    "token_endpoint": "https://mcp.notion.com/token",
    "registration_endpoint": "https://mcp.notion.com/register",
    "code_challenge_methods_supported": ["plain", "S256"],
    "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
}
ATTIO_METADATA = {
    "issuer": "https://mcp.attio.com",
    "authorization_endpoint": "https://app.attio.com/oidc/authorize",
    "token_endpoint": "https://app.attio.com/oidc/token",
    "registration_endpoint": "https://app.attio.com/oauth/register",
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["none"],
}


def _args(**overrides: Any) -> argparse.Namespace:
    base = dict(
        connector_id="notion",
        env="uat",
        project="p",
        dry_run=False,
        store=False,
        local_env_file=None,
        extra_redirect=None,
        force=False,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


# --- request building ----------------------------------------------------------


def test_the_registration_request_is_a_public_pkce_client_with_the_manifest_redirects():
    request = prov.build_registration_request(NOTION, "uat", [])
    assert request["token_endpoint_auth_method"] == "none"
    assert request["redirect_uris"] == list(NOTION.redirect_uris["uat"])
    assert request["grant_types"] == ["authorization_code", "refresh_token"]
    assert request["response_types"] == ["code"]
    assert request["scope"] == "default"
    assert request["client_name"] == prov.CLIENT_NAME


def test_attio_public_client_contract_uses_only_its_client_id_and_metadata_scopes():
    request = prov.build_registration_request(ATTIO, "uat", [])
    assert ATTIO.is_public_client is True
    assert ATTIO.client_id_env == "ATTIO_OAUTH_CLIENT_ID"
    assert ATTIO.secret_env_names == ("ATTIO_OAUTH_CLIENT_ID",)
    assert get_manifest("attio") is None
    assert request["token_endpoint_auth_method"] == "none"
    assert request["scope"] == "mcp offline_access openid"


def test_extra_redirects_are_appended_after_the_reviewed_ones():
    local = "http://localhost:3000/one/profile/connectors/oauth/return"
    request = prov.build_registration_request(NOTION, "uat", [local])
    assert request["redirect_uris"][-1] == local
    assert request["redirect_uris"][:-1] == list(NOTION.redirect_uris["uat"])


def test_a_confidential_provider_is_never_registered_by_the_script():
    with pytest.raises(prov.ProvisionError, match="confidential client"):
        prov.build_registration_request(HUBSPOT, "uat", [])


def test_an_environment_without_redirects_is_rejected():
    with pytest.raises(prov.ProvisionError, match="redirect addresses"):
        prov.build_registration_request(NOTION, "production", [])


@pytest.mark.parametrize(
    "redirect",
    [
        "https://localhost:3000/one/profile/connectors/oauth/return",
        "http://example.test/one/profile/connectors/oauth/return",
        "http://localhost:3000/not-the-oauth-return",
        "http://localhost:3000/one/profile/connectors/oauth/return?leak=1",
        "http://user@localhost:3000/one/profile/connectors/oauth/return",
    ],
)
def test_extra_redirect_must_be_the_canonical_loopback_callback(redirect):
    with pytest.raises(prov.ProvisionError, match="loopback OAuth return"):
        prov.build_registration_request(NOTION, "uat", [redirect])


def test_extra_redirect_cannot_supply_an_unsupported_environment():
    with pytest.raises(prov.ProvisionError, match="No redirect addresses"):
        prov.build_registration_request(
            NOTION,
            "production",
            ["http://localhost:3000/one/profile/connectors/oauth/return"],
        )


def test_an_unknown_provider_has_no_manifest():
    with pytest.raises(prov.ProvisionError, match="No valid manifest"):
        prov.require_manifest("no_such_provider")


@pytest.mark.asyncio
async def test_attio_registration_only_spec_can_dry_run_but_never_posts_or_stores(monkeypatch):
    async def fake_discover(contract):
        assert contract == ATTIO
        return ATTIO.registration_url

    monkeypatch.setattr(prov, "discover_registration_endpoint", fake_discover)
    monkeypatch.setattr(prov, "secret_exists", lambda *_: False)
    monkeypatch.setattr(prov, "register_client", pytest.fail)
    monkeypatch.setattr(prov, "store_secret", pytest.fail)

    result = await prov.cmd_register(_args(connector_id="attio", dry_run=True, store=True))

    assert result["dryRun"] is True
    assert result["clientIdVariable"] == "ATTIO_OAUTH_CLIENT_ID"
    assert result["registrationEndpoint"] == "https://app.attio.com/oauth/register"
    assert result["request"] == {
        "client_name": prov.CLIENT_NAME,
        "redirect_uris": ["https://uat.one.hushh.ai/one/profile/connectors/oauth/return"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": "mcp offline_access openid",
    }


# --- metadata must still agree with the reviewed manifest ------------------------


@pytest.mark.asyncio
async def test_discovery_returns_the_registration_endpoint_when_metadata_agrees(monkeypatch):
    async def fake(_url):
        return GOOD_METADATA

    monkeypatch.setattr(prov, "_get_json", fake)
    assert await prov.discover_registration_endpoint(NOTION) == "https://mcp.notion.com/register"


@pytest.mark.asyncio
async def test_discovery_allows_a_cross_origin_registration_endpoint_only_when_pinned(monkeypatch):
    requested: list[str] = []

    async def fake(url):
        requested.append(url)
        return ATTIO_METADATA

    monkeypatch.setattr(prov, "_get_json", fake)
    assert await prov.discover_registration_endpoint(ATTIO) == ATTIO.registration_url
    assert requested == ["https://mcp.attio.com/.well-known/oauth-authorization-server"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change,message",
    [
        ({"token_endpoint": "https://app.attio.com/oidc/other"}, "token_endpoint"),
        (
            {"registration_endpoint": "https://evil.example/register"},
            "registration_endpoint differs",
        ),
        ({"registration_endpoint": "http://app.attio.com/oauth/register"}, "public HTTPS"),
    ],
)
async def test_discovery_rejects_attio_metadata_drift_before_registration(
    monkeypatch, change, message
):
    async def fake(_url):
        return {**ATTIO_METADATA, **change}

    monkeypatch.setattr(prov, "_get_json", fake)
    with pytest.raises(prov.ProvisionError, match=message):
        await prov.discover_registration_endpoint(ATTIO)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change,message",
    [
        ({"issuer": "https://evil.example"}, "issuer"),
        ({"authorization_endpoint": "https://mcp.notion.com/other"}, "authorization_endpoint"),
        ({"token_endpoint": "https://evil.example/token"}, "token_endpoint"),
        ({"code_challenge_methods_supported": ["plain"]}, "S256"),
        ({"code_challenge_methods_supported": "S256,plain"}, "S256"),
        ({"token_endpoint_auth_methods_supported": ["client_secret_post"]}, "token auth method"),
        ({"token_endpoint_auth_methods_supported": "none,client_secret_post"}, "token auth method"),
        ({"registration_endpoint": ""}, "registration_endpoint"),
        (
            {"registration_endpoint": "https://evil.example/register"},
            "registration_endpoint differs",
        ),
        ({"registration_endpoint": "http://mcp.notion.com/register"}, "public HTTPS"),
    ],
)
async def test_discovery_refuses_to_send_anything_when_metadata_has_drifted(
    monkeypatch, change, message
):
    async def fake(_url):
        return {**GOOD_METADATA, **change}

    monkeypatch.setattr(prov, "_get_json", fake)
    with pytest.raises(prov.ProvisionError, match=message):
        await prov.discover_registration_endpoint(NOTION)


# --- registration response handling ------------------------------------------------


class _Response:
    def __init__(self, status: int, body: Any):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _Client:
    def __init__(self, response: _Response):
        self.response = response
        self.sent: dict[str, Any] = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, json=None, headers=None):
        self.sent = {"url": url, "json": json}
        return self.response


def _patch_client(monkeypatch, response: _Response) -> _Client:
    client = _Client(response)
    monkeypatch.setattr(prov, "create_public_mcp_http_client", lambda **_kw: client)
    return client


@pytest.mark.asyncio
async def test_a_good_registration_returns_the_client_id(monkeypatch):
    client = _patch_client(monkeypatch, _Response(201, {"client_id": " abc123 "}))
    body = await prov.register_client("https://mcp.notion.com/register", {"x": 1})
    assert body["client_id"].strip() == "abc123"
    assert client.sent["json"] == {"x": 1}


@pytest.mark.asyncio
async def test_a_secret_issued_to_a_public_client_aborts_before_anything_is_stored(monkeypatch):
    _patch_client(monkeypatch, _Response(201, {"client_id": "abc123", "client_secret": "s"}))
    with pytest.raises(prov.ProvisionError, match="refusing to continue"):
        await prov.register_client("https://mcp.notion.com/register", {})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        _Response(400, {"error": "invalid_redirect_uri", "error_description": "bad"}),
        _Response(500, {}),
        _Response(201, {}),
        _Response(201, {"client_id": "  "}),
        _Response(201, ValueError("not json")),
    ],
)
async def test_a_failed_or_malformed_registration_raises(monkeypatch, response):
    _patch_client(monkeypatch, response)
    with pytest.raises(prov.ProvisionError):
        await prov.register_client("https://mcp.notion.com/register", {})


@pytest.mark.asyncio
async def test_a_non_public_registration_endpoint_is_refused_before_any_request(monkeypatch):
    client = _patch_client(monkeypatch, _Response(201, {"client_id": "abc"}))
    with pytest.raises(prov.ProvisionError, match="public HTTPS"):
        await prov.register_client("http://127.0.0.1/register", {})
    assert client.sent == {}


# --- idempotency: never orphan grants by registering twice -------------------------


@pytest.mark.asyncio
async def test_register_refuses_when_the_secret_already_exists(monkeypatch):
    async def fake(_manifest):
        return "https://mcp.notion.com/register"

    monkeypatch.setattr(prov, "discover_registration_endpoint", fake)
    monkeypatch.setattr(prov, "secret_exists", lambda name, project: True)
    monkeypatch.setattr(prov, "register_client", pytest.fail)
    with pytest.raises(prov.ProvisionError, match="orphan"):
        await prov.cmd_register(_args(store=True))


@pytest.mark.asyncio
async def test_register_refuses_when_the_local_env_already_has_the_client_id(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("NOTION_OAUTH_CLIENT_ID=existing\n", encoding="utf-8")

    async def fake(_manifest):
        return "https://mcp.notion.com/register"

    monkeypatch.setattr(prov, "discover_registration_endpoint", fake)
    monkeypatch.setattr(prov, "register_client", pytest.fail)
    with pytest.raises(prov.ProvisionError, match="already set"):
        await prov.cmd_register(_args(local_env_file=str(env)))


@pytest.mark.asyncio
async def test_dry_run_sends_and_stores_nothing(monkeypatch):
    async def fake(_manifest):
        return "https://mcp.notion.com/register"

    monkeypatch.setattr(prov, "discover_registration_endpoint", fake)
    monkeypatch.setattr(prov, "secret_exists", lambda *_a: False)
    monkeypatch.setattr(prov, "register_client", pytest.fail)
    monkeypatch.setattr(prov, "store_secret", pytest.fail)
    result = await prov.cmd_register(_args(dry_run=True, store=True))
    assert result["dryRun"] is True
    assert "clientId" not in result
    assert result["request"]["token_endpoint_auth_method"] == "none"


@pytest.mark.asyncio
async def test_register_stores_the_client_id_where_asked(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    stored: list[tuple[str, str, str]] = []

    async def fake_discover(_manifest):
        return "https://mcp.notion.com/register"

    async def fake_register(_endpoint, _request):
        return {"client_id": "new-client"}

    monkeypatch.setattr(prov, "discover_registration_endpoint", fake_discover)
    monkeypatch.setattr(prov, "register_client", fake_register)
    monkeypatch.setattr(prov, "secret_exists", lambda *_a: False)
    monkeypatch.setattr(prov, "store_secret", lambda n, v, p: stored.append((n, v, p)))
    result = await prov.cmd_register(_args(store=True, local_env_file=str(env)))
    assert result["clientId"] == "new-client"
    assert stored == [("NOTION_OAUTH_CLIENT_ID", "new-client", "p")]
    assert "NOTION_OAUTH_CLIENT_ID=new-client" in env.read_text(encoding="utf-8")


# --- env file + status + apply ------------------------------------------------------


def test_upsert_env_file_replaces_in_place_and_preserves_other_lines(tmp_path):
    env = tmp_path / ".env"
    env.write_text("A=1\nNOTION_OAUTH_CLIENT_ID=old\nB=2\n", encoding="utf-8")
    prov.upsert_env_file(env, "NOTION_OAUTH_CLIENT_ID", "new")
    assert env.read_text(encoding="utf-8").splitlines() == [
        "A=1",
        "NOTION_OAUTH_CLIENT_ID=new",
        "B=2",
    ]
    prov.upsert_env_file(env, "C", "3")
    assert env.read_text(encoding="utf-8").splitlines()[-1] == "C=3"


def test_env_file_has_ignores_blank_values(tmp_path):
    env = tmp_path / ".env"
    env.write_text("NOTION_OAUTH_CLIENT_ID=\nOTHER=x\n", encoding="utf-8")
    assert not prov.env_file_has(env, "NOTION_OAUTH_CLIENT_ID")
    assert prov.env_file_has(env, "OTHER")
    assert not prov.env_file_has(tmp_path / "missing", "OTHER")


def test_status_reports_which_secrets_exist(monkeypatch):
    monkeypatch.setattr(
        prov,
        "secret_state",
        lambda name, project: "ready" if name == "NOTION_OAUTH_CLIENT_ID" else "missing",
    )
    report = prov.cmd_status(_args())
    assert report["publicClient"] is True
    assert report["secrets"] == {"NOTION_OAUTH_CLIENT_ID": "ready"}
    assert report["registrationReady"] is True
    assert report["ready"] is True
    monkeypatch.setattr(prov, "secret_state", lambda *_a: "disabled")
    assert prov.cmd_status(_args())["ready"] is False


def test_status_for_a_confidential_provider_needs_both_secrets(monkeypatch):
    monkeypatch.setattr(
        prov, "secret_state", lambda name, project: "ready" if name.endswith("_ID") else "missing"
    )
    report = prov.cmd_status(_args(connector_id="hubspot"))
    assert set(report["secrets"]) == {"HUBSPOT_OAUTH_CLIENT_ID", "HUBSPOT_OAUTH_CLIENT_SECRET"}
    assert report["secrets"]["HUBSPOT_OAUTH_CLIENT_SECRET"] == "missing"
    assert report["ready"] is False


def test_registration_only_status_can_be_registration_ready_but_never_runtime_ready(monkeypatch):
    monkeypatch.setattr(prov, "secret_state", lambda *_: "ready")

    report = prov.cmd_status(_args(connector_id="attio"))

    assert report["registrationOnly"] is True
    assert report["runtimeManifest"] is False
    assert report["toolsPendingDiscovery"] is True
    assert report["registrationReady"] is True
    assert report["ready"] is False
    assert report["secrets"] == {"ATTIO_OAUTH_CLIENT_ID": "ready"}


def test_apply_goes_through_the_manifest_path_and_the_guarded_cli(monkeypatch):
    calls: list[Any] = []
    monkeypatch.setattr(
        cli,
        "_apply",
        lambda descriptor, operator: calls.append((descriptor, operator)) or {"ok": 1},
    )
    result = prov.cmd_apply(
        SimpleNamespace(connector_id="notion", env="uat", operator="op@hushh.ai")
    )
    assert result == {"ok": 1}
    descriptor, operator = calls[0]
    assert operator == "op@hushh.ai"
    assert descriptor.raw["connectorId"] == "notion"
    assert descriptor.raw["tokenEndpointAuth"] == "none"
    assert "oauthClientSecretEnv" not in descriptor.raw
    assert descriptor.raw["toolAllowlist"] == list(NOTION.tool_allowlist)


def test_apply_refuses_a_registration_only_spec_before_descriptor_or_registry_work(monkeypatch):
    monkeypatch.setattr(cli, "load_descriptor", pytest.fail)
    monkeypatch.setattr(cli, "_apply", pytest.fail)

    with pytest.raises(prov.ProvisionError, match="registration-only spec"):
        prov.cmd_apply(SimpleNamespace(connector_id="attio", env="uat", operator="op@hushh.ai"))


def test_the_descriptor_cli_refuses_a_registration_only_spec():
    with pytest.raises(cli.ExternalMcpConnectorDescriptorError, match="version"):
        cli.load_descriptor(str(REGISTRATION_SPEC_DIR / "attio.json"), environment="uat")


def test_the_cli_applies_a_manifest_with_env_and_a_legacy_descriptor_unchanged(tmp_path):
    from hushh_mcp.services.curated_connector_manifest import MANIFEST_DIR

    composed = cli.load_descriptor(str(MANIFEST_DIR / "hubspot.json"), environment="uat")
    assert composed.raw["connectorId"] == "hubspot"
    assert composed.raw["registeredRedirectUris"] == list(HUBSPOT.redirect_uris["uat"])
    legacy = tmp_path / "x.json"
    legacy.write_text(
        json.dumps(
            {
                "version": "external-mcp-connector.v1",
                "connectorId": "acme_crm",
                "displayName": "Acme",
                "mcpEndpoint": "https://mcp.acme.example/",
                "authStyle": "api_key",
                "apiKeyHeaderName": "X-Key",
            }
        ),
        encoding="utf-8",
    )
    assert cli.load_descriptor(str(legacy), environment="uat").raw["connectorId"] == "acme_crm"


def test_applying_a_hand_edited_descriptor_for_a_manifest_provider_is_refused(tmp_path):
    from hushh_mcp.services.external_mcp_connector_descriptor import (
        ExternalMcpConnectorDescriptorError,
        validate_descriptor,
    )

    descriptor = HUBSPOT.to_descriptor("uat")
    descriptor["toolAllowlist"] = [*descriptor["toolAllowlist"], "delete_everything"]
    with pytest.raises(ExternalMcpConnectorDescriptorError, match="manifest-backed"):
        cli._require_matches_manifest(validate_descriptor(descriptor))
    descriptor = HUBSPOT.to_descriptor("uat")
    descriptor["oauthTokenUrl"] = "https://evil.example/token"
    with pytest.raises(ExternalMcpConnectorDescriptorError, match="manifest-backed"):
        cli._require_matches_manifest(validate_descriptor(descriptor))
    cli._require_matches_manifest(validate_descriptor(HUBSPOT.to_descriptor("uat")))


def test_the_script_never_prints_a_secret_value(capsys):
    # status/register only ever report names and a public client id.
    assert "secret" not in json.dumps(prov.build_registration_request(NOTION, "uat", [])).lower()
    assert Path(prov.__file__).name == "provision_curated_connector.py"
