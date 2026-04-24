from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import api.routes.kai.plaid as plaid_routes
from hushh_mcp.services.broker_funding_service import (
    BrokerFundingService,
    FundingOrchestrationError,
)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(plaid_routes.router)
    app.dependency_overrides[plaid_routes.require_vault_owner_token] = lambda: {
        "user_id": "user_123"
    }
    app.dependency_overrides[plaid_routes.require_transfer_scope_token] = lambda: {
        "user_id": "user_123"
    }
    return app


def _prime_transfer_context(service: BrokerFundingService, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        service,
        "_fetch_funding_item_row",
        lambda **_: {"item_id": "item_123", "status": "active"},
    )
    monkeypatch.setattr(
        service,
        "_find_funding_account",
        lambda **_: {"account_id": "acc_123"},
    )
    monkeypatch.setattr(service, "_set_default_funding_account", lambda **_: None)
    monkeypatch.setattr(
        service,
        "_resolve_alpaca_account_id",
        lambda **_: "bd47787e-bc27-4b8b-9653-48f14e23550a",
    )
    monkeypatch.setattr(service, "_upsert_brokerage_account", lambda **_: None)


def test_oauth_resume_route_returns_404_when_no_active_session_exists(monkeypatch):
    class _PortfolioService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            assert user_id == "user_123"
            assert resume_session_id == "resume_missing"
            return None

    class _FundingService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            assert user_id == "user_123"
            assert resume_session_id == "resume_missing"
            return None

    monkeypatch.setattr(plaid_routes, "get_plaid_portfolio_service", lambda: _PortfolioService())
    monkeypatch.setattr(plaid_routes, "get_broker_funding_service", lambda: _FundingService())

    client = TestClient(_build_app())
    response = client.post(
        "/plaid/oauth/resume",
        json={"user_id": "user_123", "resume_session_id": "resume_missing"},
    )

    assert response.status_code == 404
    assert response.json() == {
        "detail": {
            "code": "PLAID_OAUTH_RESUME_NOT_FOUND",
            "message": "No active Plaid OAuth resume session was found.",
            "resume_session_id": "resume_missing",
        }
    }


@pytest.mark.asyncio
async def test_create_plaid_processor_token_requires_processor_token_in_response(monkeypatch):
    service = BrokerFundingService()

    async def _fake_plaid_post(path: str, payload: dict):
        assert path == "/processor/token/create"
        assert payload["processor"] == "alpaca"
        return {}

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)

    with pytest.raises(FundingOrchestrationError) as exc:
        await service._create_plaid_processor_token(
            access_token="access_123",  # noqa: S106 - test fixture value only
            plaid_account_id="acc_123",
        )

    assert exc.value.code == "PLAID_PROCESSOR_TOKEN_MISSING"
    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_create_transfer_rejects_unknown_explicit_relationship_id(monkeypatch):
    service = BrokerFundingService()
    _prime_transfer_context(service, monkeypatch)
    monkeypatch.setattr(service, "_get_funding_item_access_token", lambda row: "access_123")
    monkeypatch.setattr(service, "_find_relationship_by_id", lambda **_: None)

    with pytest.raises(FundingOrchestrationError) as exc:
        await service.create_transfer(
            user_id="user_123",
            funding_item_id="item_123",
            funding_account_id="acc_123",
            amount=100,
            user_legal_name="Test User",
            relationship_id="rel_missing",
        )

    assert exc.value.code == "ACH_RELATIONSHIP_NOT_FOUND"
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_create_transfer_persists_failed_transfer_state(monkeypatch):
    service = BrokerFundingService()
    _prime_transfer_context(service, monkeypatch)
    monkeypatch.setattr(service, "_get_funding_item_access_token", lambda row: "access_123")

    stored_transfer: dict[str, object] = {}
    recorded_event: dict[str, object] = {}
    queued_notification: dict[str, object] = {}

    async def _fake_create_or_refresh_relationship(**kwargs):
        return {
            "relationship_id": "rel_123",
            "status": "APPROVED",
            "user_id": kwargs["user_id"],
            "alpaca_account_id": kwargs["alpaca_account_id"],
            "item_id": kwargs["item_id"],
            "account_id": kwargs["account_id"],
        }

    async def _fake_refresh_relationship_status(*, relationship: dict):
        return relationship

    async def _fake_alpaca_post(path: str, payload: dict):
        assert path == "/v1/accounts/bd47787e-bc27-4b8b-9653-48f14e23550a/transfers"
        assert payload["relationship_id"] == "rel_123"
        return {"id": "transfer_failed_123"}

    monkeypatch.setattr(
        service,
        "_create_or_refresh_relationship",
        _fake_create_or_refresh_relationship,
    )
    monkeypatch.setattr(service, "_refresh_relationship_status", _fake_refresh_relationship_status)
    monkeypatch.setattr(service, "_fetch_transfer_row_by_idempotency", lambda **_: None)
    monkeypatch.setattr(service, "_alpaca_post", _fake_alpaca_post)
    monkeypatch.setattr(
        service,
        "_parse_transfer_payload",
        lambda _: {
            "transfer_id": "transfer_failed_123",
            "status": "FAILED",
            "currency": "USD",
            "failure_reason_code": "R01",
            "failure_reason_message": "Insufficient funds",
            "raw": {
                "id": "transfer_failed_123",
                "status": "FAILED",
                "failure_reason": {"code": "R01", "message": "Insufficient funds"},
            },
        },
    )
    monkeypatch.setattr(service, "_store_transfer", lambda **kwargs: stored_transfer.update(kwargs))
    monkeypatch.setattr(
        service,
        "_record_transfer_event",
        lambda **kwargs: recorded_event.update(kwargs),
    )
    monkeypatch.setattr(
        service,
        "_queue_transfer_status_notification_if_needed",
        lambda **kwargs: queued_notification.update(kwargs),
    )

    payload = await service.create_transfer(
        user_id="user_123",
        funding_item_id="item_123",
        funding_account_id="acc_123",
        amount=100,
        user_legal_name="Test User",
        idempotency_key="funding_transfer_edge_case",
    )

    assert payload["decision"] == "accepted"
    assert payload["transfer"]["status"] == "FAILED"
    assert stored_transfer["status"] == "FAILED"
    assert stored_transfer["reason_code"] == "R01"
    assert stored_transfer["reason_message"] == "Insufficient funds"
    assert recorded_event["event_status"] == "FAILED"
    assert recorded_event["reason_code"] == "R01"
    assert queued_notification["current_status"] == "FAILED"
    assert queued_notification["failure_reason"] == "Insufficient funds"


@pytest.mark.asyncio
async def test_create_funded_trade_intent_requires_limit_price_for_limit_orders():
    service = BrokerFundingService()

    with pytest.raises(FundingOrchestrationError) as exc:
        await service.create_funded_trade_intent(
            user_id="user_123",
            funding_item_id="item_123",
            funding_account_id="acc_123",
            symbol="AAPL",
            user_legal_name="Test User",
            notional_usd=100,
            order_type="limit",
        )

    assert exc.value.code == "LIMIT_PRICE_REQUIRED"
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_create_funded_trade_intent_requires_linked_funding_account(monkeypatch):
    service = BrokerFundingService()
    monkeypatch.setattr(
        service,
        "_fetch_funding_item_row",
        lambda **_: {"item_id": "item_123", "status": "active"},
    )
    monkeypatch.setattr(service, "_find_funding_account", lambda **_: None)

    with pytest.raises(FundingOrchestrationError) as exc:
        await service.create_funded_trade_intent(
            user_id="user_123",
            funding_item_id="item_123",
            funding_account_id="acc_missing",
            symbol="AAPL",
            user_legal_name="Test User",
            notional_usd=100,
        )

    assert exc.value.code == "PLAID_FUNDING_ACCOUNT_NOT_FOUND"
    assert exc.value.status_code == 422
