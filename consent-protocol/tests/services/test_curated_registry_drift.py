"""A registry row that stops matching its reviewed manifest is reported ahead of time.

The runtime hides such a connector and fails its sign-in closed. These tests keep
the pre-deploy report in step with that runtime check, so a difference the
runtime would act on is never one the report calls fine.
"""

from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import external_connector_curated_oauth as oauth
from hushh_mcp.services.curated_connector_manifest import (
    all_manifests,
    get_manifest,
    registry_row_drift,
)
from hushh_mcp.services.external_connector_registry_service import ExternalMcpConnectorDefinition
from scripts.ops import provision_curated_connector as prov

ENVIRONMENT = "uat"


def row_for(manifest, **overrides) -> ExternalMcpConnectorDefinition:
    row = ExternalMcpConnectorDefinition(
        connector_id=manifest.connector_id,
        display_name=manifest.display_name,
        description=manifest.description,
        mcp_endpoint=manifest.mcp_endpoint,
        auth_style="oauth",
        oauth_authorize_url=manifest.authorize_url,
        oauth_token_url=manifest.token_url,
        oauth_scopes=manifest.scopes,
        oauth_client_id_env=manifest.client_id_env,
        oauth_client_secret_env=manifest.client_secret_env,
        api_key_header_name=None,
        is_active=True,
        transport_kind="mcp",
        capability_policy={"version": 1, "chat": "reviewed"},
        registered_redirect_uris=manifest.redirect_uris[ENVIRONMENT],
        owner_user_id=None,
    )
    return replace(row, **overrides)


@pytest.mark.parametrize("connector_id", sorted(all_manifests()))
def test_a_row_applied_from_the_manifest_has_no_drift(connector_id):
    manifest = get_manifest(connector_id)
    assert registry_row_drift(manifest, row_for(manifest), ENVIRONMENT) == []


def test_a_missing_row_is_reported():
    assert registry_row_drift(get_manifest("hubspot"), None, ENVIRONMENT) == ["missing"]


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"mcp_endpoint": "https://mcp.example.com/"}, "mcp_endpoint"),
        ({"oauth_authorize_url": "https://mcp.example.com/a"}, "oauth_authorize_url"),
        ({"oauth_token_url": "https://mcp.example.com/t"}, "oauth_token_url"),
        ({"oauth_scopes": ("extra",)}, "oauth_scopes"),
        ({"oauth_client_id_env": "OTHER_ID"}, "oauth_client_id_env"),
        ({"oauth_client_secret_env": "OTHER_SECRET"}, "oauth_client_secret_env"),
        ({"registered_redirect_uris": ()}, "registered_redirect_uris"),
        ({"registered_redirect_uris": ("https://evil.example/r",)}, "registered_redirect_uris"),
        ({"is_active": False}, "is_active"),
        ({"owner_user_id": "someone"}, "owner_user_id"),
        ({"capability_policy": {"version": 1}}, "capability_policy.chat"),
    ],
)
def test_each_difference_is_named(overrides, field):
    manifest = get_manifest("hubspot")
    assert field in registry_row_drift(manifest, row_for(manifest, **overrides), ENVIRONMENT)


def test_a_stale_secret_setting_and_a_missing_redirect_are_both_reported():
    """The Notion row on UAT: an old client-secret setting and no redirect."""
    manifest = get_manifest("notion")
    stale = row_for(
        manifest,
        oauth_client_secret_env="NOTION_OAUTH_CLIENT_SECRET",  # noqa: S106 - a variable name
        registered_redirect_uris=(),
    )
    assert registry_row_drift(manifest, stale, ENVIRONMENT) == [
        "oauth_client_secret_env",
        "registered_redirect_uris",
    ]


def test_an_environment_the_manifest_does_not_offer_is_drift():
    manifest = get_manifest("hubspot")
    assert registry_row_drift(manifest, row_for(manifest), "production") == [
        "registered_redirect_uris"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"mcp_endpoint": "https://mcp.example.com/"},
        {"oauth_authorize_url": "https://mcp.example.com/a"},
        {"oauth_token_url": "https://mcp.example.com/t"},
        {"oauth_scopes": ("extra",)},
        {"oauth_client_id_env": "OTHER_ID"},
        {"oauth_client_secret_env": "OTHER_SECRET"},
        {"registered_redirect_uris": ("https://evil.example/r",)},
    ],
)
async def test_the_report_agrees_with_the_runtime_check(overrides, monkeypatch):
    """Whatever the runtime refuses to serve, the report calls drift."""
    manifest = get_manifest("hubspot")
    row = row_for(manifest, **overrides)
    service = oauth.ExternalConnectorCuratedOAuth(
        registry=SimpleNamespace(get_connector=AsyncMock(return_value=row)),
        credentials=SimpleNamespace(),
        lifecycle=SimpleNamespace(),
        state_codec=SimpleNamespace(),
    )
    monkeypatch.setattr(oauth, "getenv", lambda name, default="": "synthetic")
    with pytest.raises(oauth.CuratedConnectorOAuthError, match="connector_configuration_invalid"):
        await service._configuration("hubspot")
    assert registry_row_drift(manifest, row, ENVIRONMENT) != []


@pytest.fixture
def fake_registry(monkeypatch):
    rows: dict[str, object] = {}

    async def get_row(connector_id, **_kwargs):
        return rows.get(connector_id)

    registry = SimpleNamespace(_get_connector_row=get_row)
    monkeypatch.setattr(
        "hushh_mcp.services.external_connector_registry_service."
        "get_external_connector_registry_service",
        lambda: registry,
    )
    return rows


def run_verify(argv):
    return prov.main(["verify", *argv])


def test_verify_reports_every_provider_and_is_quiet_when_all_match(fake_registry, capsys):
    for connector_id, manifest in all_manifests().items():
        fake_registry[connector_id] = row_for(manifest)
    assert run_verify(["--env", ENVIRONMENT, "--strict"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is True and report["drifted"] == [] and report["fix"] is None
    assert set(report["connectors"]) == set(all_manifests())


def test_verify_names_the_drifted_provider_and_strict_fails_the_exit_code(fake_registry, capsys):
    for connector_id, manifest in all_manifests().items():
        fake_registry[connector_id] = row_for(manifest)
    notion = get_manifest("notion")
    fake_registry["notion"] = row_for(notion, registered_redirect_uris=())
    assert run_verify(["--env", ENVIRONMENT]) == 0  # report only by default
    report = json.loads(capsys.readouterr().out)
    assert report["drifted"] == ["notion"]
    assert report["connectors"]["notion"]["fields"] == ["registered_redirect_uris"]
    assert "apply <id>" in report["fix"]
    assert run_verify(["--env", ENVIRONMENT, "--strict"]) == 2


def test_verify_reports_a_provider_with_no_row(fake_registry, capsys):
    for connector_id, manifest in all_manifests().items():
        if connector_id != "attio":
            fake_registry[connector_id] = row_for(manifest)
    run_verify(["attio", "--env", ENVIRONMENT])
    report = json.loads(capsys.readouterr().out)
    assert report["connectors"]["attio"] == {"status": "drift", "fields": ["missing"]}


def test_verify_never_prints_row_values(fake_registry, capsys):
    manifest = get_manifest("hubspot")
    fake_registry["hubspot"] = row_for(manifest, oauth_client_id_env="LEAK_CANARY_VALUE")
    run_verify(["hubspot", "--env", ENVIRONMENT])
    assert "LEAK_CANARY_VALUE" not in capsys.readouterr().out


def test_an_unknown_provider_is_an_error(fake_registry, capsys):
    assert run_verify(["nope", "--env", ENVIRONMENT]) == 1
