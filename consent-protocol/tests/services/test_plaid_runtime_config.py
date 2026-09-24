from __future__ import annotations

import pytest

from hushh_mcp.integrations.plaid.config import PlaidRuntimeConfig


def _clear_plaid_env(monkeypatch) -> None:
    keys = [
        "PLAID_ENV",
        "PLAID_ENVIRONMENT",
        "PLAID_CLIENT_ID",
        "PLAID_SECRET",
        "PLAID_COUNTRY_CODES",
        "PLAID_LANGUAGE",
        "PLAID_CLIENT_NAME",
        "PLAID_WEBHOOK_URL",
        "PLAID_REDIRECT_PATH",
        "PLAID_REDIRECT_URI",
        "PLAID_OAUTH_REDIRECT_URI",
        "PLAID_TX_HISTORY_DAYS",
        "PLAID_INVESTMENTS_MANUAL_ENTRY_ENABLED",
        "PLAID_INVESTMENTS_CRYPTO_WALLET_ENABLED",
        "PLAID_ANDROID_PACKAGE_NAME",
        "APP_FRONTEND_ORIGIN",
    ]
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def test_from_env_ignores_placeholder_webhook_and_derives_from_https_frontend(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")
    monkeypatch.setenv("PLAID_WEBHOOK_URL", "https://<your-tunnel>/api/kai/plaid/webhook")

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url == "https://one.hushh.ai/api/kai/plaid/webhook"


def test_from_env_preserves_valid_webhook_without_query_or_fragment(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv(
        "PLAID_WEBHOOK_URL",
        "https://uat.one.hushh.ai/api/kai/plaid/webhook?foo=1#fragment",
    )

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url == "https://uat.one.hushh.ai/api/kai/plaid/webhook"


def test_from_env_invalid_webhook_without_frontend_falls_back_to_none(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("PLAID_WEBHOOK_URL", "not-a-url")

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url is None


def test_from_env_invalid_webhook_with_http_frontend_falls_back_to_none(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("PLAID_WEBHOOK_URL", "https://<your-tunnel>/api/kai/plaid/webhook")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "http://localhost:3000")

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url is None


def test_from_env_http_frontend_does_not_derive_redirect_uri(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "http://localhost:3000")

    config = PlaidRuntimeConfig.from_env()

    assert config.redirect_uri is None


def test_from_env_https_frontend_derives_redirect_uri(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")

    config = PlaidRuntimeConfig.from_env()

    assert config.redirect_path == "/one/kai/plaid/oauth/return"
    assert config.redirect_uri == "https://one.hushh.ai/one/kai/plaid/oauth/return"


def test_resolve_redirect_uri_accepts_default_and_legacy_paths(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")

    config = PlaidRuntimeConfig.from_env()

    assert config.resolve_redirect_uri(None) == "https://one.hushh.ai/one/kai/plaid/oauth/return"
    assert (
        config.resolve_redirect_uri(
            "https://one.hushh.ai/one/kai/plaid/oauth/return?oauth_state=abc#fragment"
        )
        == "https://one.hushh.ai/one/kai/plaid/oauth/return"
    )
    assert (
        config.resolve_redirect_uri("https://one.hushh.ai/kai/plaid/oauth/return")
        == "https://one.hushh.ai/kai/plaid/oauth/return"
    )


def test_resolve_redirect_uri_rejects_wrong_path(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")

    config = PlaidRuntimeConfig.from_env()

    with pytest.raises(RuntimeError, match="callback path"):
        config.resolve_redirect_uri("https://one.hushh.ai/not-plaid")


def test_resolve_redirect_uri_rejects_wrong_origin(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")

    config = PlaidRuntimeConfig.from_env()

    with pytest.raises(RuntimeError, match="frontend origin"):
        config.resolve_redirect_uri("https://uat.one.hushh.ai/one/kai/plaid/oauth/return")


def test_android_package_name_defaults_to_app_id(monkeypatch):
    _clear_plaid_env(monkeypatch)

    config = PlaidRuntimeConfig.from_env()

    assert config.android_package_name == "com.hussh.app"


def test_android_package_name_env_override_and_invalid_fallback(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("PLAID_ANDROID_PACKAGE_NAME", "com.example.app")
    assert PlaidRuntimeConfig.from_env().android_package_name == "com.example.app"

    monkeypatch.setenv("PLAID_ANDROID_PACKAGE_NAME", "not a package")
    assert PlaidRuntimeConfig.from_env().android_package_name == "com.hussh.app"


@pytest.mark.parametrize("platform", [None, "", "web", "ios", "WEB", "unknown"])
def test_apply_link_platform_keeps_redirect_uri_for_web_and_ios(monkeypatch, platform):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")
    config = PlaidRuntimeConfig.from_env()
    payload: dict = {}

    sent = config.apply_link_platform(payload, platform=platform, requested_redirect_uri=None)

    assert sent == "https://one.hushh.ai/one/kai/plaid/oauth/return"
    assert payload == {"redirect_uri": "https://one.hushh.ai/one/kai/plaid/oauth/return"}


def test_apply_link_platform_android_sends_package_name_and_never_redirect_uri(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.hushh.ai")
    config = PlaidRuntimeConfig.from_env()
    payload: dict = {"redirect_uri": "https://one.hushh.ai/one/kai/plaid/oauth/return"}

    sent = config.apply_link_platform(
        payload,
        platform="android",
        # A requested URI is neither resolved nor validated on Android.
        requested_redirect_uri="https://other.example/not-plaid",
    )

    assert sent is None
    assert payload == {"android_package_name": "com.hussh.app"}
