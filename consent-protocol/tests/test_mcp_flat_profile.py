from __future__ import annotations

import json

import jsonschema
import pytest
from mcp.types import TextContent

from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)
from mcp_modules.flat_contract import get_flat_contract, get_flat_tool_names, validate_flat_output
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


def test_flat_profile_has_only_four_described_shallow_tools() -> None:
    contract = get_flat_contract()
    assert tuple(tool["name"] for tool in contract["tools"]) == get_flat_tool_names()
    assert (
        tuple(
            tool.name
            for tool in get_tool_definitions(
                allowed_tool_names=set(get_flat_tool_names()), schema_profile="flat"
            )
        )
        == get_flat_tool_names()
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
                        assert property_schema["description"].strip()
                        assert property_schema["type"] != "object"
                if node.get("type") == "array":
                    assert node["items"]["type"] != "object"
                    assert node["items"]["description"].strip()


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


def test_schema_profile_is_explicit_principal_configuration() -> None:
    standard = DeveloperPrincipal(
        app_id="app_standard",
        agent_id="developer:app_standard",
        display_name="Standard",
        allowed_tool_groups=("core_consent",),
    )
    flat = DeveloperPrincipal(
        app_id="app_flat",
        agent_id="developer:app_flat",
        display_name="Flat",
        allowed_tool_groups=("core_consent",),
        schema_profile="flat",
    )
    assert standard.schema_profile == "standard"
    assert flat.schema_profile == "flat"


@pytest.mark.asyncio
async def test_flat_mcp_boundary_lists_four_tools_and_mirrors_projected_json(monkeypatch) -> None:
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
        assert tuple(tool.name for tool in tools) == get_flat_tool_names()
        connector_resource = json.loads(await resources.read_resource("hushh://info/connector"))
        assert connector_resource["tools"] == list(get_flat_tool_names())
        assert "compatibility_tool" not in connector_resource
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
