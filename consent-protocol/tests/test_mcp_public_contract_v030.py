from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest

from hushh_mcp.services.developer_registry_service import (
    DEFAULT_PUBLIC_TOOL_GROUPS,
    KNOWN_TOOL_GROUPS,
    TOOL_GROUP_CORE_CONSENT,
    TOOL_GROUP_TOOL_NAMES,
    DeveloperRegistryService,
    visible_tool_names_for_groups,
)
from mcp_modules import resources
from mcp_modules.config import SERVER_INFO
from mcp_modules.public_contract import get_public_contract, get_public_tool_names
from mcp_modules.tools.definitions import get_tool_definitions

EXPECTED_TOOLS = (
    "search_user_scopes",
    "prepare_campaign_context",
    "request_consent",
    "check_consent_status",
    "get_encrypted_scoped_export",
)
REMOVED_TOOLS = {
    "discover_user_domains",
    "list_scopes",
    "validate_token",
}


def test_every_public_catalog_uses_core_plus_campaign_compatibility_contract() -> None:
    assert get_public_tool_names() == EXPECTED_TOOLS
    assert tuple(tool.name for tool in get_tool_definitions()) == EXPECTED_TOOLS
    assert DEFAULT_PUBLIC_TOOL_GROUPS == (TOOL_GROUP_CORE_CONSENT,)
    assert TOOL_GROUP_TOOL_NAMES[TOOL_GROUP_CORE_CONSENT] == EXPECTED_TOOLS
    assert tuple(item["name"] for item in SERVER_INFO["tools"]) == EXPECTED_TOOLS
    assert SERVER_INFO["version"] == "0.3.0"
    assert SERVER_INFO["tools_count"] == 5

    catalog = DeveloperRegistryService().get_tool_catalog(principal=None)
    assert tuple(item["name"] for item in catalog["tools"]) == EXPECTED_TOOLS
    assert not REMOVED_TOOLS.intersection(item["name"] for item in catalog["tools"])

    repo_root = Path(__file__).resolve().parents[2]
    for public_docs_path in (
        repo_root / "packages" / "hushh-mcp" / "public-docs.json",
        repo_root / "hushh-webapp" / "lib" / "developers" / "public-docs.json",
    ):
        public_docs = json.loads(public_docs_path.read_text())
        assert tuple(public_docs["publicTools"]) == EXPECTED_TOOLS


def test_non_public_entitlement_groups_keep_definitions_and_handlers() -> None:
    import mcp_server

    for group in KNOWN_TOOL_GROUPS:
        entitled_names = visible_tool_names_for_groups([group])
        definitions = get_tool_definitions(allowed_tool_names=set(entitled_names))
        assert tuple(tool.name for tool in definitions) == entitled_names
        assert set(entitled_names).issubset(mcp_server.HANDLERS)


def test_every_tool_schema_is_strict_bounded_and_structured() -> None:
    contract = get_public_contract()
    for tool in contract["tools"]:
        jsonschema.Draft202012Validator.check_schema(tool["inputSchema"])
        jsonschema.Draft202012Validator.check_schema(tool["outputSchema"])
        assert tool["inputSchema"]["additionalProperties"] is False
        assert tool["annotations"]["idempotentHint"] is True
        assert tool["description"]

    by_name = {tool["name"]: tool for tool in contract["tools"]}
    assert by_name["get_encrypted_scoped_export"]["inputSchema"]["required"] == [
        "grant_ref",
        "expected_scope",
    ]
    assert by_name["check_consent_status"]["inputSchema"]["required"] == ["request_ref"]


def test_export_output_schema_discriminates_hosted_and_local_delivery() -> None:
    contract = get_public_contract()
    schema = next(
        tool["outputSchema"]
        for tool in contract["tools"]
        if tool["name"] == "get_encrypted_scoped_export"
    )
    base = {
        "status": "success",
        "expected_scope": "attr.financial.portfolio.*",
        "granted_scope": "attr.financial.portfolio.*",
        "expires_at": None,
        "export_revision": 1,
        "resource": None,
        "crypto": None,
        "information": {"summary": "approved"},
    }
    jsonschema.validate({**base, "delivery": "decrypted_local"}, schema)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(
            {
                **base,
                "delivery": "resource_link",
                "information": {"must": "not accompany a resource link"},
            },
            schema,
        )


@pytest.mark.asyncio
async def test_resources_advertise_core_lifecycle_and_campaign_compatibility() -> None:
    connector = json.loads(await resources.read_resource("hushh://info/connector"))
    lifecycle = json.loads(await resources.read_resource("hushh://info/consent-lifecycle"))
    assert tuple(connector["tools"]) == EXPECTED_TOOLS
    assert tuple(step["tool"] for step in lifecycle["steps"]) == (
        "search_user_scopes",
        "request_consent",
        "check_consent_status",
        "get_encrypted_scoped_export",
    )
    assert connector["compatibility_tool"] == "prepare_campaign_context"
    serialized = json.dumps({"connector": connector, "lifecycle": lifecycle})
    assert all(name not in serialized for name in REMOVED_TOOLS)


def test_partner_gateway_is_generated_from_canonical_inputs_only() -> None:
    package_root = Path(__file__).resolve().parents[2] / "packages" / "hushh-mcp"
    manifest = json.loads((package_root / "gateway" / "hushh-mcp-gateway.json").read_text())
    assert set(manifest) == {"protocolVersion", "transport", "capabilities", "tools"}
    assert manifest["protocolVersion"] == "2024-11-05"
    assert manifest["transport"]["kind"] == "streamableHttp"
    assert manifest["transport"]["path"] == "/mcp/"
    assert all(isinstance(value, bool) for value in manifest["capabilities"].values())
    assert tuple(tool["name"] for tool in manifest["tools"]) == EXPECTED_TOOLS
    assert all(set(tool) == {"name", "description", "inputSchema"} for tool in manifest["tools"])
    assert "HUSHH_DEVELOPER_TOKEN" not in json.dumps(manifest)
