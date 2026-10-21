import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

from hushh_mcp import runtime_settings


@pytest.fixture
def plg_runtime_sync():
    path = Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py"
    spec = importlib.util.spec_from_file_location("plg_runtime_sync", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("environment", "candidate", "stored", "expected"),
    [
        ("uat", False, {}, (False, False, False, False)),
        ("production", False, {}, (False, False, False, False)),
        (
            "production",
            True,
            {
                "one_plg_export_enabled": True,
                "one_plg_activity_enabled": "false",
                "one_plg_activity_all_registered": True,
                "one_plg_audience_enabled": "true",
            },
            (True, False, True, True),
        ),
        (
            "production",
            False,
            {"one_plg_export_enabled": "false", "one_plg_activity_enabled": True},
            (False, True, False, False),
        ),
    ],
)
def test_plg_flags_survive_actual_config_writer_and_hydration(
    monkeypatch, plg_runtime_sync, environment, candidate, stored, expected
):
    module = plg_runtime_sync
    project = "hushh-pda" if environment == "production" else "hushh-pda-uat"
    origin = "https://one.hussh.ai" if environment == "production" else "https://uat.one.hussh.ai"
    existing = {
        "environment": environment,
        "google_cloud_project": project,
        "unowned_configuration": "must not be retained",
        "one_plg_export_account_ids": ["synthetic-private-cohort"],
        **stored,
    }
    writes = {}
    monkeypatch.setattr(module, "_mirror_directory_key", lambda **_: None)
    monkeypatch.setattr(module, "_resolve_secret", lambda *_: None)
    monkeypatch.setattr(module, "_sync_oauth_redirects", lambda *_: [])
    monkeypatch.setattr(
        module,
        "_read_secret",
        lambda _, name: json.dumps(existing) if name == "BACKEND_RUNTIME_CONFIG_JSON" else "",
    )
    monkeypatch.setattr(
        module, "_upsert_secret", lambda _, name, value: writes.update({name: value})
    )
    monkeypatch.setattr(
        module, "_run", lambda *_a, **_kw: pytest.fail("No cloud access in this test")
    )
    arguments = {
        "project": project,
        "environment": environment,
        "app-frontend-origin": origin,
        "db-host": "synthetic",
        "db-port": "5432",
        "db-name": "synthetic",
        "consent-sse-enabled": "false",
        "sync-remote-enabled": "false",
        "developer-api-enabled": "false",
        "remote-mcp-enabled": "false",
        "cors-allowed-origins": origin,
        "obs-data-stale-ratio-threshold": "0.35",
    }
    target = "BACKEND_RUNTIME_CONFIG_JSON"
    if candidate:
        target = "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_17_1"
        arguments["production-drive-candidate-secret"] = target
    monkeypatch.setattr(
        sys,
        "argv",
        [str(module.__file__)]
        + [item for key, value in arguments.items() for item in ("--" + key, value)],
    )
    assert module.main() == 0
    actual = json.loads(writes[target])
    keys = (
        "one_plg_export_enabled",
        "one_plg_activity_enabled",
        "one_plg_activity_all_registered",
        "one_plg_audience_enabled",
    )
    assert tuple(actual[key] for key in keys) == expected
    assert all(isinstance(actual[key], bool) for key in keys)
    assert "unowned_configuration" not in actual
    assert "one_plg_export_account_ids" not in actual
    if candidate:
        assert "BACKEND_RUNTIME_CONFIG_JSON" not in writes
    monkeypatch.setattr(runtime_settings.os, "environ", os.environ.copy())
    for key in keys:
        monkeypatch.delenv(key.upper(), raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", writes[target])
    runtime_settings.hydrate_runtime_environment()
    assert tuple(os.environ[key.upper()] for key in keys) == tuple(
        str(value).lower() for value in expected
    )


@pytest.mark.parametrize(
    "key",
    [
        "one_plg_export_enabled",
        "one_plg_activity_enabled",
        "one_plg_activity_all_registered",
        "one_plg_audience_enabled",
    ],
)
@pytest.mark.parametrize("value", [None, 0, 1, [], {}, "yes", "True"])
def test_plg_activation_rejects_ambiguous_values(plg_runtime_sync, key, value):
    with pytest.raises(ValueError, match="explicit boolean"):
        plg_runtime_sync._retained_plg_config(
            {key: value}, project="hushh-pda", environment="production"
        )


@pytest.mark.parametrize(
    ("project", "environment", "stored_environment", "stored_project"),
    [
        ("hushh-pda-uat", "uat", "production", "hushh-pda"),
        ("hushh-pda-uat", "production", "production", "hushh-pda"),
        ("hushh-pda", "production", "uat", "hushh-pda"),
        ("hushh-pda", "production", "production", "hushh-pda-uat"),
    ],
)
@pytest.mark.parametrize(
    "key",
    ["one_plg_activity_enabled", "one_plg_activity_all_registered", "one_plg_audience_enabled"],
)
def test_plg_activation_cannot_cross_environment_or_project(
    plg_runtime_sync, project, environment, stored_environment, stored_project, key
):
    with pytest.raises(ValueError, match="production environment and project"):
        plg_runtime_sync._retained_plg_config(
            {
                key: True,
                "environment": stored_environment,
                "google_cloud_project": stored_project,
            },
            project=project,
            environment=environment,
        )


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


def test_managed_capability_policy_is_uat_only_versioned_and_rejects_conflicting_selection(
    monkeypatch, tmp_path
):
    import json

    import pytest

    from hushh_mcp.managed_ai_config import PROFILE_PATH, load_managed_runtime_policy

    for key in ("HUSHH_UAT_MANAGED_AI_PROVIDER", "HUSHH_UAT_MANAGED_TEXT_PROVIDER"):
        monkeypatch.delenv(key, raising=False)
    assert load_managed_runtime_policy(environment="production") is None
    azure = load_managed_runtime_policy(environment="uat")
    assert azure["provider"] == "azure_openai" and azure["azure"]["embedding_dimensions"] == 768
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    vertex = load_managed_runtime_policy(environment="uat")
    assert vertex["generation"] != azure["generation"]
    monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "azure_openai")
    with pytest.raises(ValueError, match="disagree"):
        load_managed_runtime_policy(environment="uat")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER")
    value = json.loads(PROFILE_PATH.read_text())
    value["managed_runtime_uat"]["azure"]["embedding_dimensions"] = 384
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="768"):
        load_managed_runtime_policy(path, environment="uat")
