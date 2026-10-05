from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.services.curated_connector_manifest import get_manifest, get_registration_spec
from hushh_mcp.services.external_mcp_client import ExternalMcpAuthError
from hushh_mcp.services.external_mcp_connector_descriptor import (
    ExternalMcpConnectorDescriptorError,
    load_and_validate_descriptor,
    validate_descriptor,
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


def _public_pkce_descriptor(**overrides: object) -> dict:
    payload = _hubspot_descriptor(
        mcpEndpoint="https://mcp.attio.com/mcp",
        oauthAuthorizeUrl="https://app.attio.com/oidc/authorize",
        oauthTokenUrl="https://app.attio.com/oidc/token",
        tokenEndpointAuth="none",
    )
    del payload["oauthClientSecretEnv"]
    payload.update(overrides)
    return payload


def test_apply_refuses_a_manual_descriptor_for_a_registration_only_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, registration_only_provider
) -> None:
    payload = _public_pkce_descriptor(
        connectorId="pendingco",
        displayName="Pending Co",
        oauthClientIdEnv="PENDINGCO_OAUTH_CLIENT_ID",
    )
    descriptor = load_and_validate_descriptor(_write(tmp_path, payload))
    monkeypatch.setattr(cli, "get_db", pytest.fail)

    with pytest.raises(ExternalMcpConnectorDescriptorError, match="registration-only spec"):
        cli._apply(descriptor, operator="operator@hushh.ai")


def test_apply_refuses_a_hand_written_descriptor_for_a_manifest_backed_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Attio now has a reviewed runtime manifest. A hand-written descriptor that
    # differs from what the manifest produces (here, a widened tool allowlist
    # and a missing admission pin) must still never reach the registry.
    manifest = get_manifest("attio")
    assert manifest is not None
    payload = _public_pkce_descriptor(
        connectorId="attio",
        displayName="Attio",
        oauthClientIdEnv="ATTIO_OAUTH_CLIENT_ID",
        toolAllowlist=["search", "read_page"],
    )
    descriptor = load_and_validate_descriptor(_write(tmp_path, payload))
    monkeypatch.setattr(cli, "get_db", pytest.fail)

    with pytest.raises(ExternalMcpConnectorDescriptorError, match="manifest-backed connector"):
        cli._apply(descriptor, operator="operator@hushh.ai")


def test_apply_accepts_the_attio_manifest_descriptor_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The affirmative counterpart: Attio is no longer refused as registration-only;
    # its own manifest-produced descriptor applies.
    manifest = get_manifest("attio")
    assert manifest is not None
    assert get_registration_spec("attio") is None
    raw = manifest.to_descriptor("uat")
    descriptor = load_and_validate_descriptor(_write(tmp_path, raw))
    fake_db = _FakeDb([_QueryResult(data=[{"connector_id": "attio"}])])
    monkeypatch.setattr(cli, "get_db", lambda: fake_db)

    result = cli._apply(descriptor, operator="operator@hushh.ai")

    assert result == {"connectorId": "attio", "status": "active"}
    assert len(fake_db.calls) == 1


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


_DESCRIPTOR_TAMPERS = {
    "tool allowlist widened": lambda d: d.update(
        toolAllowlist=[*d["toolAllowlist"], "delete-comment"]
    ),
    "tool allowlist narrowed": lambda d: d.update(toolAllowlist=d["toolAllowlist"][:-1]),
    "admission pin removed": lambda d: d.pop("chatAdmission"),
    "redirect added": lambda d: d.update(
        registeredRedirectUris=[*d["registeredRedirectUris"], "https://unreviewed.example/cb"]
    ),
    "scopes widened": lambda d: d.update(oauthScopes=[*d["oauthScopes"], "admin"]),
    "endpoint": lambda d: d.update(mcpEndpoint="https://unreviewed.example/mcp"),
    "token url": lambda d: d.update(oauthTokenUrl="https://unreviewed.example/token"),
    "authorize url": lambda d: d.update(oauthAuthorizeUrl="https://unreviewed.example/authorize"),
    "client id variable": lambda d: d.update(oauthClientIdEnv="SOME_OTHER_OAUTH_CLIENT_ID"),
}


@pytest.mark.parametrize("tamper", sorted(_DESCRIPTOR_TAMPERS))
def test_each_manifest_field_is_enforced_on_its_own_when_applying_a_descriptor(tamper: str) -> None:
    manifest = get_manifest("attio")
    assert manifest is not None
    exact = manifest.to_descriptor("uat")
    # The manifest's own descriptor is accepted ...
    cli._require_matches_manifest(validate_descriptor(exact))

    # ... and changing exactly one field is refused. The tampered descriptor must
    # itself be a well-formed descriptor, or the refusal would prove nothing.
    tampered = json.loads(json.dumps(exact))
    _DESCRIPTOR_TAMPERS[tamper](tampered)
    assert tampered != exact
    descriptor = validate_descriptor(tampered)
    with pytest.raises(ExternalMcpConnectorDescriptorError, match="manifest-backed connector"):
        cli._require_matches_manifest(descriptor)
