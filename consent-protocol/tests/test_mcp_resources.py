from __future__ import annotations

import asyncio
import json

import pytest
from starlette.requests import Request

from mcp_modules import resources as resource_module
from mcp_modules.resources import list_resources, read_resource
from server import _mcp_root_redirect_target


@pytest.fixture(autouse=True)
def _standard_developer_resource_profile(monkeypatch):
    # Exercise resources independently of ambient credentials or Agentforce mode.
    monkeypatch.setattr(resource_module, "get_current_developer_principal", lambda: None)
    monkeypatch.setattr(resource_module, "get_current_schema_profile", lambda: "standard")


def _request_for_mcp_root(query: bytes = b"") -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/mcp",
            "query_string": query,
            "headers": [],
        }
    )


def test_standard_profile_advertises_no_resources():
    assert asyncio.run(list_resources()) == []


def test_read_developer_api_resource_returns_contract_summary():
    payload = json.loads(asyncio.run(read_resource("hushh://info/developer-api")))
    assert payload["base_path"] == "/api/v1"
    assert payload["authentication"] == (
        "Authorization: Bearer <developer-token> or an OAuth access token."
    )
    assert payload["query_token_authentication"] is False
    assert payload["remote_mcp_endpoint"] == "/mcp/"


def test_protocol_and_connector_resources_use_current_pkm_scope_language():
    protocol_payload = json.loads(asyncio.run(read_resource("hushh://info/protocol")))
    connector_payload = json.loads(asyncio.run(read_resource("hushh://info/connector")))
    serialized = json.dumps([protocol_payload, connector_payload])

    assert "world_model.read" not in serialized
    assert "world_model.write" not in serialized
    assert "consent_token" not in serialized
    assert "firebase" not in serialized.lower()
    assert "search-user-scopes" in connector_payload["tools"]


def test_mcp_root_redirect_target_drops_query_string():
    request = _request_for_mcp_root(b"token=abc123")
    assert _mcp_root_redirect_target(request) == "/mcp/"


def test_mcp_root_redirect_target_without_query_uses_relative_path():
    request = _request_for_mcp_root()
    assert _mcp_root_redirect_target(request) == "/mcp/"
