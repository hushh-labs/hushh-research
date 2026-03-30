from __future__ import annotations

import asyncio
import json

from starlette.requests import Request

from mcp_modules.resources import list_resources, read_resource
from mcp_modules.tools.utility_tools import handle_list_scopes
from server import _mcp_root_redirect_target


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


def test_mcp_resources_include_developer_api():
    resources = {str(resource.uri) for resource in asyncio.run(list_resources())}
    assert "hushh://info/developer-api" in resources


def test_read_developer_api_resource_returns_contract_summary():
    payload = json.loads(asyncio.run(read_resource("hushh://info/developer-api")))
    assert payload["base_path"] == "/api/v1"
    assert payload["auth"]["developer_token_transport"] == "query"  # noqa: S105
    assert payload["auth"]["remote_mcp_url_template"] == "/mcp/?token=<developer-token>"
    assert "hushh://info/developer-api" in payload["mcp_resources"]


def test_mcp_root_redirect_target_preserves_query_string():
    request = _request_for_mcp_root(b"token=abc123")
    assert _mcp_root_redirect_target(request) == "/mcp/?token=abc123"


def test_mcp_root_redirect_target_without_query_uses_relative_path():
    request = _request_for_mcp_root()
    assert _mcp_root_redirect_target(request) == "/mcp/"


def test_handle_list_scopes_accepts_standard_mcp_arguments(monkeypatch):
    class _FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "scopes": [{"name": "pkm.read"}],
                "scopes_are_dynamic": True,
            }

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url: str):
            assert url.endswith("/api/v1/list-scopes")
            return _FakeResponse()

    monkeypatch.setattr("mcp_modules.tools.utility_tools.httpx.AsyncClient", _FakeAsyncClient)

    payload = asyncio.run(handle_list_scopes({"cursor": None}))
    assert json.loads(payload[0].text)["scopes_are_dynamic"] is True
