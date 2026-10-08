import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

from hushh_mcp import runtime_settings


def test_google_maps_api_key_is_read_from_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "x" * 64)
    monkeypatch.setenv("VAULT_DATA_KEY", "a" * 64)
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "test-maps-key")
    runtime_settings.get_core_security_settings.cache_clear()
    settings = runtime_settings.get_core_security_settings()
    assert settings.google_maps_api_key == "test-maps-key"
    runtime_settings.get_core_security_settings.cache_clear()


def test_google_maps_api_key_defaults_empty(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "x" * 64)
    monkeypatch.setenv("VAULT_DATA_KEY", "a" * 64)
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    runtime_settings.get_core_security_settings.cache_clear()
    settings = runtime_settings.get_core_security_settings()
    assert settings.google_maps_api_key == ""
    runtime_settings.get_core_security_settings.cache_clear()


def test_trusted_device_rollout_is_hydrated_from_canonical_runtime_config(monkeypatch):
    monkeypatch.delenv("HUSSH_TRUSTED_DEVICE_ENABLED", raising=False)
    monkeypatch.delenv("HUSSH_TRUSTED_DEVICE_UAT_ALLOWLIST", raising=False)
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(
            {
                "hushh_trusted_device_enabled": "true",
                "hushh_trusted_device_uat_allowlist": [
                    "reviewer@example.com",
                    "reviewer-uid",
                ],
            }
        ),
    )

    runtime_settings.hydrate_runtime_environment()

    assert os.environ["HUSSH_TRUSTED_DEVICE_ENABLED"] == "true"
    assert os.environ["HUSSH_TRUSTED_DEVICE_UAT_ALLOWLIST"] == "reviewer@example.com,reviewer-uid"


def test_nearby_presence_admission_is_hydrated_from_canonical_runtime_config(monkeypatch):
    """The two admission flags must survive the config -> env hop.

    The route gate reads them with `os.getenv`, and hosted lanes only ever set
    `BACKEND_RUNTIME_CONFIG_JSON`. Without this mapping there is no supported
    way to open nearby check-in in production at all -- the gate would read
    unset and refuse every caller no matter what the deploy passed.
    """

    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", raising=False)
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(
            {
                "one_location_nearby_presence_mode": "production",
                "one_location_nearby_presence_cohort": ["owner-a", "owner-b"],
            }
        ),
    )

    runtime_settings.hydrate_runtime_environment()

    assert os.environ["ONE_LOCATION_NEARBY_PRESENCE_MODE"] == "production"
    assert os.environ["ONE_LOCATION_NEARBY_PRESENCE_COHORT"] == "owner-a,owner-b"


def test_external_crm_gateway_credentials_are_isolated_from_shared_gateway(monkeypatch):
    monkeypatch.setenv("OMNIGATEWAY_CLIENT_ID", "shared-id")
    monkeypatch.setenv("OMNIGATEWAY_CLIENT_SECRET", "shared-secret")
    monkeypatch.setenv("OMNIGATEWAY_EXT_CRM_CLIENT_ID", "external-id")
    monkeypatch.setenv("OMNIGATEWAY_EXT_CRM_CLIENT_SECRET", "external-secret")

    assert runtime_settings.get_omnigateway_transport_headers("shared") == (
        ("client_id", "shared-id"),
        ("client_secret", "shared-secret"),
    )
    assert runtime_settings.get_omnigateway_transport_headers("external_crm") == (
        ("client_id", "external-id"),
        ("client_secret", "external-secret"),
    )
    assert runtime_settings.get_omnigateway_transport_headers("unknown") == ()


def test_every_connector_feature_is_hydrated_from_structured_config(monkeypatch):
    from hushh_mcp.services.connector_feature_admission import FEATURES, connector_features

    for name in FEATURES.values():
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("CONNECTOR_UAT_ALL_USERS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "")
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON", json.dumps({name: "true" for name in FEATURES})
    )
    runtime_settings.hydrate_runtime_environment()
    assert connector_features("signed-in-user") == dict.fromkeys(FEATURES, True)


def _scope_policy_sync():
    path = Path(__file__).resolve().parents[2] / "scripts/ops/scope_commerce_runtime_policy.py"
    spec = importlib.util.spec_from_file_location("scope_policy_sync", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_commerce_country_json_and_drain_identity_survive_hydration(monkeypatch):
    countries = {"US": {"currency": "usd", "minimum_cents": 50}}
    policy = {
        "scope_commerce_enabled": False,
        "scope_commerce_country_policies_json": countries,
        "scope_commerce_drain_audience": "https://backend.example/api/internal/scope-commerce-work/drain",
        "scope_commerce_drain_scheduler_service_accounts": [
            "drain@example.iam.gserviceaccount.com"
        ],
    }
    for key in policy:
        monkeypatch.delenv(runtime_settings._BACKEND_RUNTIME_ENV_MAP[key], raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps(policy))
    runtime_settings.hydrate_runtime_environment()
    assert os.environ["SCOPE_COMMERCE_ENABLED"] == "false"
    assert json.loads(os.environ["SCOPE_COMMERCE_COUNTRY_POLICIES_JSON"]) == countries
    assert os.environ["SCOPE_COMMERCE_DRAIN_AUDIENCE"] == policy["scope_commerce_drain_audience"]
    assert (
        os.environ["SCOPE_COMMERCE_DRAIN_SCHEDULER_SERVICE_ACCOUNTS"]
        == policy["scope_commerce_drain_scheduler_service_accounts"][0]
    )
    # SDK/webhook credentials must never hydrate from shared structured policy.
    assert "scope_commerce_stripe_secret_key" not in runtime_settings._BACKEND_RUNTIME_ENV_MAP
    assert "scope_commerce_stripe_webhook_secret" not in runtime_settings._BACKEND_RUNTIME_ENV_MAP


def test_commerce_pause_preserves_existing_reconciliation_policy(tmp_path):
    sync = _scope_policy_sync()
    existing = {
        "scope_commerce_enabled": True,
        "scope_commerce_country_policies_json": {
            "US": {
                "currency": "usd",
                "minimum_cents": 50,
                "retention_days": 30,
                "fixed_fee_micro_usd": 0,
                "fee_basis_points": 0,
                "unattributed_fees": False,
                "residual_resolution_ref": "reviewed-residual-policy",
            }
        },
        "scope_commerce_drain_audience": "https://backend.example/drain",
        "scope_commerce_drain_scheduler_service_accounts": ["drain@example.com"],
        "unrelated": "ignored",
    }
    assert sync._merge_scope_commerce_policy(existing) == {
        key: value for key, value in existing.items() if key.startswith("scope_commerce_")
    }
    policy_file = tmp_path / "approved-policy.json"
    policy_file.write_text(json.dumps({"scope_commerce_enabled": False}))
    merged = sync._merge_scope_commerce_policy(existing, str(policy_file))
    assert merged["scope_commerce_enabled"] is False
    assert (
        merged["scope_commerce_country_policies_json"]
        == existing["scope_commerce_country_policies_json"]
    )
    assert merged["scope_commerce_drain_audience"] == existing["scope_commerce_drain_audience"]
    assert (
        merged["scope_commerce_drain_scheduler_service_accounts"]
        == existing["scope_commerce_drain_scheduler_service_accounts"]
    )


@pytest.mark.parametrize(
    "policy",
    [
        {"scope_commerce_stripe_secret_key": "forbidden"},
        {"scope_commerce_enabled": "false"},
        {"scope_commerce_country_policies_json": "{'US': {}}"},
        {"scope_commerce_country_policies_json": {"US": {"secret_key": "forbidden"}}},
        {"scope_commerce_drain_scheduler_service_accounts": [42]},
        {"scope_commerce_stripe_webhook_mode": "unverified"},
        {"scope_commerce_stripe_connect_webhook_secret": "forbidden"},
    ],
)
def test_commerce_policy_rejects_secret_or_malformed_overlay(policy):
    with pytest.raises(ValueError):
        _scope_policy_sync()._validated_scope_commerce_policy(policy)


def test_unreadable_runtime_policy_cannot_be_treated_as_bootstrap():
    sync = _scope_policy_sync()

    def denied(*args, **kwargs):
        return subprocess.CompletedProcess([], 1, "", "PERMISSION_DENIED")

    def absent(*args, **kwargs):
        return subprocess.CompletedProcess([], 1, "", "NOT_FOUND")

    with pytest.raises(ValueError, match="refusing to replace"):
        sync._read_existing_runtime_config("example-project", denied, lambda *args: False)
    assert sync._read_existing_runtime_config("example-project", absent, lambda *args: False) == {}


def test_commerce_sdk_and_webhook_mounts_are_independent_of_drive():
    source = (
        Path(__file__).resolve().parents[2] / "scripts/deploy/scope-commerce-secrets.sh"
    ).read_text()
    backend = (Path(__file__).resolve().parents[2] / "scripts/deploy/backend-deploy.sh").read_text()
    assert "scope-commerce-secrets.sh" in backend and "append_payment_provider_secrets" in backend
    for name in (
        "SCOPE_COMMERCE_STRIPE_SECRET_KEY",
        "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
        "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
    ):
        assert f'append_optional_secret "{name}" "{name}"' in source


def test_sandbox_pause_preserves_caps_and_rejects_cross_environment_overlay(tmp_path, monkeypatch):
    sync = _scope_policy_sync()
    sandbox = {
        "environment": "sandbox",
        "platform_account_id": "acct_sandbox",
        "reviewer_user_ids": ["primary", "counterpart"],
        "reviewer_funding_cap_cents": 2000,
        "operating_capital_cap_cents": 2500,
    }
    existing = {
        "scope_commerce_enabled": True,
        "scope_commerce_stripe_livemode": False,
        "scope_commerce_stripe_account_id": "acct_sandbox",
        "scope_commerce_sandbox_policy_required": True,
        "scope_commerce_sandbox_policy_json": sandbox,
        "scope_commerce_stripe_webhook_mode": "endpoints",
        "scope_commerce_monitoring_enabled": True,
        "scope_commerce_monitoring_project_id": "hushh-pda-dev",
        "scope_commerce_monitoring_backend_service": "commerce-preview",
    }
    policy_file = tmp_path / "policy.json"
    policy_file.write_text(json.dumps({"scope_commerce_enabled": False}))
    merged = sync._merge_scope_commerce_policy(existing, str(policy_file))
    assert merged["scope_commerce_sandbox_policy_json"] == sandbox
    assert merged["scope_commerce_monitoring_enabled"] is True
    for key in merged:
        monkeypatch.delenv(runtime_settings._BACKEND_RUNTIME_ENV_MAP[key], raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps(merged))
    runtime_settings.hydrate_runtime_environment()
    assert json.loads(os.environ["SCOPE_COMMERCE_SANDBOX_POLICY_JSON"]) == sandbox
    for replacement in (
        {"scope_commerce_stripe_livemode": True},
        {"scope_commerce_stripe_account_id": "acct_other"},
        {"scope_commerce_sandbox_policy_json": sandbox | {"reviewer_funding_cap_cents": 2001}},
    ):
        policy_file.write_text(json.dumps(replacement))
        with pytest.raises(ValueError):
            sync._merge_scope_commerce_policy(existing, str(policy_file))
