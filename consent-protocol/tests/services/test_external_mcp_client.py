"""Structured MCP results take precedence; search metadata stays bounded."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.external_mcp_client import (
    ExternalMcpError,
    _list_session_tools,
    _normalize_and_cap,
    validate_tool_schema,
)
from hushh_mcp.services.google_drive_mcp_service import _search_metadata


def catalog_page(names, cursor=None):
    return SimpleNamespace(
        tools=[SimpleNamespace(name=name, inputSchema={"type": "object"}) for name in names],
        nextCursor=cursor,
    )


@pytest.mark.parametrize(
    "schema",
    [
        {},
        {"type": "array"},
        {"type": "object", "required": "not-an-array"},
        {"type": "object", "$ref": "https://private.invalid/schema"},
        {"type": "object", "$defs": {"nested": {"$id": "https://private.invalid"}}},
        {"type": "object", "$schema": "https://unknown.invalid/schema"},
    ],
)
async def test_invalid_schema_rejects_entire_catalog(schema):
    page = catalog_page(["valid", "invalid"])
    page.tools[1].inputSchema = schema
    with pytest.raises(ExternalMcpError) as error:
        await _list_session_tools(SimpleNamespace(list_tools=AsyncMock(return_value=page)))
    assert error.value.code == "MCP_SCHEMA_INVALID"


def test_local_schema_constraints_are_preserved():
    schema = {
        "type": "object",
        "$defs": {"label": {"type": "string", "minLength": 1}},
        "properties": {"label": {"$ref": "#/$defs/label"}},
        "required": ["label"],
        "additionalProperties": False,
    }
    assert validate_tool_schema(schema) == schema


def test_literal_reference_properties_are_information_not_schema_directives():
    schema = {
        "type": "object",
        "properties": {"$id": {"type": "string"}},
        "const": {"$ref": "https://example.invalid/literal", "$id": "literal"},
    }
    assert validate_tool_schema(schema) == schema


def test_deep_schema_fails_with_sanitized_limit():
    schema = {"type": "object"}
    for _ in range(40):
        schema = {"type": "object", "properties": {"child": schema}}
    with pytest.raises(ExternalMcpError) as error:
        validate_tool_schema(schema)
    assert error.value.code == "MCP_SCHEMA_LIMIT"


@pytest.mark.asyncio
async def test_catalog_reads_all_pages_in_stable_order():
    session = SimpleNamespace(
        list_tools=AsyncMock(side_effect=[catalog_page(["z"], "next"), catalog_page(["a"])])
    )
    assert [tool["name"] for tool in await _list_session_tools(session)] == ["a", "z"]
    assert session.list_tools.await_args_list[0].kwargs == {}
    assert session.list_tools.await_args_list[1].kwargs == {"cursor": "next"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "pages",
    [
        [catalog_page(["a"], "next"), catalog_page(["a"])],
        [catalog_page(["a"], "next"), catalog_page(["b"], "next")],
        [catalog_page(["a"], "")],
    ],
)
async def test_ambiguous_or_cyclic_catalog_fails_without_partial_success(pages):
    with pytest.raises(ExternalMcpError) as error:
        await _list_session_tools(SimpleNamespace(list_tools=AsyncMock(side_effect=pages)))
    assert error.value.code == "MCP_CATALOG_INVALID"


@pytest.mark.asyncio
async def test_oversized_catalog_fails_explicitly(monkeypatch):
    monkeypatch.setattr("hushh_mcp.services.external_mcp_client._MAX_CATALOG_TOOLS", 1)
    with pytest.raises(ExternalMcpError) as error:
        await _list_session_tools(
            SimpleNamespace(list_tools=AsyncMock(return_value=catalog_page(["a", "b"])))
        )
    assert error.value.code == "MCP_CATALOG_LIMIT"


def test_structured_search_drops_large_irrelevant_fields_before_cap():
    result = SimpleNamespace(
        isError=False,
        structuredContent={
            "files": [
                {
                    "id": "file-1",
                    "title": "Recording",
                    "mimeType": "video/mp4",
                    "description": "x" * 40_000,
                    "viewUrl": "https://drive.google.com/open?id=file-1",
                }
            ]
        },
        content=[SimpleNamespace(text='{"files": []}')],
    )
    normalized = _normalize_and_cap(result, project=_search_metadata)
    assert normalized.truncated is False
    assert normalized.payload["files"] == [
        {
            "id": "file-1",
            "title": "Recording",
            "mimeType": "video/mp4",
            "viewUrl": "https://drive.google.com/open?id=file-1",
        }
    ]
