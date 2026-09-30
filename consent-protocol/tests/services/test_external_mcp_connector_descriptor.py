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
        # The real endpoint (confirmed against
        # https://mcp.hubspot.com/.well-known/oauth-authorization-server);
        # .../mcp 404s.
        "mcpEndpoint": "https://mcp.hubspot.com/",
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


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://127.0.0.1/mcp",
        "https://169.254.169.254/",
        "https://metadata.internal/",
        "https://user:secret@example.com/",
        "https://example.com/?token=secret",
        "https://example.com:8443/",
    ],
)
@pytest.mark.parametrize("field", ["mcpEndpoint", "oauthAuthorizeUrl", "oauthTokenUrl"])
def test_oauth_descriptor_rejects_non_public_endpoint(
    tmp_path: Path, field: str, endpoint: str
) -> None:
    path = _write(tmp_path, _oauth_descriptor(**{field: endpoint}))

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


def test_oauth_descriptor_allows_empty_scopes(tmp_path: Path) -> None:
    # HubSpot's real MCP server advertises scopes_supported: [] and rejects a
    # non-empty scope parameter -- an empty list is a real, valid request.
    path = _write(tmp_path, _oauth_descriptor(oauthScopes=[]))

    descriptor = load_and_validate_descriptor(path)

    assert descriptor.raw["oauthScopes"] == []


def test_oauth_descriptor_rejects_non_list_scopes(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(oauthScopes="default"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_oauth_descriptor_rejects_non_string_scope_entries(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(oauthScopes=["read", 1]))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


@pytest.mark.parametrize("connector_id", ["custom_hubspot", "google_hubspot"])
def test_reserved_connector_id_prefix_is_rejected(tmp_path: Path, connector_id: str) -> None:
    path = _write(tmp_path, _api_key_descriptor(connectorId=connector_id))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_registered_redirect_uris_accepted_when_valid(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        _oauth_descriptor(
            registeredRedirectUris=["https://uat.one.hushh.ai/one/profile/connectors/oauth/return"]
        ),
    )

    descriptor = load_and_validate_descriptor(path)

    assert descriptor.raw["registeredRedirectUris"] == [
        "https://uat.one.hushh.ai/one/profile/connectors/oauth/return"
    ]


def test_registered_redirect_uris_rejects_empty_list(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(registeredRedirectUris=[]))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_registered_redirect_uris_rejects_non_https(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        _oauth_descriptor(registeredRedirectUris=["http://uat.one.hushh.ai/return"]),
    )

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_chat_admission_accepts_reviewed(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(chatAdmission="reviewed"))

    descriptor = load_and_validate_descriptor(path)

    assert descriptor.raw["chatAdmission"] == "reviewed"


def test_chat_admission_rejects_unknown_value(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(chatAdmission="unreviewed"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_tool_allowlist_accepts_a_list_of_names(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(toolAllowlist=["search", "read_page"]))

    descriptor = load_and_validate_descriptor(path)

    assert descriptor.raw["toolAllowlist"] == ["search", "read_page"]


def test_tool_allowlist_rejects_too_many_entries(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(toolAllowlist=[f"tool_{i}" for i in range(201)]))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_oauth_descriptor_requires_uppercase_env_names(tmp_path: Path) -> None:
    path = _write(tmp_path, _oauth_descriptor(oauthClientIdEnv="notion_client_id"))

    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(path)


def test_missing_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ExternalMcpConnectorDescriptorError):
        load_and_validate_descriptor(tmp_path / "missing.json")
