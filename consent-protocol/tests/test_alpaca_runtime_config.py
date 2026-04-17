from __future__ import annotations

from hushh_mcp.integrations.alpaca.config import AlpacaBrokerRuntimeConfig
from hushh_mcp.services.broker_funding_service import BrokerFundingService


def test_alpaca_runtime_config_normalizes_paper_to_sandbox(monkeypatch):
    monkeypatch.delenv("ALPACA_BROKER_ENV", raising=False)
    monkeypatch.setenv("ALPACA_ENV", "paper")
    monkeypatch.setenv("ALPACA_BROKER_KEY_ID", "key_123")
    monkeypatch.setenv("ALPACA_BROKER_SECRET", "secret_123")

    config = AlpacaBrokerRuntimeConfig.from_env()

    assert config.environment == "sandbox"
    assert config.base_url == "https://broker-api.sandbox.alpaca.markets"
    assert config.configured is True


def test_alpaca_runtime_config_normalizes_live_to_production(monkeypatch):
    monkeypatch.delenv("ALPACA_ENV", raising=False)
    monkeypatch.setenv("ALPACA_BROKER_ENV", "live")
    monkeypatch.setenv("ALPACA_BROKER_KEY_ID", "key_123")
    monkeypatch.setenv("ALPACA_BROKER_SECRET", "secret_123")

    config = AlpacaBrokerRuntimeConfig.from_env()

    assert config.environment == "production"
    assert config.base_url == "https://broker-api.alpaca.markets"
    assert config.configured is True


def test_alpaca_stock_lookup_trading_base_urls_follow_runtime_environment(monkeypatch):
    monkeypatch.delenv("ALPACA_TRADING_BASE_URL", raising=False)
    monkeypatch.delenv("ALPACA_API_BASE_URL", raising=False)

    service = BrokerFundingService()
    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="https://broker-api.sandbox.alpaca.markets",
        auth_header="Basic test",
        default_account_id=None,
    )
    assert service._alpaca_stock_lookup_trading_base_urls() == ["https://paper-api.alpaca.markets"]

    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="production",
        base_url="https://broker-api.alpaca.markets",
        auth_header="Basic test",
        default_account_id=None,
    )
    assert service._alpaca_stock_lookup_trading_base_urls() == ["https://api.alpaca.markets"]


def test_alpaca_stock_lookup_trading_base_urls_prioritize_explicit_override(monkeypatch):
    monkeypatch.setenv("ALPACA_TRADING_BASE_URL", "https://custom-trading.example")

    service = BrokerFundingService()
    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="https://broker-api.sandbox.alpaca.markets",
        auth_header="Basic test",
        default_account_id=None,
    )

    assert service._alpaca_stock_lookup_trading_base_urls() == [
        "https://custom-trading.example",
        "https://paper-api.alpaca.markets",
    ]
