import importlib.util
import json
import os
from pathlib import Path

import pytest

from hushh_mcp import runtime_settings


def test_referral_scheduler_configuration_survives_sync_and_hydration(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py"
    spec = importlib.util.spec_from_file_location("referral_runtime_sync", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    existing = {
        "environment": "uat",
        "referral_scoring_drain_enabled": True,
        "referral_scoring_drain_scheduler_audience": "https://api.uat.hushh.ai",
        "referral_scoring_drain_scheduler_project_id": "hushh-pda-uat",
        "referral_scoring_drain_scheduler_service_account_email": "referral-scoring-sched@hushh-pda-uat.iam.gserviceaccount.com",
        "unowned_configuration": "must not be retained",
    }
    retained = module._retained_referral_config(
        existing, project="hushh-pda-uat", environment="uat"
    )
    assert "unowned_configuration" not in retained
    for key in retained:
        monkeypatch.delenv(key.upper(), raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps(retained))
    runtime_settings.hydrate_runtime_environment()
    assert os.environ["REFERRAL_SCORING_DRAIN_ENABLED"] == "true"
    assert os.environ["REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE"] == "https://api.uat.hushh.ai"
    with pytest.raises(ValueError, match="different environment"):
        module._retained_referral_config(existing, project="hushh-pda", environment="production")
    existing["referral_scoring_drain_scheduler_audience"] = "https://untrusted.example"
    with pytest.raises(ValueError, match="scheduler identity"):
        module._retained_referral_config(existing, project="hushh-pda-uat", environment="uat")


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


def test_managed_profiles_match_deploy_compiler_and_reject_drift(monkeypatch):
    import json
    import subprocess
    import sys
    from pathlib import Path

    from hushh_mcp.managed_ai_config import load_profile, profile_hash, validate_profile
    from hushh_mcp.runtime_settings import managed_ai_settings

    root = Path(__file__).resolve().parents[2]
    for environment in ("dev", "uat", "production"):
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", environment)
        profile = load_profile(environment)
        actual = managed_ai_settings()
        compiled = json.loads(
            subprocess.check_output(  # noqa: S603 - fixed local compiler and authored environments
                [
                    sys.executable,
                    str(root / "scripts/ops/managed_ai_config.py"),
                    "--environment",
                    environment,
                ],
                text=True,
            )
        )
        assert compiled == profile
        assert actual.config_hash == profile_hash(compiled)
        assert actual.project == profile["project"]
        assert actual.text_model == profile["text_model"]
        assert actual.live_model == profile["live_model"]
        assert actual.embedding_model == profile["embedding_model"]
        assert actual.config_hash != profile_hash({**compiled, "text_model": "changed-model"})
    import pytest

    for key, value in [
        ("project", "bad/project"),
        ("live_location", "global"),
        ("auth_mode", "developer_api_key"),
    ]:
        with pytest.raises(RuntimeError):
            validate_profile({**profile, key: value})


def test_managed_environment_guard_resolves_os_aliases_but_allows_injected_mapping():
    import importlib.util
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "config_contract", root / "scripts/ci/verify-runtime-config-contract.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for code in [
        'import os\nos.getenv("GENAI_GOOGLE_CLOUD_PROJECT")',
        'from os import getenv as read\nKEY="VERTEX_LIVE_MODEL_ID"\nread(KEY)',
        'from os import environ as env\nenv["HUSSH_GEMINI_TEXT_MODEL"]',
        'import os as system\nsystem.environ.get("PWM_TAVILY_API_KEY")',
    ]:
        assert module.managed_ai_env_violations(code)
    assert (
        module.managed_ai_env_violations(
            'def model(environ):\n return environ.get("HUSSH_GEMINI_TEXT_MODEL")'
        )
        == []
    )
