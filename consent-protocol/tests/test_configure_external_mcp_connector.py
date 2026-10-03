from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.services.external_mcp_client import ExternalMcpAuthError
from hushh_mcp.services.external_mcp_connector_descriptor import (
    ExternalMcpConnectorDescriptorError,
    load_and_validate_descriptor,
)
from scripts.ops import configure_external_mcp_connector as cli


def _write(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "connector.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _hubspot_descriptor(**overrides: object) -> dict:
    payload = {
        "version": "external-mcp-connector.v1",
        "connectorId": "acme_crm",
        "displayName": "HubSpot",
        "description": "Connect HubSpot so Kai can read and act on your CRM.",
        "mcpEndpoint": "https://mcp.hubspot.com/",
        "authStyle": "oauth",
        "oauthAuthorizeUrl": "https://mcp.hubspot.com/oauth/authorize/user",
        "oauthTokenUrl": "https://mcp.hubspot.com/oauth/v3/token",
        "oauthScopes": [],
        "oauthClientIdEnv": "HUBSPOT_OAUTH_CLIENT_ID",
        "oauthClientSecretEnv": "HUBSPOT_OAUTH_CLIENT_SECRET",
        "registeredRedirectUris": ["https://uat.one.hushh.ai/one/profile/connectors/oauth/return"],
        "chatAdmission": "reviewed",
        "toolAllowlist": ["search", "read_page"],
    }
    payload.update(overrides)
    return payload


@dataclass
class _QueryResult:
    data: list[dict[str, Any]]


class _FakeDb:
    """Records every execute_raw call; returns queued results in order."""

    def __init__(self, results: list[_QueryResult]) -> None:
        self._results = list(results)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def execute_raw(self, sql: str, params: dict[str, Any] | None = None) -> _QueryResult:
        self.calls.append((sql, params or {}))
        if not self._results:
            raise AssertionError("execute_raw called more times than results were queued")
        return self._results.pop(0)


def test_apply_writes_transport_kind_capability_policy_and_redirect_uris(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = load_and_validate_descriptor(_write(tmp_path, _hubspot_descriptor()))
    fake_db = _FakeDb([_QueryResult(data=[{"connector_id": "acme_crm"}])])
    monkeypatch.setattr(cli, "get_db", lambda: fake_db)

    result = cli._apply(descriptor, operator="operator@hushh.ai")

    assert result == {"connectorId": "acme_crm", "status": "active"}
    assert len(fake_db.calls) == 1
    sql, params = fake_db.calls[0]
    assert "transport_kind" in sql
    assert "capability_policy" in sql
    assert "registered_redirect_uris" in sql
    assert params["capability_policy"] == json.dumps(
        {"version": 1, "chat": "reviewed", "tools": ["search", "read_page"]}
    )
    assert params["redirect_uris"] == json.dumps(
        ["https://uat.one.hushh.ai/one/profile/connectors/oauth/return"]
    )


def test_apply_omits_tools_key_when_no_allowlist_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _hubspot_descriptor()
    del payload["toolAllowlist"]
    descriptor = load_and_validate_descriptor(_write(tmp_path, payload))
    fake_db = _FakeDb([_QueryResult(data=[{"connector_id": "acme_crm"}])])
    monkeypatch.setattr(cli, "get_db", lambda: fake_db)

    cli._apply(descriptor, operator="operator@hushh.ai")

    _, params = fake_db.calls[0]
    assert params["capability_policy"] == json.dumps({"version": 1, "chat": "reviewed"})


def test_apply_never_overwrites_a_private_registration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The WHERE external_mcp_connectors.user_id IS NULL guard means a
    # conflict against a private row returns no RETURNING row -- exactly
    # what an empty result simulates here.
    descriptor = load_and_validate_descriptor(_write(tmp_path, _hubspot_descriptor()))
    fake_db = _FakeDb([_QueryResult(data=[])])
    monkeypatch.setattr(cli, "get_db", lambda: fake_db)

    with pytest.raises(ExternalMcpConnectorDescriptorError, match="private registration"):
        cli._apply(descriptor, operator="operator@hushh.ai")


def test_apply_refuses_a_manual_descriptor_for_a_registration_only_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _hubspot_descriptor(
        connectorId="attio",
        displayName="Attio",
        mcpEndpoint="https://mcp.attio.com/mcp",
        oauthAuthorizeUrl="https://app.attio.com/oidc/authorize",
        oauthTokenUrl="https://app.attio.com/oidc/token",
        oauthClientIdEnv="ATTIO_OAUTH_CLIENT_ID",
        tokenEndpointAuth="none",
    )
    del payload["oauthClientSecretEnv"]
    descriptor = load_and_validate_descriptor(_write(tmp_path, payload))
    monkeypatch.setattr(cli, "get_db", pytest.fail)

    with pytest.raises(ExternalMcpConnectorDescriptorError, match="registration-only spec"):
        cli._apply(descriptor, operator="operator@hushh.ai")


@pytest.mark.asyncio
async def test_probe_tolerates_auth_gated_discovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = load_and_validate_descriptor(_write(tmp_path, _hubspot_descriptor()))

    async def _raise_auth_error(*, endpoint: str) -> list[dict[str, Any]]:
        raise ExternalMcpAuthError()

    monkeypatch.setattr(cli, "list_tools", _raise_auth_error)

    result = await cli._probe(descriptor)

    assert result == {
        "toolCount": None,
        "toolNames": None,
        "requiresAuthForDiscovery": True,
    }


@pytest.mark.asyncio
async def test_probe_reports_tools_when_discovery_is_anonymous(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = load_and_validate_descriptor(_write(tmp_path, _hubspot_descriptor()))

    async def _list_tools(*, endpoint: str) -> list[dict[str, Any]]:
        return [{"name": "b_tool"}, {"name": "a_tool"}]

    monkeypatch.setattr(cli, "list_tools", _list_tools)

    result = await cli._probe(descriptor)

    assert result == {
        "toolCount": 2,
        "toolNames": ["a_tool", "b_tool"],
        "requiresAuthForDiscovery": False,
    }
