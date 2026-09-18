from __future__ import annotations

import json
from pathlib import Path

import pytest

from hushh_mcp.services.external_mcp_connector_descriptor import (
    ExternalMcpConnectorDescriptorError,
    load_and_validate_descriptor,
)


def _write(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "connector.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _api_key_descriptor(**overrides: object) -> dict:
    payload = {
        "version": "external-mcp-connector.v1",
        "connectorId": "hubspot",
        "displayName": "HubSpot",
        "mcpEndpoint": "https://mcp.hubspot.com/mcp",
        "authStyle": "api_key",
        "apiKeyHeaderName": "Private-App-Token",
    }
    payload.update(overrides)
    return payload


def _oauth_descriptor(**overrides: object) -> dict:
    payload = {
        "version": "external-mcp-connector.v1",
        "connectorId": "notion",
        "displayName": "Notion",
        "mcpEndpoint": "https://mcp.notion.com/mcp",
        "authStyle": "oauth",
        "oauthAuthorizeUrl": "https://api.notion.com/v1/oauth/authorize",
        "oauthTokenUrl": "https://api.notion.com/v1/oauth/token",
        "oauthScopes": ["read"],
        "oauthClientIdEnv": "NOTION_OAUTH_CLIENT_ID",
        "oauthClientSecretEnv": "NOTION_OAUTH_CLIENT_SECRET",
    }
    payload.update(overrides)
    return payload


def test_valid_api_key_descriptor_loads(tmp_path: Path) -> None:
    descriptor = load_and_validate_descriptor(_write(tmp_path, _api_key_descriptor()))

    assert descriptor.connector_id == "hubspot"
    assert descriptor.auth_style == "api_key"


def test_valid_oauth_descriptor_loads(tmp_path: Path) -> None:
    descriptor = load_and_validate_descriptor(_write(tmp_path, _oauth_descriptor()))

    assert descriptor.connector_id == "notion"
    assert descriptor.auth_style == "oauth"


def test_wrong_version_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, _api_key_descriptor(version="crm-registry.v1"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


@pytest.mark.parametrize("connector_id", ["Notion", "notion-app", "1notion", "n", ""])
def test_non_snake_case_connector_id_is_rejected(tmp_path: Path, connector_id: str) -> None:
    path = _write(tmp_path, _api_key_descriptor(connectorId=connector_id))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_non_https_endpoint_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, _api_key_descriptor(mcpEndpoint="http://mcp.hubspot.com/mcp"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_unknown_auth_style_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, _api_key_descriptor(authStyle="basic"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_api_key_descriptor_requires_header_name(tmp_path: Path) -> None:
    path = _write(tmp_path, _api_key_descriptor(apiKeyHeaderName=""))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_oauth_descriptor_requires_scopes(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(oauthScopes=[]))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_oauth_descriptor_requires_uppercase_env_names(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(oauthClientIdEnv="notion_client_id"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_missing_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(tmp_path / "missing.json")
