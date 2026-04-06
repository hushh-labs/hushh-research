import pytest

from api.routes.kai.plaid import PlaidFundingBrokerageAccountRequest, _to_http_exception
from hushh_mcp.integrations.alpaca import AlpacaApiError, AlpacaBrokerRuntimeConfig
from hushh_mcp.services.broker_funding_service import (
    BrokerFundingService,
    FundingOrchestrationError,
    _decimal_to_currency_text,
    _direction_to_alpaca,
    _looks_like_alpaca_account_id,
    _user_facing_transfer_status,
)


def test_direction_to_alpaca_maps_supported_directions():
    assert _direction_to_alpaca("to_brokerage") == "INCOMING"
    assert _direction_to_alpaca("from_brokerage") == "OUTGOING"
    assert _direction_to_alpaca("withdrawal") == "OUTGOING"
    assert _direction_to_alpaca("anything_else") == "INCOMING"


def test_decimal_to_currency_text_formats_positive_values():
    assert _decimal_to_currency_text(10) == "10.00"
    assert _decimal_to_currency_text("12.345") == "12.35"


def test_decimal_to_currency_text_rejects_invalid_values():
    with pytest.raises(FundingOrchestrationError) as bad_text:
        _decimal_to_currency_text("bad")
    assert bad_text.value.code == "INVALID_TRANSFER_AMOUNT"

    with pytest.raises(FundingOrchestrationError) as bad_zero:
        _decimal_to_currency_text(0)
    assert bad_zero.value.code == "INVALID_TRANSFER_AMOUNT"


def test_user_facing_transfer_status_mapping():
    assert _user_facing_transfer_status("completed") == "completed"
    assert _user_facing_transfer_status("settled") == "completed"
    assert _user_facing_transfer_status("failed") == "failed"
    assert _user_facing_transfer_status("returned") == "returned"
    assert _user_facing_transfer_status("canceled") == "canceled"
    assert _user_facing_transfer_status("queued") == "pending"


def test_looks_like_alpaca_account_id_uuid_shape():
    assert _looks_like_alpaca_account_id("bd47787e-bc27-4b8b-9653-48f14e23550a") is True
    assert _looks_like_alpaca_account_id("mJxpkAkVzyu693A7gjPqlGJDyGNlEVUgvJXGL") is False
    assert _looks_like_alpaca_account_id("") is False


def test_route_error_mapping_for_funding_orchestration_error():
    exc = FundingOrchestrationError(
        "ACH relationship pending",
        code="ACH_RELATIONSHIP_NOT_APPROVED",
        status_code=409,
        details={"relationship_id": "rel_123"},
    )
    http_exc = _to_http_exception(exc)
    assert http_exc.status_code == 409
    assert http_exc.detail["code"] == "ACH_RELATIONSHIP_NOT_APPROVED"
    assert http_exc.detail["details"]["relationship_id"] == "rel_123"


def test_route_error_mapping_for_alpaca_error():
    exc = AlpacaApiError(
        message="rate limited",
        status_code=429,
        error_code="RATE_LIMIT",
        payload={"foo": "bar"},
    )
    http_exc = _to_http_exception(exc)
    assert http_exc.status_code == 429
    assert http_exc.detail["code"] == "RATE_LIMIT"
    assert http_exc.detail["payload"] == {"foo": "bar"}


def test_brokerage_account_request_allows_background_resolution():
    payload = PlaidFundingBrokerageAccountRequest(user_id="user_123")
    assert payload.user_id == "user_123"
    assert payload.alpaca_account_id is None
    assert payload.set_default is True


def test_resolve_alpaca_account_id_prefers_latest_relationship_over_env_default(monkeypatch):
    service = BrokerFundingService()
    monkeypatch.setattr(
        service,
        "_fetch_default_brokerage_account",
        lambda *, user_id: None,
    )
    monkeypatch.setattr(
        service,
        "_fetch_latest_relationship_alpaca_account",
        lambda *, user_id: "bd47787e-bc27-4b8b-9653-48f14e23550a",
    )
    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="https://broker-api.sandbox.alpaca.markets",
        auth_header="Basic test",
        default_account_id="84405de0-82b4-4e76-9f9d-1e91cb015cf6",
    )

    resolved = service._resolve_alpaca_account_id(user_id="user_123", requested_account_id=None)
    assert resolved == "bd47787e-bc27-4b8b-9653-48f14e23550a"


def test_replace_funding_accounts_clears_existing_default_before_insert():
    class _FakeDb:
        def __init__(self):
            self.calls = []

        def execute_raw(self, sql, params=None):
            self.calls.append((sql, params or {}))
            return type("Result", (), {"data": []})()

    service = BrokerFundingService()
    fake_db = _FakeDb()
    service._db = fake_db

    service._replace_funding_accounts(
        user_id="user_123",
        item_id="item_123",
        accounts=[
            {
                "account_id": "acc_1",
                "name": "Checking",
                "official_name": "Checking",
                "mask": "0000",
                "type": "depository",
                "subtype": "checking",
            }
        ],
        default_account_id="acc_1",
    )

    sql_calls = [sql for sql, _ in fake_db.calls]
    assert any("DELETE FROM kai_funding_plaid_accounts" in sql for sql in sql_calls)
    assert any(
        "UPDATE kai_funding_plaid_accounts" in sql and "SET is_default = FALSE" in sql
        for sql in sql_calls
    )
    assert any("INSERT INTO kai_funding_plaid_accounts" in sql for sql in sql_calls)


def test_replace_funding_accounts_skips_default_reset_when_no_default():
    class _FakeDb:
        def __init__(self):
            self.calls = []

        def execute_raw(self, sql, params=None):
            self.calls.append((sql, params or {}))
            return type("Result", (), {"data": []})()

    service = BrokerFundingService()
    fake_db = _FakeDb()
    service._db = fake_db

    service._replace_funding_accounts(
        user_id="user_123",
        item_id="item_123",
        accounts=[],
        default_account_id=None,
    )

    sql_calls = [sql for sql, _ in fake_db.calls]
    assert any("DELETE FROM kai_funding_plaid_accounts" in sql for sql in sql_calls)
    assert not any(
        "UPDATE kai_funding_plaid_accounts" in sql and "SET is_default = FALSE" in sql
        for sql in sql_calls
    )
