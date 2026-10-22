import importlib.util
import json
import os
import subprocess
import sys
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


def test_shared_files_rollout_preserves_only_explicit_dev_configuration(monkeypatch):
    from runpy import run_path

    apply = run_path(
        str(Path(__file__).resolve().parents[2] / "scripts/ops/shared_files_runtime_policy.py")
    )["apply_policy"]
    configured = {
        "hussh_shared_files_enabled": True,
        "hussh_shared_files_bucket": "synthetic-files",
    }
    policy = apply({"environment": "dev"}, configured)
    for key in ("HUSSH_SHARED_FILES_ENABLED", "HUSSH_SHARED_FILES_BUCKET"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", json.dumps(policy))
    runtime_settings.hydrate_runtime_environment()
    assert os.environ["HUSSH_SHARED_FILES_ENABLED"] == "true"
    assert os.environ["HUSSH_SHARED_FILES_BUCKET"] == "synthetic-files"
    assert apply({"environment": "dev"}, {})["hussh_shared_files_enabled"] is False
    assert apply({"environment": "production"}, configured)["hussh_shared_files_enabled"] is False
    with pytest.raises(ValueError):
        apply({"environment": "dev"}, {"hussh_shared_files_enabled": True})


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


@pytest.mark.parametrize("origin", [None, "", "https://dev.one.hushh.ai"])
def test_commerce_returns_follow_application_origin_without_opening_closed_policy(origin):
    from runpy import run_path
    from types import SimpleNamespace

    root = Path(__file__).resolve().parents[2]
    normalize = run_path(str(root / "scripts/ops/sync_backend_runtime_secrets.py"))[
        "_canonical_frontend_origin"
    ]
    policy = {"scope_commerce_enabled": False, "scope_commerce_stripe_livemode": False}
    if origin is not None:
        policy["scope_commerce_frontend_origin"] = origin
    args = SimpleNamespace(
        project="hushh-pda-dev",
        scope_commerce_policy_file="",
        app_frontend_origin="https://dev.one.hussh.ai",
    )

    def read(*_args, **_kwargs):
        return SimpleNamespace(returncode=0, stdout=json.dumps(policy), stderr="")

    result = _scope_policy_sync().policy_for_args(args, read, lambda *_args: True, normalize)
    expected = dict(policy)
    if origin:
        expected["scope_commerce_frontend_origin"] = args.app_frontend_origin
    assert result == expected

    def refuse_second_read(*_args, **_kwargs):
        pytest.fail("A verified runtime snapshot must be shared by the retention policies")

    assert (
        _scope_policy_sync().policy_for_args(
            args,
            refuse_second_read,
            lambda *_args: True,
            normalize,
            existing_runtime_config=policy,
        )
        == expected
    )


@pytest.mark.parametrize(
    "origin",
    [
        "http://dev.one.hushh.ai",
        "https://dev.one.hushh.ai/path",
        "https://:443",
        "https://@dev.one.hushh.ai",
    ],
)
def test_origin_rebinding_refuses_invalid_existing_commerce_configuration(origin):
    from runpy import run_path
    from types import SimpleNamespace

    normalize = run_path(
        str(Path(__file__).resolve().parents[2] / "scripts/ops/sync_backend_runtime_secrets.py")
    )["_canonical_frontend_origin"]
    args = SimpleNamespace(
        project="hushh-pda-dev",
        scope_commerce_policy_file="",
        app_frontend_origin="https://dev.one.hussh.ai",
    )

    def read(*_args, **_kwargs):
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({"scope_commerce_frontend_origin": origin}), stderr=""
        )

    with pytest.raises(ValueError):
        _scope_policy_sync().policy_for_args(args, read, lambda *_args: True, normalize)


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
    from hushh_mcp.runtime_environment import scope_commerce_test_pin_environment

    assert scope_commerce_test_pin_environment(os.environ) == [
        {"name": "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "value": "acct_sandbox"},
        {"name": "SCOPE_COMMERCE_STRIPE_LIVEMODE", "value": "false"},
    ]
    for replacement in (
        {"scope_commerce_stripe_livemode": True},
        {"scope_commerce_stripe_account_id": "acct_other"},
        {"scope_commerce_sandbox_policy_json": sandbox | {"reviewer_funding_cap_cents": 2001}},
    ):
        policy_file.write_text(json.dumps(replacement))
        with pytest.raises(ValueError):
            sync._merge_scope_commerce_policy(existing, str(policy_file))


def test_managed_profiles_match_deploy_compiler_and_reject_drift(monkeypatch):
    import json
    import subprocess
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


def test_runtime_contract_directory_adapter_keeps_file_checks(tmp_path, monkeypatch, capsys):
    import importlib.util

    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "config_contract_directory", root / "scripts/ci/verify-runtime-config-contract.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / "agents"
    target.mkdir()
    adapter = tmp_path / "adapter"
    adapter.symlink_to(target, target_is_directory=True)
    source = tmp_path / "runtime.py"
    source.write_text(f"{module.FORBIDDEN_NAMES[0]} = 'synthetic-forbidden-setting'\n")
    monkeypatch.setattr(module, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(module, "_tracked_files", lambda: [adapter, source])
    assert module.main() == 1
    assert "runtime.py" in capsys.readouterr().err
    source.write_text("# no runtime settings\n")
    assert module.main() == 0


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
