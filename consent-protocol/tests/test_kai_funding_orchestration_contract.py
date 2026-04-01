import pytest

from api.routes.kai.plaid import _to_http_exception
from hushh_mcp.integrations.alpaca import AlpacaApiError
from hushh_mcp.services.broker_funding_service import (
    FundingOrchestrationError,
    _decimal_to_currency_text,
    _direction_to_alpaca,
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
