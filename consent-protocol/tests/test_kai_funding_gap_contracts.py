from __future__ import annotations

import json
from typing import Any

import pytest

from hushh_mcp.integrations.alpaca import AlpacaApiError, AlpacaBrokerRuntimeConfig
from hushh_mcp.integrations.plaid import PlaidRuntimeConfig
from hushh_mcp.services.broker_funding_service import (
    BrokerFundingService,
    FundingOrchestrationError,
)

_ALPACA_ACCOUNT_ID = "bd47787e-bc27-4b8b-9653-48f14e23550a"


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


def _alpaca_runtime_config() -> AlpacaBrokerRuntimeConfig:
    return AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="https://broker-api.sandbox.alpaca.markets",
        auth_header="Basic test",
        default_account_id=None,
    )


def _funding_service() -> BrokerFundingService:
    service = BrokerFundingService()
    service._plaid_runtime_config = _plaid_runtime_config()
    service._alpaca_runtime_config = _alpaca_runtime_config()
    return service


def _status_snapshot(*, blocking_reason: str) -> dict[str, Any]:
    return {
        "flow_type": "funding",
        "user_id": "user_123",
        "items": [],
        "brokerage_accounts": [],
        "latest_transfers": [],
        "latest_trade_intents": [],
        "aggregate": {
            "item_count": 0,
            "account_count": 0,
            "institution_names": [],
            "relationship_count": 0,
        },
        "readiness": {
            "plaid_item_linked": True,
            "eligible_funding_account_selected": True,
            "auth_snapshot_ready": True,
            "alpaca_account_linked": False,
            "processor_handoff_ready": False,
            "ach_relationship_ready": False,
            "blocking_reason": blocking_reason,
        },
    }


async def _fake_plaid_public_token_exchange(path: str, payload: dict[str, Any]) -> dict[str, Any]:
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


def _trade_intent_row_from_kwargs(**kwargs: Any) -> dict[str, Any]:
    return {
        "intent_id": kwargs["intent_id"],
        "user_id": kwargs["user_id"],
        "transfer_id": kwargs.get("transfer_id"),
        "alpaca_account_id": kwargs.get("alpaca_account_id"),
        "funding_item_id": kwargs.get("funding_item_id"),
        "funding_account_id": kwargs.get("funding_account_id"),
        "symbol": kwargs.get("symbol"),
        "side": kwargs.get("side"),
        "order_type": kwargs.get("order_type"),
        "time_in_force": kwargs.get("time_in_force"),
        "notional_usd": kwargs.get("notional_usd"),
        "quantity": kwargs.get("quantity"),
        "limit_price": kwargs.get("limit_price"),
        "status": kwargs.get("status"),
        "order_id": kwargs.get("order_id"),
        "idempotency_key": kwargs.get("idempotency_key"),
        "failure_code": kwargs.get("failure_code"),
        "failure_message": kwargs.get("failure_message"),
        "requested_at": kwargs.get("requested_at") or "2026-04-24T00:00:00Z",
        "executed_at": kwargs.get("executed_at"),
        "request_payload_json": json.dumps(kwargs.get("request_payload") or {}),
        "transfer_snapshot_json": json.dumps(kwargs.get("transfer_snapshot") or {}),
        "order_payload_json": json.dumps(kwargs.get("order_payload") or {}),
    }


def _seed_trade_intent_row(*, status: str = "funding_pending") -> dict[str, Any]:
    return _trade_intent_row_from_kwargs(
        intent_id="intent_123",
        user_id="user_123",
        transfer_id="transfer_123",
        alpaca_account_id=_ALPACA_ACCOUNT_ID,
        funding_item_id="item_123",
        funding_account_id="acc_123",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        notional_usd="100.00",
        quantity=None,
        limit_price=None,
        status=status,
        order_id=None,
        idempotency_key="funded_trade_123",
        request_payload={
            "symbol": "AAPL",
            "side": "buy",
            "order_type": "market",
            "time_in_force": "day",
            "notional_usd": "100.00",
            "alpaca_account_id": _ALPACA_ACCOUNT_ID,
        },
        transfer_snapshot={},
        order_payload={},
    )


def _remember_trade_intent_rows(
    service: BrokerFundingService,
    monkeypatch: pytest.MonkeyPatch,
    *,
    initial_status: str = "funding_pending",
) -> dict[str, Any]:
    current_row = _seed_trade_intent_row(status=initial_status)

    def _store_trade_intent(**kwargs: Any) -> None:
        current_row.clear()
        current_row.update(_trade_intent_row_from_kwargs(**kwargs))

    monkeypatch.setattr(service, "_store_trade_intent", _store_trade_intent)
    monkeypatch.setattr(
        service,
        "_fetch_trade_intent",
        lambda *, user_id, intent_id: current_row.copy(),
    )
    monkeypatch.setattr(service, "_record_trade_event", lambda **_: None)
    return current_row


def test_resolve_secret_encryption_key_allows_local_dev_fallback_without_explicit_key(monkeypatch):
    monkeypatch.delenv("FUNDING_SECRET_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("PLAID_TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "development")

    service = _funding_service()

    derived = service._resolve_secret_encryption_key()

    assert isinstance(derived, bytes)
    assert len(derived) == 32


def test_resolve_secret_encryption_key_requires_explicit_key_in_hosted_env(monkeypatch):
    monkeypatch.delenv("FUNDING_SECRET_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("PLAID_TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("K_SERVICE", "consent-protocol")

    service = _funding_service()

    with pytest.raises(
        Exception,
        match="FUNDING_SECRET_ENCRYPTION_KEY|PLAID_TOKEN_ENCRYPTION_KEY|funding secret",
    ):
        service._resolve_secret_encryption_key()


@pytest.mark.asyncio
async def test_exchange_funding_public_token_refuses_unvalidated_uuid_alpaca_account(monkeypatch):
    service = _funding_service()
    status_snapshot = _status_snapshot(blocking_reason="ALPACA_ACCOUNT_NOT_FOUND")

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_public_token_exchange)
    monkeypatch.setattr(service, "_store_funding_item", lambda **_: None)
    monkeypatch.setattr(service, "_replace_funding_accounts", lambda **_: None)
    monkeypatch.setattr(service, "_update_funding_item_metadata", lambda **_: None)
    monkeypatch.setattr(
        service,
        "_record_consent",
        lambda **_: {
            "consent_id": "consent_123",
            "terms_version": "v1",
            "consented_at": "2026-04-24T00:00:00Z",
        },
    )

    async def _fake_sync_transactions(**kwargs: Any):
        del kwargs
        return {"cursor": "cursor_123", "has_more": False}

    monkeypatch.setattr(service, "sync_funding_transactions", _fake_sync_transactions)
    monkeypatch.setattr(service, "_find_brokerage_account", lambda **_: None)
    monkeypatch.setattr(service, "_fetch_default_brokerage_account", lambda **_: None)
    monkeypatch.setattr(service, "_fetch_latest_relationship_alpaca_account", lambda **_: None)

    async def _fake_alpaca_get(path: str, params: dict[str, Any] | None = None):
        del params
        assert path.endswith(_ALPACA_ACCOUNT_ID)
        raise AlpacaApiError(
            message="account not found",
            status_code=404,
            error_code="ALPACA_ACCOUNT_NOT_FOUND",
            payload={"alpaca_account_id": _ALPACA_ACCOUNT_ID},
        )

    monkeypatch.setattr(service, "_alpaca_get", _fake_alpaca_get)
    monkeypatch.setattr(
        service,
        "_upsert_brokerage_account",
        lambda **_: pytest.fail("exchange should not persist an unmapped Alpaca account"),
    )

    async def _unexpected_relationship(**kwargs: Any):
        del kwargs
        pytest.fail("exchange should not create an ACH relationship for an unmapped Alpaca account")

    monkeypatch.setattr(service, "_create_or_refresh_relationship", _unexpected_relationship)

    async def _fake_status(*, user_id: str):
        assert user_id == "user_123"
        return status_snapshot

    monkeypatch.setattr(service, "get_funding_status", _fake_status)

    try:
        payload = await service.exchange_funding_public_token(
            user_id="user_123",
            public_token="public_123",  # noqa: S106 - test fixture value only
            metadata={"alpaca_account_id": _ALPACA_ACCOUNT_ID},
        )
    except FundingOrchestrationError as exc:
        assert exc.code in {"ALPACA_ACCOUNT_NOT_FOUND", "ALPACA_ACCOUNT_NOT_MAPPED"}
    else:
        pending_reason = payload["ach_relationship_pending_reason"]
        assert pending_reason["code"] in {"ALPACA_ACCOUNT_NOT_FOUND", "ALPACA_ACCOUNT_NOT_MAPPED"}
        assert payload["readiness"]["blocking_reason"] in {
            "ALPACA_ACCOUNT_NOT_FOUND",
            "ALPACA_ACCOUNT_NOT_MAPPED",
        }


@pytest.mark.asyncio
async def test_process_trade_intent_waits_for_raw_settled_transfer_before_submitting_order(
    monkeypatch,
):
    service = _funding_service()
    current_row = _remember_trade_intent_rows(
        service,
        monkeypatch,
        initial_status="ready_to_trade",
    )

    async def _unexpected_submit_order_to_alpaca(**kwargs: Any):
        del kwargs
        pytest.fail("buy orders must not submit while the transfer is only completed")

    monkeypatch.setattr(service, "_submit_order_to_alpaca", _unexpected_submit_order_to_alpaca)

    refreshed = await service._process_trade_intent(
        row=current_row.copy(),
        transfer_row={
            "transfer_id": "transfer_123",
            "status": "COMPLETED",
            "user_facing_status": "completed",
            "updated_at": "2026-04-24T00:00:00Z",
        },
        event_source="kai_poll",
    )

    assert refreshed["status"] == "funding_pending"
    assert json.loads(refreshed["transfer_snapshot_json"])["status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_process_trade_intent_submits_order_after_raw_settled_transfer(monkeypatch):
    service = _funding_service()
    current_row = _remember_trade_intent_rows(service, monkeypatch)
    submitted: dict[str, Any] = {}

    async def _fake_submit_order_to_alpaca(*, alpaca_account_id: str, payload: dict[str, Any]):
        submitted["alpaca_account_id"] = alpaca_account_id
        submitted["payload"] = payload
        return {
            "id": "order_123",
            "status": "new",
            "symbol": "AAPL",
            "side": "buy",
            "type": "market",
            "time_in_force": "day",
            "notional": "100.00",
        }

    monkeypatch.setattr(service, "_submit_order_to_alpaca", _fake_submit_order_to_alpaca)

    refreshed = await service._process_trade_intent(
        row=current_row.copy(),
        transfer_row={
            "transfer_id": "transfer_123",
            "status": "SETTLED",
            "user_facing_status": "completed",
            "updated_at": "2026-04-24T00:00:00Z",
        },
        event_source="kai_poll",
    )

    assert submitted["alpaca_account_id"] == _ALPACA_ACCOUNT_ID
    assert submitted["payload"]["client_order_id"] == "kai_intent_123"
    assert refreshed["status"] == "order_submitted"
    assert refreshed["order_id"] == "order_123"
