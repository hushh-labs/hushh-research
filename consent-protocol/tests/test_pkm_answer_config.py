"""Answer credentials are independent of application/Drive mode."""

from unittest.mock import Mock

import pytest

from hushh_mcp.services import pkm_answer_config as config


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("STRIPE_MODE", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_shared_key_value_123456")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_shared_test_signing_value")
    for name in (
        "PKM_ANSWER_STRIPE_MODE",
        "PKM_ANSWER_STRIPE_SECRET_KEY",
        "PKM_ANSWER_STRIPE_WEBHOOK_SECRET",
        "PKM_ANSWER_COMPOSER_ENABLED",
        "PKM_ANSWER_LIVE_PROVIDER_REVIEWED",
        "PKM_ANSWER_STRIPE_TEST_SECRET_KEY",
        "PKM_ANSWER_STRIPE_TEST_WEBHOOK_SECRET",
        "PKM_ANSWER_STRIPE_LIVE_SECRET_KEY",
        "PKM_ANSWER_STRIPE_LIVE_WEBHOOK_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(
        config, "get_app_runtime_settings", lambda: Mock(app_frontend_origin="https://uat.hushh.ai")
    )


def test_live_answer_mode_does_not_change_drive_mode(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_answer_key_value_123456")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_answer_live_signing_value")
    assert config.answer_payment_config()[0].startswith("sk_live_")
    assert config.configured_stripe_mode() == "test"
    assert not config.answer_composer_enabled()


def test_test_only_compatibility_uses_existing_secrets():
    assert config.answer_payment_config()[0].startswith("sk_test_shared_")


@pytest.mark.parametrize(
    "mode,key,secret",
    [
        ("live", None, None),
        ("live", "sk_test_wrong_mode_key_123456", "whsec_correct_signing_secret"),
        ("test", "sk_test_valid_key_123456", None),
        ("unknown", None, None),
    ],
)
def test_incomplete_or_wrong_mode_credentials_fail_closed(monkeypatch, mode, key, secret):
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", mode)
    if key:
        monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", key)
    if secret:
        monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", secret)
    with pytest.raises(ValueError):
        config.answer_payment_config()


def test_production_refuses_test_mode(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "test")
    with pytest.raises(ValueError):
        config.answer_payment_config()


def test_live_composition_requires_separate_provider_review(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "true")
    assert not config.answer_composer_enabled()
    monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "true")
    assert config.answer_composer_enabled()


@pytest.mark.parametrize("mode,expected_code", [("live", 1), ("test", 0)])
def test_cloud_build_provider_review_gate_runs_before_deployment(monkeypatch, mode, expected_code):
    """Execute the actual pre-deploy gate, including the test-mode exception."""
    import os
    import subprocess
    from pathlib import Path

    import yaml

    root = Path(__file__).resolve().parents[2]
    cloudbuild = yaml.safe_load((root / "deploy/backend.cloudbuild.yaml").read_text())
    gate = next(
        step
        for step in cloudbuild["steps"]
        if "Live answers require verified provider" in str(step.get("args"))
    )
    body = gate["args"][1]
    start = body.index(
        'if [[ "${_PKM_ANSWER_PAYMENTS_ENABLED}" == "true" && "${_PKM_ANSWER_STRIPE_MODE}" == "live"'
    )
    actual_gate = body[start : body.index("\nfi", start) + len("\nfi")]
    deploy_index = next(
        index
        for index, step in enumerate(cloudbuild["steps"])
        if step.get("id") == "deploy-backend"
    )
    assert cloudbuild["steps"].index(gate) < deploy_index
    completed = subprocess.run(  # noqa: S603 - audited repository deployment gate
        ["bash", "-c", actual_gate],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "_PKM_ANSWER_PAYMENTS_ENABLED": "true",
            "_PKM_ANSWER_COMPOSER_ENABLED": "true",
            "_PKM_ANSWER_STRIPE_MODE": mode,
            "_PKM_ANSWER_LIVE_PROVIDER_REVIEWED": "false",
        },
    )
    assert completed.returncode == expected_code
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", mode)
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "false")
    assert config.answer_composer_enabled() is (mode == "test")
    assert config.configured_stripe_mode() == "test"


@pytest.mark.parametrize(
    "environment,mode,origin,allowed",
    [
        ("development", "test", "http://localhost:3000", True),
        ("development", "test", "http://example.com", False),
        ("uat", "test", "http://localhost:3000", False),
        ("development", "live", "http://localhost:3000", False),
    ],
)
def test_only_isolated_local_test_checkout_may_use_http(
    monkeypatch, environment, mode, origin, allowed
):
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", mode)
    monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", f"sk_{mode}_isolated_key_123456")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_isolated_signing_value")
    monkeypatch.setattr(
        config, "get_app_runtime_settings", lambda: Mock(app_frontend_origin=origin)
    )
    if allowed:
        assert config.answer_payment_config()[2] == origin
    else:
        with pytest.raises(ValueError):
            config.answer_payment_config()


def test_retained_modes_have_independent_credentials(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    for mode in ("test", "live"):
        monkeypatch.setenv(
            f"PKM_ANSWER_STRIPE_{mode.upper()}_SECRET_KEY", f"sk_{mode}_retained_synthetic_key"
        )
        monkeypatch.setenv(
            f"PKM_ANSWER_STRIPE_{mode.upper()}_WEBHOOK_SECRET", f"whsec_{mode}_retained_synthetic"
        )
    assert config.available_answer_payment_modes() == ("test", "live")
    assert config.answer_payment_config("test")[0].startswith("sk_test_")
    assert config.answer_payment_config("live")[0].startswith("sk_live_")
    assert config.configured_stripe_mode() == "test"


def test_uat_deploy_maps_composer_review_and_optional_retained_credentials():
    from pathlib import Path

    import yaml

    root = Path(__file__).resolve().parents[2]
    workflow = (root / ".github/workflows/deploy-uat.yml").read_text()
    cloudbuild_text = (root / "deploy/backend.cloudbuild.yaml").read_text()
    cloudbuild = yaml.safe_load(cloudbuild_text)
    for flag, repo_var in (
        ("COMPOSER_ENABLED", "COMPOSER_UAT_ENABLED"),
        ("LIVE_PROVIDER_REVIEWED", "LIVE_PROVIDER_UAT_REVIEWED"),
    ):
        assert f"_PKM_ANSWER_{flag}=${{{{ vars.PKM_ANSWER_{repo_var} || 'false' }}}}" in workflow
        assert (
            f"PKM_ANSWER_{flag}"
            in cloudbuild_text.split("for n in PKM_ANSWER_REQUESTS_ENABLED", 1)[1].split("; do", 1)[
                0
            ]
        )
        assert 'v="_${n}"' in cloudbuild_text and 'add_env "${n}" "${!v}"' in cloudbuild_text
        assert cloudbuild["substitutions"][f"_PKM_ANSWER_{flag}"] == "false"
    for environment, suffix in (("uat", "UAT"), ("dev", "DEV"), ("production", "PROD")):
        mapped = (root / f".github/workflows/deploy-{environment}.yml").read_text()
        for mode in ("TEST", "LIVE"):
            for name, retained_test_default in (
                (f"PKM_ANSWER_STRIPE_{mode}_SECRET_KEY", "STRIPE_SECRET_KEY"),
                (f"PKM_ANSWER_STRIPE_{mode}_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"),
            ):
                default = retained_test_default if environment == "uat" and mode == "TEST" else ""
                assert (
                    f"_{name}_SECRET=${{{{ vars.{name}_{suffix}_SECRET || '{default}' }}}}"
                    in mapped
                )
                assert f'add_secret "${{_{name}_SECRET}}" "{name}"' in cloudbuild_text
                assert cloudbuild["substitutions"][f"_{name}_SECRET"] == ""
