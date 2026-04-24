from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import api.routes.kai.plaid as plaid_route_module
from hushh_mcp.integrations.alpaca import AlpacaBrokerRuntimeConfig
from hushh_mcp.integrations.plaid import PlaidRuntimeConfig
from hushh_mcp.services.broker_funding_service import BrokerFundingService


def _plaid_runtime_config() -> PlaidRuntimeConfig:
    return PlaidRuntimeConfig(
        environment="sandbox",
        base_url="https://sandbox.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hushh Kai",
        webhook_url=None,
        frontend_url="https://kai.hushh.ai",
        redirect_path="/kai/plaid/oauth/return",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return",
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(plaid_route_module.router)
    app.dependency_overrides[plaid_route_module.require_vault_owner_token] = lambda: {
        "user_id": "user_123"
    }
    return app


def _funding_service() -> BrokerFundingService:
    service = BrokerFundingService()
    service._plaid_runtime_config = _plaid_runtime_config()
    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="",
        auth_header="",
        default_account_id=None,
    )
    return service


@pytest.mark.asyncio
async def test_create_funding_link_token_creates_resume_session_for_oauth_redirect(monkeypatch):
    service = _funding_service()
    created_session: dict[str, str | None] = {}

    async def _fake_plaid_post(path: str, payload: dict):
        assert path == "/link/token/create"
        assert payload["redirect_uri"] == "https://kai.hushh.ai/kai/plaid/oauth/return"
        return {
            "link_token": "link_funding_123",
            "expiration": "2026-04-23T12:00:00Z",
            "request_id": "req_123",
        }

    def _fake_create_session(**kwargs):
        created_session.update(kwargs)
        return {"resume_session_id": "resume_123"}

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    monkeypatch.setattr(service, "_create_funding_link_session", _fake_create_session)

    payload = await service.create_funding_link_token(
        user_id="user_123",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return?oauth_state_id=oauth_123",
    )

    assert payload["flow_type"] == "funding"
    assert payload["resume_session_id"] == "resume_123"
    assert created_session == {
        "user_id": "user_123",
        "item_id": None,
        "mode": "create",
        "redirect_uri": "https://kai.hushh.ai/kai/plaid/oauth/return",
        "link_token": "link_funding_123",
        "expires_at": "2026-04-23T12:00:00Z",
    }


@pytest.mark.asyncio
async def test_get_oauth_resume_returns_active_funding_session(monkeypatch):
    service = _funding_service()

    monkeypatch.setattr(
        service,
        "_get_funding_link_session",
        lambda **_: {
            "mode": "create",
            "item_id": None,
            "link_token": "link_funding_123",
            "expires_at": "2026-04-23T12:00:00Z",
            "redirect_uri": "https://kai.hushh.ai/kai/plaid/oauth/return",
            "resume_session_id": "resume_123",
        },
    )

    payload = await service.get_oauth_resume(
        user_id="user_123",
        resume_session_id="resume_123",
    )

    assert payload is not None
    assert payload["flow_type"] == "funding"
    assert payload["link_token"] == "link_funding_123"
    assert payload["resume_session_id"] == "resume_123"
    assert payload["redirect_uri"] == "https://kai.hushh.ai/kai/plaid/oauth/return"


@pytest.mark.asyncio
async def test_exchange_funding_public_token_consumes_resume_session(monkeypatch):
    service = _funding_service()
    completed_session: dict[str, str] = {}

    monkeypatch.setattr(
        service,
        "_get_funding_link_session",
        lambda **_: {
            "resume_session_id": "resume_123",
            "status": "active",
        },
    )

    async def _fake_plaid_post(path: str, payload: dict):
        if path == "/item/public_token/exchange":
            assert payload == {"public_token": "public_123"}
            return {"item_id": "item_123", "access_token": "access_123"}
        if path == "/accounts/get":
            return {
                "accounts": [
                    {
                        "account_id": "acc_123",
                        "type": "depository",
                        "subtype": "checking",
                        "name": "Primary Checking",
                        "official_name": "Primary Checking",
                        "mask": "0000",
                    }
                ]
            }
        if path == "/auth/get":
            return {
                "accounts": [
                    {
                        "account_id": "acc_123",
                        "verification_status": "automatically_verified",
                    }
                ],
                "numbers": {
                    "ach": [
                        {
                            "account_id": "acc_123",
                            "account": "000123456789",
                            "routing": "110000000",
                        }
                    ]
                },
            }
        raise AssertionError(f"Unexpected Plaid path: {path}")

    async def _fake_sync_transactions(**kwargs):
        assert kwargs["user_id"] == "user_123"
        assert kwargs["item_id"] == "item_123"
        assert kwargs["cursor"] is None
        return {"cursor": "cursor_123", "has_more": False}

    async def _fake_status(*, user_id: str):
        assert user_id == "user_123"
        return {
            "flow_type": "funding",
            "items": [{"item_id": "item_123"}],
            "readiness": {
                "plaid_item_linked": True,
                "eligible_funding_account_selected": True,
                "auth_snapshot_ready": True,
                "alpaca_account_linked": False,
                "processor_handoff_ready": False,
                "ach_relationship_ready": False,
                "blocking_reason": "ALPACA_ACCOUNT_REQUIRED",
            },
        }

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    monkeypatch.setattr(service, "_store_funding_item", lambda **_: None)
    monkeypatch.setattr(service, "_replace_funding_accounts", lambda **_: None)
    monkeypatch.setattr(service, "sync_funding_transactions", _fake_sync_transactions)
    monkeypatch.setattr(
        service,
        "_record_consent",
        lambda **_: {
            "consent_id": "consent_123",
            "terms_version": "v2",
            "consented_at": "2026-04-23T00:00:00Z",
        },
    )
    monkeypatch.setattr(service, "get_funding_status", _fake_status)
    monkeypatch.setattr(
        service,
        "_complete_funding_link_session",
        lambda **kwargs: completed_session.update(kwargs),
    )

    payload = await service.exchange_funding_public_token(
        user_id="user_123",
        public_token="public_123",  # noqa: S106 - test fixture value only
        resume_session_id="resume_123",
        terms_version="v2",
        consent_timestamp="2026-04-23T00:00:00Z",
    )

    assert completed_session == {
        "user_id": "user_123",
        "resume_session_id": "resume_123",
    }
    assert payload["flow_type"] == "funding"
    assert payload["consent_record"] == {
        "consent_id": "consent_123",
        "terms_version": "v2",
        "consented_at": "2026-04-23T00:00:00Z",
    }


def test_plaid_oauth_resume_route_serves_funding_sessions(monkeypatch):
    calls: list[tuple[str, str, str]] = []

    class _PortfolioService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            calls.append(("portfolio", user_id, resume_session_id))
            return None

    class _FundingService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            calls.append(("funding", user_id, resume_session_id))
            return {
                "configured": True,
                "flow_type": "funding",
                "link_token": "link_funding_123",
                "resume_session_id": "resume_123",
            }

    monkeypatch.setattr(
        plaid_route_module,
        "get_plaid_portfolio_service",
        lambda: _PortfolioService(),
    )
    monkeypatch.setattr(
        plaid_route_module,
        "get_broker_funding_service",
        lambda: _FundingService(),
    )

    client = TestClient(_build_app())
    response = client.post(
        "/plaid/oauth/resume",
        json={"user_id": "user_123", "resume_session_id": "resume_123"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "configured": True,
        "flow_type": "funding",
        "link_token": "link_funding_123",
        "resume_session_id": "resume_123",
    }
    assert calls == [
        ("portfolio", "user_123", "resume_123"),
        ("funding", "user_123", "resume_123"),
    ]
