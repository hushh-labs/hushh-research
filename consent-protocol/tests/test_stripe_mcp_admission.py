"""Official One Stripe boundary: synthetic ports, never real OAuth/account proof."""

from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata

from api.routes import external_connectors as routes
from hushh_mcp.one_adk.governed_mcp_toolset import _GovernedMcpTool
from hushh_mcp.one_adk.mcp_oauth_storage import (
    ConnectOnlyMcpOAuthProvider,
    EphemeralMcpOAuthStorage,
    McpOAuthConnectError,
)
from hushh_mcp.one_adk.pod_custody_mcp import CustodyMcpTokens
from hushh_mcp.services.curated_connector_manifest import (
    REGISTRATION_SPEC_DIR,
    CuratedConnectorManifestError,
    get_manifest,
    get_registration_spec,
    parse_registration_spec,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.mcp_oauth_metadata import authorization_server_metadata_url
from hushh_mcp.services.stripe_mcp_policy import STRIPE_MCP_ENDPOINT, STRIPE_OAUTH_ISSUER
from scripts.ops import provision_curated_connector as provision
from tests.test_external_connector_oauth_routes import route_client as route_client
from tests.test_governed_mcp_toolset import _owner_context, _policy_toolset, _tool
from tests.test_governed_mcp_toolset import native_ok as native_ok
from tests.test_pod_custody_mcp import agent as agent

RESOURCE_URL = f"{STRIPE_MCP_ENDPOINT}/.well-known/oauth-protected-resource"
ISSUER_URL = authorization_server_metadata_url(STRIPE_OAUTH_ISSUER)
RESOURCE = {"resource": STRIPE_MCP_ENDPOINT, "authorization_servers": [STRIPE_OAUTH_ISSUER]}
METADATA = {
    "issuer": STRIPE_OAUTH_ISSUER,
    "authorization_endpoint": f"{STRIPE_OAUTH_ISSUER}/oauth2/authorize",
    "token_endpoint": f"{STRIPE_OAUTH_ISSUER}/oauth2/token",
    "registration_endpoint": f"{STRIPE_OAUTH_ISSUER}/oauth2/register",
    "response_types_supported": ["code"],
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["none"],
}


def _stripe_toolset(tools, *, endpoint=STRIPE_MCP_ENDPOINT, kind="oauth", headers=None):
    toolset, approve, session = _policy_toolset("credentialed", tools, headers=headers)
    previous = toolset.resolve_connection.return_value
    toolset.binding = replace(previous.binding, endpoint=endpoint)
    toolset.resolve_connection.return_value = replace(
        previous,
        binding=toolset.binding,
        authentication_kind=kind,
    )
    return toolset, approve, session


def test_explicit_verification_requires_owner_current_configuration_and_bounded_private_body(
    route_client, monkeypatch
):
    from api.middleware import require_vault_owner_token

    client, app, _ = route_client
    connector_id = "custom_" + "a" * 32
    path = f"/api/connectors/{connector_id}/mcp/verify"
    handler = AsyncMock(
        return_value={"connectorId": connector_id, "stripeReadiness": {"accountVerified": False}}
    )
    monkeypatch.setattr(routes.mcp_review_service, "verify_account", handler)
    assert client.post(path, json={}).status_code == 401
    handler.assert_not_awaited()
    owner = {"user_id": "synthetic-owner", "token": "synthetic-owner-token"}
    app.dependency_overrides[require_vault_owner_token] = lambda: owner
    assert client.post(path, json={}).status_code == 400
    assert client.post(path, content=b"x" * 64001).status_code == 413
    handler.assert_not_awaited()
    configuration = {
        "version": 1,
        "connectorId": connector_id,
        "revision": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "displayName": "Stripe",
        "endpoint": "https://mcp.stripe.com",
        "enabled": True,
        "authentication": {
            "kind": "oauth",
            "accessToken": "synthetic-oauth-token",
            "expiresAt": 4070908800,
        },
    }
    response = client.post(path, json={"connectorConfiguration": configuration})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert handler.await_args.kwargs["token"] is owner
    assert handler.await_args.kwargs["configuration"]["revision"] == configuration["revision"]
    assert "synthetic-oauth-token" not in response.text


@pytest.mark.parametrize(
    "endpoint",
    [
        STRIPE_MCP_ENDPOINT,
        STRIPE_MCP_ENDPOINT + "/mcp/?alias=private",
        "https://mcp.stripe.com./mcp",
        "https://mcp\u3002stripe.com/mcp",
        "https://mcp.stripe\uff0ecom/mcp",
        "https://mcp.stripe.com\uff61/mcp",
    ],
)
async def test_official_endpoint_publishes_only_reviewed_documentation_and_no_account_proof(
    native_ok, endpoint
):
    tools = [
        _tool(name, SimpleNamespace(readOnlyHint=True))
        for name in (
            "search_stripe_documentation",
            "stripe_api_search",
            "stripe_api_details",
            "stripe_api_write",
            "stripe_api_read",
            "get_stripe_account_info",
            "get_balance_summary",
        )
    ] + [_tool("stripe_implementation_planner", SimpleNamespace(readOnlyHint=True))]
    toolset, approval, session = _stripe_toolset(tools, endpoint=endpoint)
    try:
        admitted = await toolset.get_tools(_owner_context())
        assert {tool.descriptor["name"] for tool in admitted} == {
            "search_stripe_documentation",
            "stripe_api_search",
            "stripe_api_details",
        }
        result = await admitted[0].run_async(args={}, tool_context=_owner_context())
        assert result["status"] == "ok" and result["stripeReadiness"] == {
            "toolingConnected": True,
            "accountVerified": False,
            "environmentVerified": False,
            "accountToolsAvailable": False,
            "capability": "documentation_only",
            "nextStep": "authenticated_account_contract_required",
            "managementPath": "/one/profile/connectors",
            "verificationState": "unverified",
            "reasonCode": None,
            "verifiedAt": None,
            "configurationRevision": None,
            "catalogFingerprint": None,
        }
        assert "Bearer" not in repr(result)
        session.list_tools.assert_awaited()
        approval.assert_not_awaited()
        native_ok.assert_awaited_once()
    finally:
        await toolset.close()


@pytest.mark.parametrize("name", ["stripe_api_write", "get_balance_summary", "stripe_api_read"])
async def test_raw_stripe_tools_cannot_bypass_catalog_or_human_review(native_ok, name):
    toolset, approval, session = _stripe_toolset([])
    toolset.get_tools = AsyncMock(side_effect=AssertionError("catalog access after denial"))
    descriptor = {
        "name": name,
        "inputSchema": {"type": "object"},
        "annotations": {"readOnlyHint": True},
    }
    tool = _GovernedMcpTool(toolset=toolset, descriptor=descriptor, revision="test", epoch=0)
    try:
        result = await tool.run_async(args={}, tool_context=_owner_context())
        assert result["error"] == "MCP_STRIPE_READ_ONLY"
        assert result["stripeReadiness"]["accountToolsAvailable"] is False
        toolset.get_tools.assert_not_awaited()
        session.list_tools.assert_not_awaited()
        approval.assert_not_awaited()
        native_ok.assert_not_awaited()
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    "kind,headers",
    [
        ("none", {}),
        ("api_key", {"Authorization": "Bearer synthetic"}),
        ("oauth", {"Authorization": "Bearer sk_test_synthetic"}),
        ("oauth", {"Authorization": "Bearer  sk_test_synthetic"}),
        ("oauth", {"Authorization": "Bearer rk_test_synthetic"}),
        ("oauth", {"Authorization": "Bearer synthetic", "Stripe-Account": "acct_synthetic"}),
    ],
)
async def test_stripe_key_or_connect_impersonation_is_denied_before_discovery(kind, headers):
    toolset, approval, session = _stripe_toolset([], kind=kind, headers=headers)
    try:
        with pytest.raises(ExternalMcpError) as error:
            await toolset.get_tools(_owner_context())
        assert error.value.code == "MCP_STRIPE_OAUTH_REQUIRED"
        session.list_tools.assert_not_awaited()
        approval.assert_not_awaited()
    finally:
        await toolset.close()


@pytest.mark.parametrize(
    "hints", [None, {"readOnlyHint": False}, {"readOnlyHint": True, "destructiveHint": True}]
)
async def test_a_documentation_name_never_overrides_actual_write_annotations(hints):
    toolset, _, _ = _stripe_toolset(
        [_tool("stripe_api_details", SimpleNamespace(**hints) if hints else None)]
    )
    try:
        assert await toolset.get_tools(_owner_context()) == []
    finally:
        await toolset.close()


@pytest.mark.parametrize("changed", [None, "issuer", "token_endpoint", "resource", "source"])
def test_owner_oauth_accepts_only_reviewed_stripe_metadata_sources_and_endpoints(changed):
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    provider = ConnectOnlyMcpOAuthProvider(
        STRIPE_MCP_ENDPOINT,
        OAuthClientMetadata(
            redirect_uris=["https://app.example/return"],
            token_endpoint_auth_method="none",  # noqa: S106 -- public-client method
        ),
        storage,
    )  # noqa: S106 -- public-client method
    resource, metadata = dict(RESOURCE), dict(METADATA)
    if changed == "resource":
        resource["authorization_servers"] = ["https://wrong.example"]
    if changed in {"issuer", "token_endpoint"}:
        metadata[changed] = "https://wrong.example"
    source = "https://wrong.example/metadata" if changed == "source" else ISSUER_URL

    def admit(url, payload):
        request = httpx.Request("GET", url)
        provider._admit_metadata_response(
            request, httpx.Response(200, json=payload, request=request)
        )

    try:
        if changed:
            with pytest.raises(McpOAuthConnectError):
                admit(RESOURCE_URL, resource)
                admit(source, metadata)
            assert getattr(provider, "_admitted_metadata", None) is None
        else:
            admit(RESOURCE_URL, resource)
            admit(source, metadata)
            assert provider._admitted_endpoints["token_endpoint"] == METADATA["token_endpoint"]
        assert storage._tokens == "" and storage._client == ""
    finally:
        provider.close()


@pytest.mark.parametrize(
    "state", ["reviewed", "missing", "invalid", "duplicate_forms", "changed_endpoint"]
)
def test_stripe_oauth_promotion_preserves_pins_and_rejects_invalid_contracts(
    tmp_path, monkeypatch, state
):
    from hushh_mcp.services import curated_connector_manifest as manifests
    from hushh_mcp.services.stripe_mcp_oauth import require_stripe_metadata

    raw = json.loads((REGISTRATION_SPEC_DIR / "stripe.json").read_text())
    runtime, registrations = tmp_path / "runtime", tmp_path / "registrations"
    runtime.mkdir()
    registrations.mkdir()
    if state == "duplicate_forms":
        (registrations / "stripe.json").write_text(json.dumps(raw))
    raw["version"] = "curated-connector.v1"
    raw["tools"] = {"allowlist": ["search_stripe_documentation"], "freeRead": []}
    if state == "invalid":
        raw["version"] = "invalid"
    if state == "changed_endpoint":
        raw["oauth"]["tokenUrl"] = "https://wrong.example/token"
    if state != "missing":
        (runtime / "stripe.json").write_text(json.dumps(raw))
    monkeypatch.setattr(manifests, "MANIFEST_DIR", runtime)
    monkeypatch.setattr(manifests, "REGISTRATION_SPEC_DIR", registrations)
    manifests.clear_manifest_cache()
    manifests.clear_registration_spec_cache()
    try:
        if state == "reviewed":
            assert manifests.get_registration_spec("stripe") is None
            require_stripe_metadata(STRIPE_MCP_ENDPOINT, ISSUER_URL, METADATA)
        else:
            with pytest.raises(ValueError):
                require_stripe_metadata(STRIPE_MCP_ENDPOINT, ISSUER_URL, METADATA)
    finally:
        manifests.clear_manifest_cache()
        manifests.clear_registration_spec_cache()


@pytest.mark.parametrize(
    "issuer,method,secret",
    [
        (STRIPE_OAUTH_ISSUER, "none", None),
        ("https://wrong.example", "none", None),
        (STRIPE_OAUTH_ISSUER, "client_secret_post", "synthetic-client-secret"),
    ],
)
async def test_registered_owner_stripe_client_is_public_and_issuer_bound(issuer, method, secret):
    storage = EphemeralMcpOAuthStorage(is_current=lambda: True)
    provider = ConnectOnlyMcpOAuthProvider(
        STRIPE_MCP_ENDPOINT,
        OAuthClientMetadata(redirect_uris=["https://app.example/return"]),
        storage,
    )
    client = OAuthClientInformationFull(
        client_id="synthetic-client",
        client_secret=secret,
        redirect_uris=["https://app.example/return"],
        token_endpoint_auth_method=method,
    )
    try:
        if issuer != STRIPE_OAUTH_ISSUER or secret:
            with pytest.raises(McpOAuthConnectError):
                await provider.use_registered_client(client, issuer=issuer)
            assert storage._client == ""
        else:
            await provider.use_registered_client(client, issuer=issuer)
            assert provider._registered_issuer == STRIPE_OAUTH_ISSUER
    finally:
        provider.close()


async def test_registration_only_stripe_discovery_pins_path_issuer_without_runtime_enablement(
    monkeypatch,
):
    contract = get_registration_spec("stripe")
    assert (
        contract is not None
        and contract.is_public_client
        and contract.secret_env_names == ("STRIPE_OAUTH_CLIENT_ID",)
    )
    assert get_manifest("stripe") is None
    get_json = AsyncMock(side_effect=[RESOURCE, METADATA])
    monkeypatch.setattr(provision, "_get_json", get_json)
    assert (
        await provision.discover_registration_endpoint(contract)
        == METADATA["registration_endpoint"]
    )
    assert [call.args[0] for call in get_json.await_args_list] == [RESOURCE_URL, ISSUER_URL]
    assert provision.build_registration_request(contract, "uat", [])["redirect_uris"] == list(
        contract.redirect_uris["uat"]
    )
    raw = json.loads((REGISTRATION_SPEC_DIR / "stripe.json").read_text())
    raw["connectorId"] = "other"
    raw["oauth"]["clientIdEnv"] = "OTHER_OAUTH_CLIENT_ID"
    with pytest.raises(CuratedConnectorManifestError, match="issuer"):
        parse_registration_spec(raw)


@pytest.mark.parametrize("changed", [False, True])
async def test_pod_refresh_uses_path_issuer_metadata_and_rejects_stripe_token_drift(changed):
    metadata = dict(METADATA)
    if changed:
        metadata["token_endpoint"] = STRIPE_OAUTH_ISSUER + "/other-token"
    get = AsyncMock(return_value=(200, metadata))
    minter = CustodyMcpTokens(get=get)
    if changed:
        with pytest.raises(ValueError):
            await minter._token_endpoint(STRIPE_OAUTH_ISSUER)
    else:
        assert await minter._token_endpoint(STRIPE_OAUTH_ISSUER) == METADATA["token_endpoint"]
    get.assert_awaited_once_with(ISSUER_URL)


@pytest.mark.parametrize(
    "issuer,secret", [("https://wrong.example", None), (STRIPE_OAUTH_ISSUER, "synthetic-secret")]
)
async def test_pod_stripe_refresh_never_sends_owner_credentials_to_unreviewed_issuer(
    agent, monkeypatch, issuer, secret
):
    from hushh_mcp.services import pod_connector_credentials as store

    held = store.active_connector_credential("mcp_crm")
    held = replace(
        held,
        mcp={
            "endpoint": STRIPE_MCP_ENDPOINT + "/mcp",
            "issuer": issuer,
            "clientId": "synthetic-client",
            "clientSecret": secret,
        },
    )
    monkeypatch.setattr(store, "active_connector_credential", lambda _: held)
    get, post = AsyncMock(), AsyncMock()
    assert await CustodyMcpTokens(get=get, post=post).token(held) is None
    get.assert_not_awaited()
    post.assert_not_awaited()


def test_catalog_readiness_separates_tooling_from_actual_stripe_account_and_mode_proof():
    summary = routes._catalog_summary(
        get_registration_spec("stripe"), catalog_state="discovery_pending"
    )
    assert not routes._is_dead_catalog_card(summary)
    assert summary.curatedOAuth is False and summary.available is False
    assert summary.stripeReadiness["accountVerified"] is False
    assert summary.stripeReadiness["environmentVerified"] is False
    other = summary.model_copy(update={"connectorId": "pendingco", "stripeReadiness": None})
    assert routes._is_dead_catalog_card(other), (
        "unrelated pending cards retain their existing behavior"
    )
