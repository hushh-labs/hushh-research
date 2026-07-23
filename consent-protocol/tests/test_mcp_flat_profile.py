from __future__ import annotations

import json

import jsonschema
import pytest
from mcp.types import TextContent

from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from mcp_modules.agentforce_contract import (
    AGENTFORCE_PROFILE,
    agentforce_contract_errors,
    get_agentforce_contract,
    get_agentforce_tool_names,
    get_mulesoft_agentforce_handoff,
    get_salesforce_agentexchange_handoff,
)
from mcp_modules.canonical_contract import get_published_tool_names
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)
from mcp_modules.flat_contract import (
    LOCAL_INFORMATION_JSON_MAX_CHARS,
    get_flat_contract,
    get_flat_tool_names,
    validate_flat_output,
)
from mcp_modules.flat_projection import project_flat_result
from mcp_modules.tools.definitions import get_tool_definitions


def _walk_schema(schema: object):
    if isinstance(schema, dict):
        yield schema
        for value in schema.values():
            yield from _walk_schema(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from _walk_schema(value)


def test_canonical_catalog_has_five_described_shallow_tools() -> None:
    contract = get_flat_contract()
    assert tuple(tool["name"] for tool in contract["tools"]) == get_flat_tool_names()
    assert (
        tuple(
            tool.name
            for tool in get_tool_definitions(
                allowed_tool_names=set(get_flat_tool_names()), schema_profile="flat"
            )
        )
        == get_published_tool_names()
    )

    forbidden = {"$ref", "$defs", "oneOf", "anyOf", "allOf"}
    for tool in contract["tools"]:
        for schema in (tool["inputSchema"], tool["outputSchema"]):
            jsonschema.Draft202012Validator.check_schema(schema)
            assert schema["type"] == "object"
            assert schema["additionalProperties"] is False
            for node in _walk_schema(schema):
                assert not forbidden.intersection(node)
                assert not isinstance(node.get("type"), list)
                if "properties" in node:
                    assert node["type"] == "object"
                    for property_schema in node["properties"].values():
                        assert property_schema["title"].strip()
                        assert property_schema["description"].strip()
                        assert property_schema["type"] != "object"
                if node.get("type") == "array":
                    assert node["items"]["type"] != "object"
                    assert node["items"]["description"].strip()


def test_agentforce_uat_contract_is_strict_and_keeps_canonical_field_ids() -> None:
    contract = get_agentforce_contract()
    flat = get_flat_contract()

    assert contract["profile"] == AGENTFORCE_PROFILE
    assert agentforce_contract_errors(contract) == []
    assert tuple(tool["name"] for tool in contract["tools"]) == get_agentforce_tool_names()
    assert tuple(tool["name"] for tool in flat["tools"]) == get_flat_tool_names()
    assert len(contract["tools"]) == 5

    for agentforce_tool, flat_tool in zip(contract["tools"], flat["tools"], strict=True):
        assert (
            agentforce_tool["name"]
            == get_published_tool_names()[get_flat_tool_names().index(flat_tool["name"])]
        )
        assert set(agentforce_tool["inputSchema"]["properties"]) == set(
            flat_tool["inputSchema"]["properties"]
        )
        assert set(agentforce_tool["outputSchema"]["properties"]) == set(
            flat_tool["outputSchema"]["properties"]
        )
        assert agentforce_tool["title"].strip()
        assert agentforce_tool["description"].strip()
        assert agentforce_tool["annotations"]["title"] == agentforce_tool["title"]
        assert agentforce_tool["annotations"]["idempotentHint"] is True
        assert agentforce_tool["inputSchema"]["title"] == f"{agentforce_tool['title']} input"
        assert agentforce_tool["outputSchema"]["title"] == f"{agentforce_tool['title']} output"


def test_salesforce_agentexchange_handoff_preserves_the_catalog_and_boundary() -> None:
    handoff = get_salesforce_agentexchange_handoff()

    assert handoff["integrationTarget"] == "salesforce-agentexchange"
    assert handoff["selectionStatus"] == "optional-action-facade"
    assert handoff["upstream"] == {
        "transport": "streamable-http",
        "path": "/mcp/",
        "authentication": "bearer-or-oauth2-client-credentials",
        "requestTimeoutSeconds": 55.0,
    }
    assert handoff["agentforce"]["toolsOnly"] is True
    assert handoff["agentforce"]["toolAllowlist"] == list(get_agentforce_tool_names())
    assert handoff["agentforce"]["agentActionPolicy"] == {
        "catalogOnly": True,
        "directPersonalizedToolCalls": "blocked",
        "directToolCallResult": "REQUIRES_SECURE_CONSENT_FLOW",
        "agentforceActionDefault": "no-personalized-consent-actions",
        "plannerExposure": "no-personalized-hussh-tools",
        "trustedConnectorTools": [
            "search-user-scopes",
            "prepare-campaign-context",
            "request-consent",
            "check-consent-status",
            "get-encrypted-scoped-export",
        ],
        "connectorOnlyTool": "get-encrypted-scoped-export",
        "connectorOnlyReason": (
            "The encrypted export is delivered to the registered connector and "
            "must be decrypted outside the Agentforce LLM."
        ),
    }
    assert handoff["connectorRequirements"] == {
        "preserveToolNames": True,
        "preserveInputOutputSchemas": True,
        "allowResources": False,
        "allowPrompts": False,
        "expandNestedFields": False,
        "keyCustody": "per-org-connector-runtime",
        "privateKeyInAgentforceModel": False,
    }
    assert handoff["executionBoundary"] == {
        "directAgentforceExecution": "catalog-only",
        "trustedConnectorExecution": "operations-provisioned-execute-principal",
        "agentforcePersonalizedExecution": "requires-salesforce-supported-host-boundary",
        "applicationAuthentication": "oauth2-client-credentials-per-hop",
        "userAuthority": "explicit-consent-and-scoped-grant",
        "informationDelivery": "encrypted-export-after-approval",
    }


def test_mulesoft_handoff_is_the_selected_compatible_implementation_view() -> None:
    handoff = get_mulesoft_agentforce_handoff()
    assert handoff["integrationTarget"] == "mulesoft-agentforce"
    assert handoff["implementation"] == "mulesoft-secure-relay"
    assert handoff["selectionStatus"] == "selected-target-uat-gated"
    assert handoff["connectorRequirements"]["keyCustody"] == ("partner-controlled-mulesoft-runtime")
    assert handoff["executionBoundary"]["agentforceInformationSource"] == (
        "authorized-salesforce-record-or-metadata-status"
    )
    assert handoff["agentforce"]["agentActionPolicy"]["connectorOnlyTool"] == (
        "get-encrypted-scoped-export"
    )


def test_flat_projection_preserves_lifecycle_references_and_export_envelope() -> None:
    requested = project_flat_result(
        "request_consent",
        {
            "status": "pending",
            "scope": "attr.financial.portfolio.*",
            "request_ref": "req_pending",
            "expires_at": None,
            "poll_after_seconds": 5,
            "approval_timeout_at": 123,
        },
    )
    assert requested["request_ref"] == "req_pending"
    assert requested["grant_ref"] == ""
    assert validate_flat_output("request_consent", requested)

    export = project_flat_result(
        "get_encrypted_scoped_export",
        {
            "status": "success",
            "expected_scope": "attr.financial.portfolio.*",
            "granted_scope": "attr.financial.portfolio.*",
            "expires_at": 123,
            "export_revision": 2,
            "ciphertext": "ZmFrZQ==",
            "crypto": {
                "iv": "aXY=",
                "tag": "dGFn",
                "wrapped_key_bundle": {
                    "wrapped_export_key": "d3JhcHBlZA==",
                    "wrapped_key_iv": "aXY=",
                    "wrapped_key_tag": "dGFn",
                    "sender_public_key": "c2VuZGVy",
                    "connector_key_id": "partner-key-1",
                    "wrapping_alg": "X25519-AES256-GCM",
                },
                "export_envelope": {"version": 2, "export_id": "export_1"},
            },
            "information": {"must": "not pass through"},
        },
    )
    assert validate_flat_output("get_encrypted_scoped_export", export)
    assert export["delivery"] == "encrypted_inline"
    assert "information" not in export
    assert json.loads(export["export_envelope_json"]) == {"export_id": "export_1", "version": 2}

    local_export = project_flat_result(
        "get_encrypted_scoped_export",
        {
            "status": "success",
            "delivery": "decrypted_local",
            "expected_scope": "attr.financial.portfolio.*",
            "granted_scope": "attr.financial.portfolio.*",
            "expires_at": 123,
            "export_revision": 2,
            "information": {"portfolio": {"content": "x" * 30_000}},
        },
    )
    assert len(local_export["information_json"]) < LOCAL_INFORMATION_JSON_MAX_CHARS
    assert validate_flat_output("get_encrypted_scoped_export", local_export)


def test_execution_mode_is_explicit_principal_configuration() -> None:
    standard = DeveloperPrincipal(
        app_id="app_standard",
        agent_id="developer:app_standard",
        display_name="Standard",
        allowed_tool_groups=("core_consent",),
    )
    catalog_only = DeveloperPrincipal(
        app_id="app_catalog_only",
        agent_id="developer:app_catalog_only",
        display_name="Catalog only",
        allowed_tool_groups=("core_consent",),
        mcp_execution_mode="catalog_only",
    )
    assert standard.schema_profile == "standard"
    assert catalog_only.mcp_execution_mode == "catalog_only"


def test_local_developer_context_resolves_oauth_access_token(monkeypatch) -> None:
    from hushh_mcp.services.developer_oauth_service import DeveloperOAuthService
    from mcp_modules import developer_context

    principal = DeveloperPrincipal(
        app_id="app_catalog_only",
        agent_id="developer:app_catalog_only",
        display_name="Catalog only",
        allowed_tool_groups=("core_consent",),
        mcp_execution_mode="catalog_only",
    )
    monkeypatch.setenv("HUSHH_DEVELOPER_TOKEN", "hdo_at_fixture")
    monkeypatch.setattr(
        developer_context.DeveloperRegistryService,
        "authenticate_token",
        lambda _self, _token: None,
    )
    monkeypatch.setattr(
        DeveloperOAuthService,
        "authenticate_access_token",
        lambda _self, _token: principal,
    )

    assert developer_context.get_current_developer_principal() == principal


@pytest.mark.asyncio
async def test_canonical_mcp_boundary_lists_five_tools_and_mirrors_projected_json(
    monkeypatch,
) -> None:
    import mcp_server
    from mcp_modules import resources

    async def _handler(_arguments):
        payload = {
            "status": "success",
            "scopes": [{"scope": "attr.financial.portfolio.*"}],
            "next_cursor": None,
            "has_more": False,
        }
        return [TextContent(type="text", text=json.dumps(payload))], payload

    monkeypatch.setitem(mcp_server.HANDLERS, "search_user_scopes", _handler)
    tokens = set_current_developer_principal(
        DeveloperPrincipal(
            app_id="app_flat",
            agent_id="developer:app_flat",
            display_name="Flat",
            allowed_tool_groups=("core_consent",),
            schema_profile="flat",
        ),
        token="hdo_at_fixture",  # noqa: S106 - opaque test access-token fixture
    )
    try:
        tools = await mcp_server.list_tools()
        assert tuple(tool.name for tool in tools) == get_published_tool_names()
        connector_resource = json.loads(await resources.read_resource("hushh://info/connector"))
        assert connector_resource["tools"] == list(get_published_tool_names())
        content, structured = await mcp_server.call_tool(
            "search_user_scopes", {"user_identifier": "user@example.test"}
        )
    finally:
        reset_current_developer_principal(tokens)
    assert json.loads(content[0].text) == structured
    assert structured == {
        "status": "success",
        "scope_values": ["attr.financial.portfolio.*"],
        "next_cursor": "",
        "has_more": False,
    }


@pytest.mark.asyncio
async def test_catalog_only_agentforce_boundary_lists_schema_but_rejects_personalized_calls() -> (
    None
):
    import mcp_server
    from mcp_modules import resources

    tokens = set_current_developer_principal(
        DeveloperPrincipal(
            app_id="app_agentforce",
            agent_id="developer:app_agentforce",
            display_name="Agentforce UAT",
            allowed_tool_groups=("core_consent",),
            mcp_execution_mode="catalog_only",
        ),
        token="hdo_at_agentforce_fixture",  # noqa: S106 - opaque test access-token fixture
    )
    try:
        tools = await mcp_server.list_tools()
        result = await mcp_server.call_tool(
            "search-user-scopes", {"user_identifier": "user@example.test"}
        )
        resources_list = await resources.list_resources()
    finally:
        reset_current_developer_principal(tokens)

    assert tuple(tool.name for tool in tools) == get_agentforce_tool_names()
    for tool in tools:
        dumped = tool.model_dump(by_alias=True, exclude_none=True)
        assert dumped["title"]
        assert dumped["outputSchema"]
        assert all(field["title"] for field in dumped["outputSchema"]["properties"].values())
    assert result.isError is True
    assert result.structuredContent is None
    assert json.loads(result.content[0].text)["error_code"] == "REQUIRES_SECURE_CONSENT_FLOW"
    assert resources_list == []
