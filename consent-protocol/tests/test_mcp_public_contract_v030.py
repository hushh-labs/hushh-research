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
from mcp_modules.canonical_contract import published_tool_name
from mcp_modules.config import SERVER_INFO
from mcp_modules.public_contract import get_public_contract, get_public_tool_names
from mcp_modules.tools.definitions import get_tool_definitions

EXPECTED_TOOLS = (
    "search-user-scopes",
    "prepare-campaign-context",
    "request-consent",
    "check-consent-status",
    "get-encrypted-scoped-export",
)
REMOVED_TOOLS = {
    "discover_user_domains",
    "list_scopes",
    "validate_token",
}


def _monorepo_root() -> Path | None:
    protocol_root = Path(__file__).resolve().parents[1]
    candidate = protocol_root.parent
    if (candidate / "packages" / "hushh-mcp").is_dir():
        return candidate
    return None


def test_every_public_catalog_uses_core_plus_campaign_compatibility_contract() -> None:
    assert get_public_tool_names() == EXPECTED_TOOLS
    assert tuple(tool.name for tool in get_tool_definitions()) == EXPECTED_TOOLS
    assert DEFAULT_PUBLIC_TOOL_GROUPS == (TOOL_GROUP_CORE_CONSENT,)
    assert (
        tuple(published_tool_name(name) for name in TOOL_GROUP_TOOL_NAMES[TOOL_GROUP_CORE_CONSENT])
        == EXPECTED_TOOLS
    )
    assert tuple(item["name"] for item in SERVER_INFO["tools"]) == EXPECTED_TOOLS
    assert SERVER_INFO["version"] == "0.4.0"
    assert SERVER_INFO["tools_count"] == 5

    catalog = DeveloperRegistryService().get_tool_catalog(principal=None)
    assert tuple(item["name"] for item in catalog["tools"]) == EXPECTED_TOOLS
    assert not REMOVED_TOOLS.intersection(item["name"] for item in catalog["tools"])

    monorepo_root = _monorepo_root()
    if monorepo_root is not None:
        package_public_docs = json.loads(
            (monorepo_root / "packages" / "hushh-mcp" / "public-docs.json").read_text()
        )
        web_public_docs = json.loads(
            (monorepo_root / "hushh-webapp" / "lib" / "developers" / "public-docs.json").read_text()
        )
        assert package_public_docs == web_public_docs
        assert tuple(package_public_docs["publicTools"]) == EXPECTED_TOOLS


def test_non_public_entitlement_groups_keep_definitions_and_handlers() -> None:
    import mcp_server

    for group in KNOWN_TOOL_GROUPS:
        entitled_names = visible_tool_names_for_groups([group])
        definitions = get_tool_definitions(allowed_tool_names=set(entitled_names))
        assert tuple(tool.name for tool in definitions) == tuple(
            published_tool_name(name) or name for name in entitled_names
        )
        assert set(entitled_names).issubset(mcp_server.HANDLERS)


def test_every_tool_schema_is_strict_bounded_and_structured() -> None:
    contract = get_public_contract()
    for tool in contract["tools"]:
        jsonschema.Draft202012Validator.check_schema(tool["inputSchema"])
        jsonschema.Draft202012Validator.check_schema(tool["outputSchema"])
        assert tool["inputSchema"]["additionalProperties"] is False
        assert tool["outputSchema"]["type"] == "object"
        assert tool["annotations"]["idempotentHint"] is True
        assert tool["description"]

    by_name = {tool["name"]: tool for tool in contract["tools"]}
    assert by_name["get-encrypted-scoped-export"]["inputSchema"]["required"] == [
        "grant_ref",
        "expected_scope",
    ]
    assert by_name["check-consent-status"]["inputSchema"]["required"] == ["request_ref"]


def test_export_output_schema_discriminates_hosted_and_local_delivery() -> None:
    contract = get_public_contract()
    schema = next(
        tool["outputSchema"]
        for tool in contract["tools"]
        if tool["name"] == "get-encrypted-scoped-export"
    )
    base = {
        "status": "success",
        "expected_scope": "attr.financial.portfolio.*",
        "granted_scope": "attr.financial.portfolio.*",
        "expires_at": 0,
        "export_revision": 1,
        "ciphertext": "",
        "payload_iv": "",
        "payload_tag": "",
        "wrapped_export_key": "",
        "wrapped_key_iv": "",
        "wrapped_key_tag": "",
        "sender_public_key": "",
        "connector_key_id": "",
        "wrapping_alg": "X25519-AES256-GCM",
        "export_envelope_json": "",
        "information_json": '{"summary":"approved"}',
    }
    jsonschema.validate({**base, "delivery": "decrypted_local"}, schema)

    jsonschema.validate(
        {
            **base,
            "delivery": "encrypted_inline",
            "ciphertext": "ZmFrZQ==",
            "information_json": "",
        },
        schema,
    )
    assert "oneOf" not in schema


@pytest.mark.asyncio
async def test_resources_advertise_core_lifecycle_and_campaign_compatibility() -> None:
    connector = json.loads(await resources.read_resource("hushh://info/connector"))
    lifecycle = json.loads(await resources.read_resource("hushh://info/consent-lifecycle"))
    assert tuple(connector["tools"]) == EXPECTED_TOOLS
    assert tuple(step["tool"] for step in lifecycle["steps"]) == (
        "search-user-scopes",
        "request-consent",
        "check-consent-status",
        "get-encrypted-scoped-export",
    )
    serialized = json.dumps({"connector": connector, "lifecycle": lifecycle})
    assert all(name not in serialized for name in REMOVED_TOOLS)


def test_partner_gateway_is_generated_from_canonical_inputs_only() -> None:
    monorepo_root = _monorepo_root()
    if monorepo_root is None:
        pytest.skip("npm gateway artifact is verified by monorepo package CI")
    package_root = monorepo_root / "packages" / "hushh-mcp"
    manifest = json.loads((package_root / "gateway" / "hushh-mcp-gateway.json").read_text())
    assert set(manifest) == {"protocolVersion", "transport", "capabilities", "tools"}
    assert manifest["protocolVersion"] == "2025-11-25"
    assert manifest["transport"]["kind"] == "streamableHttp"
    assert manifest["transport"]["path"] == "/mcp/"
    assert all(isinstance(value, bool) for value in manifest["capabilities"].values())
    assert tuple(tool["name"] for tool in manifest["tools"]) == EXPECTED_TOOLS
    assert all(
        set(tool) == {"name", "description", "inputSchema", "outputSchema"}
        for tool in manifest["tools"]
    )
    assert "HUSHH_DEVELOPER_TOKEN" not in json.dumps(manifest)
