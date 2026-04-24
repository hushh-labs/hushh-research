from __future__ import annotations

import json
from typing import Any

import pytest

from hushh_mcp.integrations.alpaca import AlpacaBrokerRuntimeConfig
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


class _FakeResult:
    def __init__(self, data: list[dict[str, Any]]):
        self.data = data


class _FakeDb:
    def __init__(
        self,
        *,
        brokerage_accounts: list[dict[str, Any]] | None = None,
        transfers: list[dict[str, Any]] | None = None,
        trade_intents: list[dict[str, Any]] | None = None,
        relationships: list[dict[str, Any]] | None = None,
    ) -> None:
        self._brokerage_accounts = brokerage_accounts or []
        self._transfers = transfers or []
        self._trade_intents = trade_intents or []
        self._relationships = relationships or []

    def execute_raw(self, sql: str, params: dict[str, Any] | None = None) -> _FakeResult:
        del params
        if "FROM kai_funding_brokerage_accounts" in sql:
            return _FakeResult(self._brokerage_accounts)
        if "FROM kai_funding_transfers" in sql:
            return _FakeResult(self._transfers)
        if "FROM kai_funding_trade_intents" in sql:
            return _FakeResult(self._trade_intents)
        if "FROM kai_funding_ach_relationships" in sql:
            return _FakeResult(self._relationships)
        return _FakeResult([])


def _auth_summary(
    *,
    has_ach_numbers: bool,
    verification_status: str = "automatically_verified",
    is_tokenized_account_number: bool = False,
    network_status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "has_ach_numbers": has_ach_numbers,
        "verification_status": verification_status,
        "is_tokenized_account_number": is_tokenized_account_number,
        "network_status": network_status or {"ach": "supported"},
        "auth_fetched_at": "2026-04-23T00:00:00Z",
        "auth_fingerprint": "sha256:test_auth_fingerprint",
    }


def _item_row(
    *,
    selected_funding_account_id: str = "acc_123",
) -> dict[str, Any]:
    return {
        "item_id": "item_123",
        "institution_id": "ins_123",
        "institution_name": "Test Bank",
        "status": "active",
        "last_synced_at": "2026-04-23T00:00:00Z",
        "latest_metadata_json": json.dumps(
            {
                "selected_funding_account_id": selected_funding_account_id,
                "last_synced_at": "2026-04-23T00:00:00Z",
            }
        ),
    }


def _account_row(
    *,
    account_id: str = "acc_123",
    is_default: bool = True,
    auth_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    if auth_summary is not None:
        metadata = {
            **auth_summary,
            "auth_summary": auth_summary,
        }
    return {
        "account_id": account_id,
        "account_name": "Primary Checking",
        "official_name": "Primary Checking",
        "mask": "0000",
        "account_type": "depository",
        "account_subtype": "checking",
        "is_default": is_default,
        "account_metadata_json": json.dumps(metadata),
    }


def _relationship_row(
    *,
    status: str,
    reason_code: str | None = None,
    reason_message: str | None = None,
) -> dict[str, Any]:
    return {
        "relationship_id": "rel_123",
        "user_id": "user_123",
        "alpaca_account_id": _ALPACA_ACCOUNT_ID,
        "item_id": "item_123",
        "account_id": "acc_123",
        "status": status,
        "status_reason_code": reason_code,
        "status_reason_message": reason_message,
        "updated_at": "2026-04-23T00:00:00Z",
    }


def _brokerage_account_row() -> dict[str, Any]:
    return {
        "alpaca_account_id": _ALPACA_ACCOUNT_ID,
        "status": "linked",
        "is_default": True,
    }


def _build_status_service(
    *,
    auth_summary: dict[str, Any],
    brokerage_accounts: list[dict[str, Any]] | None = None,
    relationships: list[dict[str, Any]] | None = None,
) -> BrokerFundingService:
    service = _funding_service()
    service._db = _FakeDb(
        brokerage_accounts=brokerage_accounts,
        relationships=relationships,
    )
    service._list_funding_item_rows = lambda *, user_id: [_item_row()]  # type: ignore[method-assign]
    service._list_funding_accounts = (
        lambda *, user_id, item_id: [_account_row(auth_summary=auth_summary)]
    )  # type: ignore[method-assign]
    return service


def _assert_auth_summary(account_payload: dict[str, Any], expected: dict[str, Any]) -> None:
    auth_summary = account_payload["auth_summary"]
    assert auth_summary["has_ach_numbers"] is expected["has_ach_numbers"]
    assert auth_summary["verification_status"] == expected["verification_status"]
    assert (
        auth_summary["is_tokenized_account_number"] is expected["is_tokenized_account_number"]
    )
    assert auth_summary["network_status"] == expected["network_status"]
    assert auth_summary["auth_fetched_at"] == expected["auth_fetched_at"]
    assert auth_summary["auth_fingerprint"] == expected["auth_fingerprint"]


def _status_snapshot(*, blocking_reason: str | None) -> dict[str, Any]:
    auth_summary = _auth_summary(has_ach_numbers=True)
    return {
        "flow_type": "funding",
        "user_id": "user_123",
        "items": [
            {
                "item_id": "item_123",
                "institution_name": "Test Bank",
                "selected_funding_account_id": "acc_123",
                "accounts": [
                    {
                        "account_id": "acc_123",
                        "name": "Primary Checking",
                        "mask": "0000",
                        "is_default": True,
                        "is_selected_funding_account": True,
                        "auth_summary": auth_summary,
                    }
                ],
                "relationships": [],
            }
        ],
        "brokerage_accounts": [],
        "latest_transfers": [],
        "latest_trade_intents": [],
        "aggregate": {
            "item_count": 1,
            "account_count": 1,
            "institution_names": ["Test Bank"],
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


@pytest.mark.asyncio
async def test_get_funding_status_exposes_no_eligible_ach_readiness_and_auth_summary():
    auth_summary = _auth_summary(
        has_ach_numbers=False,
        verification_status="pending_manual_verification",
        network_status={"ach": "missing"},
    )
    service = _build_status_service(auth_summary=auth_summary)

    payload = await service.get_funding_status(user_id="user_123")

    readiness = payload["readiness"]
    assert readiness["plaid_item_linked"] is True
    assert readiness["eligible_funding_account_selected"] is False
    assert readiness["auth_snapshot_ready"] is True
    assert readiness["alpaca_account_linked"] is False
    assert readiness["processor_handoff_ready"] is False
    assert readiness["ach_relationship_ready"] is False
    assert readiness["blocking_reason"] == "NO_ELIGIBLE_ACH_ACCOUNT"
    _assert_auth_summary(payload["items"][0]["accounts"][0], auth_summary)


@pytest.mark.asyncio
async def test_get_funding_status_reports_missing_alpaca_account_blocker():
    auth_summary = _auth_summary(has_ach_numbers=True)
    service = _build_status_service(auth_summary=auth_summary)

    payload = await service.get_funding_status(user_id="user_123")

    readiness = payload["readiness"]
    assert readiness["plaid_item_linked"] is True
    assert readiness["eligible_funding_account_selected"] is True
    assert readiness["auth_snapshot_ready"] is True
    assert readiness["alpaca_account_linked"] is False
    assert readiness["processor_handoff_ready"] is False
    assert readiness["ach_relationship_ready"] is False
    assert readiness["blocking_reason"] == "ALPACA_ACCOUNT_REQUIRED"
    _assert_auth_summary(payload["items"][0]["accounts"][0], auth_summary)


@pytest.mark.asyncio
async def test_get_funding_status_reports_pending_relationship_blocker():
    auth_summary = _auth_summary(has_ach_numbers=True)
    service = _build_status_service(
        auth_summary=auth_summary,
        brokerage_accounts=[_brokerage_account_row()],
        relationships=[_relationship_row(status="pending")],
    )

    payload = await service.get_funding_status(user_id="user_123")

    readiness = payload["readiness"]
    assert readiness["plaid_item_linked"] is True
    assert readiness["eligible_funding_account_selected"] is True
    assert readiness["auth_snapshot_ready"] is True
    assert readiness["alpaca_account_linked"] is True
    assert readiness["processor_handoff_ready"] is True
    assert readiness["ach_relationship_ready"] is False
    assert readiness["blocking_reason"] == "ACH_RELATIONSHIP_PENDING"
    _assert_auth_summary(payload["items"][0]["accounts"][0], auth_summary)


@pytest.mark.asyncio
async def test_get_funding_status_reports_failed_relationship_blocker():
    auth_summary = _auth_summary(has_ach_numbers=True)
    service = _build_status_service(
        auth_summary=auth_summary,
        brokerage_accounts=[_brokerage_account_row()],
        relationships=[
            _relationship_row(
                status="rejected",
                reason_code="VERIFICATION_FAILED",
                reason_message="Bank ownership could not be verified.",
            )
        ],
    )

    payload = await service.get_funding_status(user_id="user_123")

    readiness = payload["readiness"]
    assert readiness["plaid_item_linked"] is True
    assert readiness["eligible_funding_account_selected"] is True
    assert readiness["auth_snapshot_ready"] is True
    assert readiness["alpaca_account_linked"] is True
    assert readiness["processor_handoff_ready"] is True
    assert readiness["ach_relationship_ready"] is False
    assert readiness["blocking_reason"] == "ACH_RELATIONSHIP_FAILED"
    _assert_auth_summary(payload["items"][0]["accounts"][0], auth_summary)


@pytest.mark.asyncio
async def test_get_funding_status_reports_ready_state_when_relationship_is_approved():
    auth_summary = _auth_summary(has_ach_numbers=True)
    service = _build_status_service(
        auth_summary=auth_summary,
        brokerage_accounts=[_brokerage_account_row()],
        relationships=[_relationship_row(status="approved")],
    )

    payload = await service.get_funding_status(user_id="user_123")

    readiness = payload["readiness"]
    assert readiness["plaid_item_linked"] is True
    assert readiness["eligible_funding_account_selected"] is True
    assert readiness["auth_snapshot_ready"] is True
    assert readiness["alpaca_account_linked"] is True
    assert readiness["processor_handoff_ready"] is True
    assert readiness["ach_relationship_ready"] is True
    assert readiness["blocking_reason"] is None
    _assert_auth_summary(payload["items"][0]["accounts"][0], auth_summary)


@pytest.mark.asyncio
async def test_exchange_funding_public_token_rejects_when_no_eligible_ach_account_exists(monkeypatch):
    service = _funding_service()

    async def _fake_plaid_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
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
                        "verification_status": "pending_manual_verification",
                    }
                ],
                "numbers": {
                    "ach": [
                        {
                            "account_id": "acc_other",
                            "account": "000123456789",
                            "routing": "110000000",
                        }
                    ]
                },
            }
        raise AssertionError(f"Unexpected Plaid path: {path}")

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    monkeypatch.setattr(service, "_store_funding_item", lambda **_: None)
    monkeypatch.setattr(service, "_replace_funding_accounts", lambda **_: None)
    monkeypatch.setattr(service, "_update_funding_item_metadata", lambda **_: None)

    async def _fake_sync_transactions(**kwargs):
        del kwargs
        return {"cursor": None, "has_more": False}

    monkeypatch.setattr(service, "sync_funding_transactions", _fake_sync_transactions)

    with pytest.raises(FundingOrchestrationError) as exc:
        await service.exchange_funding_public_token(
            user_id="user_123",
            public_token="public_123",  # noqa: S106 - test fixture value only
            metadata={},
        )

    assert exc.value.code == "NO_ELIGIBLE_ACH_ACCOUNT"
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_exchange_funding_public_token_exposes_readiness_when_alpaca_account_is_unmapped(
    monkeypatch,
):
    service = _funding_service()
    status_snapshot = _status_snapshot(blocking_reason="ALPACA_ACCOUNT_NOT_MAPPED")

    async def _fake_plaid_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
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
        return {"cursor": "cursor_123", "has_more": False}

    def _raise_unmapped(*, user_id: str, requested_account_id: str | None) -> str:
        del user_id, requested_account_id
        raise FundingOrchestrationError(
            "Requested brokerage destination is not a valid Alpaca account ID.",
            code="ALPACA_ACCOUNT_NOT_MAPPED",
            status_code=422,
        )

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    monkeypatch.setattr(service, "_store_funding_item", lambda **_: None)
    monkeypatch.setattr(service, "_replace_funding_accounts", lambda **_: None)
    monkeypatch.setattr(service, "_update_funding_item_metadata", lambda **_: None)
    monkeypatch.setattr(service, "sync_funding_transactions", _fake_sync_transactions)
    monkeypatch.setattr(
        service,
        "_record_consent",
        lambda **_: {
            "consent_id": "consent_123",
            "terms_version": "v1",
            "consented_at": "2026-04-23T00:00:00Z",
        },
    )
    monkeypatch.setattr(service, "_resolve_alpaca_account_id", _raise_unmapped)

    async def _fake_status(*, user_id: str) -> dict[str, Any]:
        assert user_id == "user_123"
        return status_snapshot

    monkeypatch.setattr(service, "get_funding_status", _fake_status)

    payload = await service.exchange_funding_public_token(
        user_id="user_123",
        public_token="public_123",  # noqa: S106 - test fixture value only
        metadata={"alpaca_account_id": "external_broker_destination"},
    )

    readiness = payload["readiness"]
    assert readiness["blocking_reason"] == "ALPACA_ACCOUNT_NOT_MAPPED"
    assert readiness["eligible_funding_account_selected"] is True
    assert readiness["auth_snapshot_ready"] is True
    assert readiness["processor_handoff_ready"] is False
    _assert_auth_summary(payload["items"][0]["accounts"][0], _auth_summary(has_ach_numbers=True))
    assert payload["ach_relationship_pending_reason"] == {
        "code": "ALPACA_ACCOUNT_NOT_MAPPED",
        "message": "Requested brokerage destination is not a valid Alpaca account ID.",
    }
    assert payload["consent_record"] == {
        "consent_id": "consent_123",
        "terms_version": "v1",
        "consented_at": "2026-04-23T00:00:00Z",
    }
