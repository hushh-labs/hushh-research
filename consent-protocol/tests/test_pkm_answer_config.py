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
