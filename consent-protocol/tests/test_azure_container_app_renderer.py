"""The agent's Container Apps body: shape, identity, secrets by reference, refusals."""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.azure_container_app_renderer import (
    AgentCoordinates,
    MeteredConfigurationRefused,
    refuse_metered_configuration,
    render_container_app,
)
from hushh_mcp.services.compute_backend import POD_MEMORY, PodSpec
from hushh_mcp.services.user_gcp_backend import _MANAGED_ONLY_ENV

_IDENTITY = (
    "/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/"
    "userAssignedIdentities/id-hussh-one-pod"
)
_DIGEST = "sha256:" + "a" * 64
#: A Key Vault secret ADDRESS (the reference the platform resolves), not a secret.
_SECRET_URL = "https://kv-h1-0123456789abcdef.vault.azure.net/secrets/pod-signing-key"


def _coords(**overrides) -> AgentCoordinates:
    fields = dict(
        location="eastus2",
        environment_id="/subscriptions/s/resourceGroups/g/providers/Microsoft.App/managedEnvironments/cae-hussh-one",
        identity_id=_IDENTITY,
        identity_client_id="55555555-5555-5555-5555-555555555555",
        registry_server="crhussh0123456789abcdef.azurecr.io",
        image_digest=_DIGEST,
        blob_url="https://sthussh0123456789abcdef.blob.core.windows.net/pod",
        key_vault_key="https://kv-h1-0123456789abcdef.vault.azure.net/keys/pod-log-key/v1",
        signing_secret_url=_SECRET_URL,
        incarnation="inc-1",
        hub_caller_emails="consent-plane@hushh-pda-dev.iam.gserviceaccount.com",
        openai_endpoint="https://oai-hussh-0123456789abcdef.openai.azure.com/",
        openai_deployment="one-chat",
        tags={"hussh-tenancy": "user-owned"},
    )
    return AgentCoordinates(**{**fields, **overrides})


def _spec() -> PodSpec:
    return PodSpec(hushh_id="HA1AZURE", phone_e164_hash="h", pod_pubkey="", billing_space_id="b-1")


def _env(body: dict) -> dict[str, dict]:
    return {e["name"]: e for e in body["properties"]["template"]["containers"][0]["env"]}


def test_single_revision_scales_zero_to_one_writer_at_the_canonical_size():
    body = render_container_app(_spec(), _coords())
    props = body["properties"]
    assert props["configuration"]["activeRevisionsMode"] == "Single"
    assert props["template"]["scale"] == {"minReplicas": 0, "maxReplicas": 1}
    resources = props["template"]["containers"][0]["resources"]
    assert resources == {"cpu": 0.5, "memory": POD_MEMORY}
    assert props["workloadProfileName"] == "Consumption"


def test_http_startup_and_liveness_probes_hit_health_on_8080():
    probes = render_container_app(_spec(), _coords())["properties"]["template"]["containers"][0][
        "probes"
    ]
    assert {p["type"] for p in probes} == {"Startup", "Liveness"}
    for probe in probes:
        assert probe["httpGet"] == {"path": "/health", "port": 8080}


def test_the_image_is_pulled_by_digest_from_the_owners_registry_with_the_agent_identity():
    body = render_container_app(_spec(), _coords())
    container = body["properties"]["template"]["containers"][0]
    assert (
        container["image"] == f"crhussh0123456789abcdef.azurecr.io/consent-protocol-pod@{_DIGEST}"
    )
    assert body["properties"]["configuration"]["registries"] == [
        {"server": "crhussh0123456789abcdef.azurecr.io", "identity": _IDENTITY}
    ]
    assert body["identity"] == {"type": "UserAssigned", "userAssignedIdentities": {_IDENTITY: {}}}
    with pytest.raises(ValueError, match="digest"):
        render_container_app(_spec(), _coords(image_digest="latest"))


def test_the_signing_key_is_a_key_vault_reference_never_a_value():
    body = render_container_app(_spec(), _coords())
    assert _env(body)["APP_SIGNING_KEY"] == {
        "name": "APP_SIGNING_KEY",
        "secretRef": "app-signing-key",
    }
    assert body["properties"]["configuration"]["secrets"] == [
        {
            "name": "app-signing-key",
            "keyVaultUrl": _SECRET_URL,
            "identity": _IDENTITY,
        }
    ]
    assert all("value" not in s for s in body["properties"]["configuration"]["secrets"])


def test_storage_custody_identity_and_model_are_the_azure_contract_rows():
    env = _env(render_container_app(_spec(), _coords()))
    assert env["POD_STORAGE_BACKEND"]["value"] == "commit_log"
    assert env["POD_STORAGE_AZURE_BLOB_URL"]["value"].endswith(".blob.core.windows.net/pod")
    assert env["HUSSH_POD_KEY_VAULT_KEY"]["value"].endswith("/keys/pod-log-key/v1")
    assert env["HUSSH_POD_WRAPPED_LOG_KEY_OBJECT"]["value"] == "keys/log-key.wrapped"
    assert env["AZURE_CLIENT_ID"]["value"] == "55555555-5555-5555-5555-555555555555"
    assert env["AZURE_OPENAI_DEPLOYMENT"]["value"] == "one-chat"
    assert env["GOOGLE_GENAI_USE_VERTEXAI"]["value"] == "false"
    assert env["HUSSH_ID"]["value"] == "HA1AZURE"


def test_no_managed_only_or_gcp_custody_coordinate_reaches_the_subscription():
    env = _env(render_container_app(_spec(), _coords()))
    for name in _MANAGED_ONLY_ENV - {
        "APP_SIGNING_KEY",
        "POD_STORAGE_BACKEND",
        "POD_AGENT_MEMORY_ENABLED",
        "POD_DURABLE_IDENTITY_ENABLED",
        "HUSSH_POD_HUB_CALLER_EMAILS",
    }:
        assert name not in env, name
    for gcp_only in ("HUSSH_POD_KMS_KEY", "POD_STORAGE_GCS_BUCKET", "HUSSH_POD_USER_ADC_ENABLED",
                     "POD_MEMORY_BACKEND", "GOOGLE_CLOUD_PROJECT"):  # fmt: skip
        assert gcp_only not in env
    assert env["HUSSH_POD_HUB_CALLER_EMAILS"]["value"].startswith("consent-plane@")


def test_the_hubs_managed_custody_never_leaks_even_when_the_hub_has_it(monkeypatch):
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "hushh-pda-dev-pod-state")
    monkeypatch.setenv("HUSSH_POD_SIGNING_KEY_SECRET", "hub-pod-signing-key")
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", "hushh-pda-dev")
    rendered = json.dumps(render_container_app(_spec(), _coords()))
    for leaked in ("hushh-pda-dev-pod-state", "hub-pod-signing-key", "HUSSH_POD_LOG_KEY"):
        assert leaked not in rendered


def test_a_subscription_without_a_model_renders_no_model_coordinates():
    env = _env(render_container_app(_spec(), _coords(openai_endpoint=None, openai_deployment=None)))
    assert "AZURE_OPENAI_ENDPOINT" not in env and "AZURE_OPENAI_DEPLOYMENT" not in env


def test_ingress_is_external_https_only_and_the_wall_needs_its_caller():
    body = render_container_app(_spec(), _coords())
    ingress = body["properties"]["configuration"]["ingress"]
    assert ingress["external"] is True and ingress["allowInsecure"] is False
    assert ingress["targetPort"] == 8080
    with pytest.raises(ValueError, match="hub caller"):
        render_container_app(_spec(), _coords(hub_caller_emails=" "))


def test_the_incarnation_tag_rides_with_the_agent():
    body = render_container_app(_spec(), _coords(incarnation="inc-9"))
    assert body["tags"] == {"hussh-tenancy": "user-owned", "hussh-incarnation": "inc-9"}


@pytest.mark.parametrize(
    "extra",
    [
        {"properties": {"privateEndpointConnections": []}},
        {"properties": {"vnetConfiguration": {"internal": True}}},
        {"maintenanceConfigurations": [{"scheduledEntries": []}]},
        {"properties": {"template": {"x": [{"privateEndpoints": []}]}}},
    ],
)
def test_private_endpoints_and_maintenance_windows_are_refused(extra):
    with pytest.raises(MeteredConfigurationRefused):
        refuse_metered_configuration(extra)


def test_the_rendered_body_passes_its_own_refusal_check():
    refuse_metered_configuration(render_container_app(_spec(), _coords()))
