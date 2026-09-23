from __future__ import annotations

import json
from typing import Any

import pytest

from hushh_mcp.integrations.plaid import PlaidApiError, PlaidRuntimeConfig
from hushh_mcp.services.plaid_portfolio_service import PlaidPortfolioService


class _FakeDbResult:
    def __init__(self, data: list[dict[str, Any]] | None = None) -> None:
        self.data = data or []


class _RecordingDb:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    def execute_raw(
        self,
        query: str,
        params: dict[str, Any] | None = None,
    ) -> _FakeDbResult:
        self.calls.append((query, params))
        return _FakeDbResult()


def _configured_service(redirect_uri: str | None = None) -> PlaidPortfolioService:
    service = PlaidPortfolioService()
    service._runtime_config = PlaidRuntimeConfig(
        environment="production",
        base_url="https://production.plaid.com",
        client_id="client-id",
        secret="unit-test-plaid-config-value",  # noqa: S106 - non-secret test fixture
        country_codes=["US"],
        language="en",
        client_name="Hussh Kai",
        webhook_url=None,
        frontend_url="https://one.hushh.ai",
        redirect_path="/one/kai/plaid/oauth/return",
        redirect_uri=redirect_uri,
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )
    return service


_REDIRECT_URI = "https://one.hushh.ai/one/kai/plaid/oauth/return"


def _record_link_token_calls(monkeypatch, service: PlaidPortfolioService):
    payloads: list[dict[str, Any]] = []
    sessions: list[dict[str, Any]] = []

    async def _fake_post(
        path: str,
        payload: dict[str, Any],
        *,
        environment: str | None = None,
    ) -> dict[str, Any]:
        assert path == "/link/token/create"
        payloads.append(payload)
        return {"link_token": "link-test", "expiration": "2026-07-20T00:00:00Z"}

    def _fake_create_link_session(**kwargs: Any) -> dict[str, Any]:
        sessions.append(kwargs)
        return {"resume_session_id": "resume-123"}

    monkeypatch.setattr(service, "_post", _fake_post)
    monkeypatch.setattr(service, "_create_link_session", _fake_create_link_session)
    return payloads, sessions


@pytest.mark.asyncio
@pytest.mark.parametrize("platform_kwargs", [{}, {"platform": "web"}, {"platform": "ios"}])
async def test_link_token_web_and_ios_keep_redirect_uri(monkeypatch, platform_kwargs):
    service = _configured_service(redirect_uri=_REDIRECT_URI)
    payloads, sessions = _record_link_token_calls(monkeypatch, service)

    result = await service.create_link_token(user_id="user-123", **platform_kwargs)

    payload = payloads[0]
    assert payload["redirect_uri"] == _REDIRECT_URI
    assert "android_package_name" not in payload
    assert result["redirect_uri"] == _REDIRECT_URI
    assert result["resume_session_id"] == "resume-123"
    assert len(sessions) == 1


@pytest.mark.asyncio
async def test_link_token_android_sends_package_name_without_redirect_uri(monkeypatch):
    service = _configured_service(redirect_uri=_REDIRECT_URI)
    payloads, sessions = _record_link_token_calls(monkeypatch, service)

    result = await service.create_link_token(
        user_id="user-123",
        redirect_uri=_REDIRECT_URI,
        platform="android",
    )

    payload = payloads[0]
    assert payload["android_package_name"] == "com.hussh.app"
    assert "redirect_uri" not in payload
    assert result["link_token"] == "link-test"
    assert result["redirect_uri"] is None
    # The native SDK owns the OAuth return, so no web resume session is minted.
    assert result["resume_session_id"] is None
    assert sessions == []


@pytest.mark.asyncio
async def test_create_link_token_uses_minimal_primary_products(monkeypatch):
    service = _configured_service()
    captured_payloads: list[dict[str, Any]] = []
    monkeypatch.setenv("PLAID_PRIMARY_PRODUCTS", "investments,transactions,not_real")
    monkeypatch.setenv("PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS", "liabilities,investments")
    monkeypatch.setenv("PLAID_ADDITIONAL_CONSENTED_PRODUCTS", "identity,transactions")

    async def _fake_post(
        path: str,
        payload: dict[str, Any],
        *,
        environment: str | None = None,
    ) -> dict[str, Any]:
        assert path == "/link/token/create"
        assert environment is None
        captured_payloads.append(payload)
        return {"link_token": "link-sandbox", "expiration": "2026-07-20T00:00:00Z"}

    monkeypatch.setattr(service, "_post", _fake_post)

    result = await service.create_link_token(user_id="user-123")

    assert result["link_token"] == "link-sandbox"
    assert captured_payloads
    payload = captured_payloads[0]
    assert payload["products"] == ["transactions"]
    assert payload["required_if_supported_products"] == ["liabilities", "investments"]
    assert payload["additional_consented_products"] == ["identity"]
    assert "account_filters" not in payload
    assert "access_token" not in payload
    assert "secret" not in payload


@pytest.mark.asyncio
async def test_update_mode_link_token_keeps_access_token_server_side(monkeypatch):
    service = _configured_service()
    payloads: list[dict[str, Any]] = []

    def _fake_fetch_item_row(*, user_id: str, item_id: str) -> dict[str, Any]:
        assert user_id == "user-123"
        assert item_id == "item-123"
        return {"item_id": item_id, "user_id": user_id, "plaid_env": "production"}

    async def _fake_post(
        path: str,
        payload: dict[str, Any],
        *,
        environment: str | None = None,
    ) -> dict[str, Any]:
        assert path == "/link/token/create"
        assert environment == "production"
        payloads.append(payload)
        return {"link_token": "link-update", "expiration": "2026-07-20T00:00:00Z"}

    monkeypatch.setattr(service, "_fetch_item_row", _fake_fetch_item_row)
    monkeypatch.setattr(service, "_decrypt_access_token", lambda _row: "access-token")
    monkeypatch.setattr(service, "_post", _fake_post)

    result = await service.create_link_token(user_id="user-123", item_id="item-123")

    assert result["mode"] == "update"
    assert result["link_token"] == "link-update"
    payload = payloads[0]
    assert payload["access_token"] == "access-token"
    assert payload["update"] == {"account_selection_enabled": True}
    assert "products" not in payload
    assert "required_if_supported_products" not in payload
    assert "additional_consented_products" not in payload


@pytest.mark.asyncio
async def test_sync_item_snapshot_falls_back_when_investments_unsupported(monkeypatch):
    service = _configured_service()
    service._db = _RecordingDb()
    calls: list[str] = []

    async def _fake_post(
        path: str,
        payload: dict[str, Any],
        *,
        environment: str | None = None,
    ) -> dict[str, Any]:
        calls.append(path)
        assert payload == {"access_token": "unit-test-access-token"}
        assert environment is None
        if path == "/investments/holdings/get":
            raise PlaidApiError(
                message="Product not supported",
                status_code=400,
                error_code="PRODUCT_NOT_SUPPORTED",
                error_type="INVALID_REQUEST",
            )
        if path == "/accounts/get":
            return {
                "accounts": [
                    {
                        "account_id": "account-123",
                        "name": "Brokerage",
                        "mask": "0000",
                        "type": "investment",
                        "subtype": "brokerage",
                        "balances": {"current": 125.5, "iso_currency_code": "USD"},
                    }
                ]
            }
        raise AssertionError(f"unexpected Plaid path {path}")

    monkeypatch.setattr(service, "_post", _fake_post)
    monkeypatch.setattr(
        service,
        "_encrypt_access_token",
        lambda _token: {
            "ciphertext": "cipher",
            "iv": "iv",
            "tag": "tag",
            "algorithm": "aes-256-gcm",
        },
    )

    result = await service._sync_item_snapshot(
        user_id="user-123",
        item_id="item-123",
        access_token="unit-test-access-token",  # noqa: S106 - non-secret test fixture
        institution_id="ins_123",
        institution_name="Example Brokerage",
    )

    assert calls == ["/investments/holdings/get", "/accounts/get"]
    assert result["summary"]["account_count"] == 1
    assert result["summary"]["holdings_count"] == 0
    assert result["transactions"] == []

    db_call = service._db.calls[-1]
    params = db_call[1] or {}
    assert params["last_error_code"] == "PRODUCT_NOT_SUPPORTED"
    assert "Product not supported" in params["last_error_message"]
    metadata = json.loads(params["latest_metadata_json"])
    assert metadata["investment_sync_unavailable"] is True
    assert metadata["investment_error_code"] == "PRODUCT_NOT_SUPPORTED"
