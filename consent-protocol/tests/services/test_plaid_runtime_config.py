from __future__ import annotations

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
        "FRONTEND_URL",
    ]
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def test_from_env_ignores_placeholder_webhook_and_derives_from_https_frontend(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai")
    monkeypatch.setenv("PLAID_WEBHOOK_URL", "https://<your-tunnel>/api/kai/plaid/webhook")

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url == "https://kai.hushh.ai/api/kai/plaid/webhook"


def test_from_env_preserves_valid_webhook_without_query_or_fragment(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv(
        "PLAID_WEBHOOK_URL",
        "https://uat.kai.hushh.ai/api/kai/plaid/webhook?foo=1#fragment",
    )

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url == "https://uat.kai.hushh.ai/api/kai/plaid/webhook"


def test_from_env_invalid_webhook_without_frontend_falls_back_to_none(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("PLAID_WEBHOOK_URL", "not-a-url")

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url is None


def test_from_env_invalid_webhook_with_http_frontend_falls_back_to_none(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("PLAID_WEBHOOK_URL", "https://<your-tunnel>/api/kai/plaid/webhook")
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")

    config = PlaidRuntimeConfig.from_env()

    assert config.webhook_url is None


def test_from_env_http_frontend_does_not_derive_redirect_uri(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")

    config = PlaidRuntimeConfig.from_env()

    assert config.redirect_uri is None


def test_from_env_https_frontend_derives_redirect_uri(monkeypatch):
    _clear_plaid_env(monkeypatch)
    monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai")
    monkeypatch.setenv("PLAID_REDIRECT_PATH", "/kai/plaid/oauth/return")

    config = PlaidRuntimeConfig.from_env()

    assert config.redirect_uri == "https://kai.hushh.ai/kai/plaid/oauth/return"
