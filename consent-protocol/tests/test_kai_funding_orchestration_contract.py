import base64
import hashlib
import time
from datetime import datetime, timedelta, timezone

import api.routes.kai.plaid as plaid_route_module
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from api.routes.kai.plaid import (
    PlaidFundedTradeCreateRequest,
    PlaidFundingBrokerageAccountRequest,
    PlaidOAuthResumeRequest,
    _to_http_exception,
)
from hushh_mcp.integrations.alpaca import AlpacaApiError, AlpacaBrokerRuntimeConfig
from hushh_mcp.integrations.plaid import PlaidRuntimeConfig
from hushh_mcp.services.broker_funding_service import (
    BrokerFundingService,
    FundingOrchestrationError,
    PlaidWebhookVerificationError,
    _decimal_to_currency_text,
    _direction_to_alpaca,
    _looks_like_alpaca_account_id,
    _normalize_symbol,
    _user_facing_transfer_status,
)


def _b64url(number: int) -> str:
    byte_length = max(1, (number.bit_length() + 7) // 8)
    return base64.urlsafe_b64encode(number.to_bytes(byte_length, byteorder="big")).decode(
        "utf-8"
    ).rstrip("=")


def _build_signed_plaid_webhook(
    *,
    raw_body: bytes,
    issued_at: int | None = None,
    request_body_sha256: str | None = None,
    key_id: str = "plaid_ec_test_key",
):
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()
    digest_hex = hashlib.sha256(raw_body).hexdigest()
    token = jwt.encode(
        {
            "iat": issued_at if issued_at is not None else int(time.time()),
            "jti": "plaid_webhook_123",
            "request_body_sha256": request_body_sha256 or digest_hex,
        },
        private_key,
        algorithm="ES256",
        headers={"kid": key_id},
    )
    return {
        "token": token,
        "key_id": key_id,
        "public_numbers": public_numbers,
    }


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


def test_normalize_symbol_allows_standard_equity_tickers():
    assert _normalize_symbol("aapl") == "AAPL"
    assert _normalize_symbol("brk.b") == "BRK.B"


def test_normalize_symbol_rejects_invalid_values():
    with pytest.raises(FundingOrchestrationError) as bad_symbol:
        _normalize_symbol("user_good")
    assert bad_symbol.value.code == "INVALID_TICKER_SYMBOL"


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


def test_funded_trade_request_defaults():
    payload = PlaidFundedTradeCreateRequest(
        user_id="user_123",
        funding_item_id="item_123",
        funding_account_id="acc_123",
        symbol="AAPL",
        user_legal_name="Test User",
        notional_usd=100.0,
    )
    assert payload.side == "buy"
    assert payload.order_type == "market"
    assert payload.time_in_force == "day"


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


def test_resolve_secret_encryption_key_requires_configured_key_in_hosted_runtime(monkeypatch):
    service = BrokerFundingService()
    monkeypatch.delenv("FUNDING_SECRET_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("PLAID_TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("HUSHH_ENV", raising=False)
    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("K_SERVICE", "consent-protocol")

    with pytest.raises(FundingOrchestrationError) as exc:
        service._resolve_secret_encryption_key()

    assert exc.value.code == "FUNDING_SECRET_ENCRYPTION_KEY_REQUIRED"
    assert exc.value.status_code == 503


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


@pytest.mark.asyncio
async def test_exchange_funding_public_token_defers_relationship_when_alpaca_unmapped(monkeypatch):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
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
    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="https://broker-api.sandbox.alpaca.markets",
        auth_header="Basic test",
        default_account_id=None,
    )

    async def _fake_plaid_post(path: str, payload: dict):
        if path == "/item/public_token/exchange":
            return {"item_id": "item_123", "access_token": "access_123"}
        if path == "/accounts/get":
            return {
                "accounts": [
                    {
                        "account_id": "acc_1",
                        "type": "depository",
                        "subtype": "checking",
                        "name": "Checking",
                        "official_name": "Checking",
                        "mask": "0000",
                    }
                ]
            }
        if path == "/auth/get":
            return {
                "accounts": [
                    {
                        "account_id": "acc_1",
                        "verification_status": "automatically_verified",
                    }
                ],
                "numbers": {
                    "ach": [
                        {
                            "account_id": "acc_1",
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
    monkeypatch.setattr(
        service,
        "_record_consent",
        lambda **_: {
            "consent_id": "consent_123",
            "terms_version": "v1",
            "consented_at": "2026-04-07T00:00:00Z",
        },
    )

    def _raise_unmapped(*, user_id: str, requested_account_id: str | None):
        raise FundingOrchestrationError(
            "No Alpaca brokerage account is configured for this user.",
            code="ALPACA_ACCOUNT_REQUIRED",
            status_code=422,
        )

    monkeypatch.setattr(service, "_resolve_alpaca_account_id", _raise_unmapped)

    async def _fake_status(*, user_id: str):
        return {
            "user_id": user_id,
            "items": [],
            "brokerage_accounts": [],
            "latest_transfers": [],
            "aggregate": {"item_count": 0, "account_count": 0, "institution_names": []},
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

    monkeypatch.setattr(service, "get_funding_status", _fake_status)

    payload = await service.exchange_funding_public_token(
        user_id="user_123",
        public_token="public_123",  # noqa: S106 - test fixture value only
        metadata={},
    )
    assert payload["consent_record"]["consent_id"] == "consent_123"
    assert payload["ach_relationship_pending_reason"]["code"] == "ALPACA_ACCOUNT_REQUIRED"


@pytest.mark.asyncio
async def test_exchange_funding_public_token_defers_relationship_when_alpaca_account_missing(
    monkeypatch,
):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
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
    service._alpaca_runtime_config = AlpacaBrokerRuntimeConfig(
        environment="sandbox",
        base_url="https://broker-api.sandbox.alpaca.markets",
        auth_header="Basic test",
        default_account_id=None,
    )

    async def _fake_plaid_post(path: str, payload: dict):
        if path == "/item/public_token/exchange":
            return {"item_id": "item_123", "access_token": "access_123"}
        if path == "/accounts/get":
            return {
                "accounts": [
                    {
                        "account_id": "acc_1",
                        "type": "depository",
                        "subtype": "checking",
                        "name": "Checking",
                        "official_name": "Checking",
                        "mask": "0000",
                    }
                ]
            }
        if path == "/auth/get":
            return {
                "accounts": [
                    {
                        "account_id": "acc_1",
                        "verification_status": "automatically_verified",
                    }
                ],
                "numbers": {
                    "ach": [
                        {
                            "account_id": "acc_1",
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
    monkeypatch.setattr(
        service,
        "_record_consent",
        lambda **_: {
            "consent_id": "consent_123",
            "terms_version": "v1",
            "consented_at": "2026-04-07T00:00:00Z",
        },
    )
    monkeypatch.setattr(
        service,
        "_resolve_alpaca_account_id",
        lambda **_: "bd47787e-bc27-4b8b-9653-48f14e23550a",
    )

    async def _missing_account(*, alpaca_account_id: str):
        raise FundingOrchestrationError(
            "Alpaca account not found for this partner environment.",
            code="ALPACA_ACCOUNT_NOT_FOUND",
            status_code=422,
            details={"alpaca_account_id": alpaca_account_id},
        )

    monkeypatch.setattr(service, "_assert_alpaca_account_exists", _missing_account)
    upsert_calls: list[dict[str, object]] = []
    monkeypatch.setattr(service, "_upsert_brokerage_account", lambda **kwargs: upsert_calls.append(kwargs))

    async def _fake_status(*, user_id: str):
        return {
            "user_id": user_id,
            "items": [],
            "brokerage_accounts": [],
            "latest_transfers": [],
            "aggregate": {"item_count": 0, "account_count": 0, "institution_names": []},
            "readiness": {
                "plaid_item_linked": True,
                "eligible_funding_account_selected": True,
                "auth_snapshot_ready": True,
                "alpaca_account_linked": False,
                "processor_handoff_ready": False,
                "ach_relationship_ready": False,
                "blocking_reason": "ALPACA_ACCOUNT_NOT_FOUND",
            },
        }

    monkeypatch.setattr(service, "get_funding_status", _fake_status)

    payload = await service.exchange_funding_public_token(
        user_id="user_123",
        public_token="public_123",  # noqa: S106 - test fixture value only
        metadata={},
    )

    assert payload["consent_record"]["consent_id"] == "consent_123"
    assert payload["ach_relationship_pending_reason"]["code"] == "ALPACA_ACCOUNT_NOT_FOUND"
    assert upsert_calls == []


@pytest.mark.asyncio
async def test_create_alpaca_connect_link_returns_authorization_url(monkeypatch):
    service = BrokerFundingService()
    monkeypatch.setattr(
        service,
        "_alpaca_connect_config",
        lambda: {
            "configured": True,
            "client_id": "alpaca_client",
            "client_secret": "alpaca_secret",
            "redirect_uri": "https://kai.hushh.ai/kai/alpaca/oauth/return",
            "authorize_url": "https://app.alpaca.markets/oauth/authorize",
            "token_url": "https://api.alpaca.markets/oauth/token",
            "account_url": "https://api.alpaca.markets/v2/account",
            "scopes": ["account:write", "trading"],
            "ttl_seconds": 900,
            "oauth_env": "paper",
        },
    )
    monkeypatch.setattr(
        service,
        "_create_alpaca_connect_session",
        lambda **_: {
            "session_id": "alpaca_connect_123",
            "state": "alpaca_state_123",
            "redirect_uri": "https://kai.hushh.ai/kai/alpaca/oauth/return",
            "expires_at": "2026-04-07T00:15:00Z",
        },
    )

    payload = await service.create_alpaca_connect_link(user_id="user_123")
    assert payload["configured"] is True
    assert payload["state"] == "alpaca_state_123"
    assert "https://app.alpaca.markets/oauth/authorize?" in payload["authorization_url"]
    assert "client_id=alpaca_client" in payload["authorization_url"]


def test_order_status_to_trade_intent_status_mapping():
    service = BrokerFundingService()
    assert service._order_status_to_trade_intent_status("filled") == "order_filled"
    assert (
        service._order_status_to_trade_intent_status("partially_filled") == "order_partially_filled"
    )
    assert service._order_status_to_trade_intent_status("rejected") == "failed"
    assert service._order_status_to_trade_intent_status("new") == "order_submitted"


@pytest.mark.asyncio
async def test_complete_alpaca_connect_link_marks_session_failed_on_typed_error(monkeypatch):
    service = BrokerFundingService()
    marks: list[dict[str, str]] = []
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace(
        "+00:00", "Z"
    )
    monkeypatch.setattr(
        service,
        "_get_alpaca_connect_session",
        lambda **_: {
            "session_id": "session_123",
            "status": "pending",
            "redirect_uri": "https://kai.hushh.ai/kai/alpaca/oauth/return",
            "expires_at": expires_at,
        },
    )
    monkeypatch.setattr(service, "_mark_alpaca_connect_session", lambda **kwargs: marks.append(kwargs))

    async def _raise_typed_error(**_: str):
        raise FundingOrchestrationError(
            "Alpaca account profile could not be fetched.",
            code="ALPACA_CONNECT_ACCOUNT_FETCH_FAILED",
            status_code=502,
        )

    monkeypatch.setattr(service, "_exchange_alpaca_connect_code", _raise_typed_error)

    with pytest.raises(FundingOrchestrationError) as exc:
        await service.complete_alpaca_connect_link(
            user_id="user_123",
            state="state_123",
            code="code_123",
        )

    assert exc.value.code == "ALPACA_CONNECT_ACCOUNT_FETCH_FAILED"
    assert marks == [
        {
            "session_id": "session_123",
            "status": "failed",
            "error_code": "ALPACA_CONNECT_ACCOUNT_FETCH_FAILED",
            "error_message": "Alpaca account profile could not be fetched.",
        }
    ]


@pytest.mark.asyncio
async def test_create_funding_link_token_returns_resume_session_for_oauth_redirect(monkeypatch):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
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

    async def _fake_plaid_post(path: str, payload: dict):
        assert path == "/link/token/create"
        assert payload["redirect_uri"] == "https://kai.hushh.ai/kai/plaid/oauth/return"
        return {
            "link_token": "link_funding_123",
            "expiration": "2026-04-23T12:00:00Z",
            "request_id": "req_123",
        }

    created_session: dict[str, str] = {}

    def _fake_create_session(**kwargs):
        created_session.update(kwargs)
        return {"resume_session_id": "plaid_funding_link_resume_123"}

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    monkeypatch.setattr(service, "_create_funding_link_session", _fake_create_session)

    payload = await service.create_funding_link_token(
        user_id="user_123",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return?oauth_state_id=abc",
    )

    assert payload["link_token"] == "link_funding_123"
    assert payload["resume_session_id"] == "plaid_funding_link_resume_123"
    assert created_session["mode"] == "create"
    assert created_session["redirect_uri"] == "https://kai.hushh.ai/kai/plaid/oauth/return"


@pytest.mark.asyncio
async def test_exchange_funding_public_token_requires_active_resume_session(monkeypatch):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
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

    monkeypatch.setattr(service, "_get_funding_link_session", lambda **_: None)

    with pytest.raises(FundingOrchestrationError) as exc:
        await service.exchange_funding_public_token(
            user_id="user_123",
            public_token="public_123",  # noqa: S106 - test fixture value only
            resume_session_id="resume_missing",
        )

    assert exc.value.code == "PLAID_FUNDING_OAUTH_RESUME_NOT_FOUND"


@pytest.mark.asyncio
async def test_create_transfer_sends_immediate_timing_to_alpaca(monkeypatch):
    service = BrokerFundingService()
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        service,
        "_fetch_funding_item_row",
        lambda **_: {"item_id": "item_123", "status": "active"},
    )
    monkeypatch.setattr(service, "_find_funding_account", lambda **_: {"account_id": "acc_123"})
    monkeypatch.setattr(service, "_set_default_funding_account", lambda **_: None)
    monkeypatch.setattr(
        service,
        "_resolve_alpaca_account_id",
        lambda **_: "bd47787e-bc27-4b8b-9653-48f14e23550a",
    )
    monkeypatch.setattr(service, "_upsert_brokerage_account", lambda **_: None)
    monkeypatch.setattr(service, "_get_funding_item_access_token", lambda row: "access_123")

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
        captured["path"] = path
        captured["payload"] = payload
        return {"id": "transfer_123", "status": "QUEUED", "currency": "USD"}

    monkeypatch.setattr(
        service,
        "_create_or_refresh_relationship",
        _fake_create_or_refresh_relationship,
    )
    monkeypatch.setattr(service, "_refresh_relationship_status", _fake_refresh_relationship_status)
    monkeypatch.setattr(service, "_relationship_status_requirements", lambda **_: None)
    monkeypatch.setattr(service, "_fetch_transfer_row_by_idempotency", lambda **_: None)
    monkeypatch.setattr(service, "_alpaca_post", _fake_alpaca_post)
    monkeypatch.setattr(
        service,
        "_parse_transfer_payload",
        lambda _: {
            "transfer_id": "transfer_123",
            "status": "QUEUED",
            "currency": "USD",
            "raw": {"id": "transfer_123", "status": "QUEUED", "currency": "USD"},
        },
    )
    monkeypatch.setattr(service, "_store_transfer", lambda **_: None)
    monkeypatch.setattr(service, "_record_transfer_event", lambda **_: None)
    monkeypatch.setattr(service, "_queue_transfer_status_notification_if_needed", lambda **_: None)

    payload = await service.create_transfer(
        user_id="user_123",
        funding_item_id="item_123",
        funding_account_id="acc_123",
        amount=100,
        user_legal_name="Test User",
    )

    assert payload["decision"] == "accepted"
    assert captured["path"] == "/v1/accounts/bd47787e-bc27-4b8b-9653-48f14e23550a/transfers"
    assert captured["payload"]["timing"] == "immediate"


@pytest.mark.asyncio
async def test_create_funded_trade_intent_waits_for_raw_settlement_before_release(monkeypatch):
    service = BrokerFundingService()
    stored_intent: dict[str, object] = {}

    monkeypatch.setattr(
        service,
        "_fetch_funding_item_row",
        lambda **_: {"item_id": "item_123", "status": "active"},
    )
    monkeypatch.setattr(service, "_find_funding_account", lambda **_: {"account_id": "acc_123"})
    monkeypatch.setattr(service, "_set_default_funding_account", lambda **_: None)
    monkeypatch.setattr(service, "_fetch_trade_intent_by_idempotency", lambda **_: None)
    monkeypatch.setattr(
        service,
        "_resolve_alpaca_account_id",
        lambda **_: "bd47787e-bc27-4b8b-9653-48f14e23550a",
    )
    monkeypatch.setattr(service, "_upsert_brokerage_account", lambda **_: None)

    async def _fake_create_transfer(**kwargs):
        assert kwargs["brokerage_account_id"] == "bd47787e-bc27-4b8b-9653-48f14e23550a"
        return {
            "transfer": {
                "transfer_id": "transfer_123",
                "status": "COMPLETED",
                "user_facing_status": "completed",
            },
            "relationship": {"relationship_id": "rel_123"},
        }

    monkeypatch.setattr(service, "create_transfer", _fake_create_transfer)
    monkeypatch.setattr(
        service,
        "_fetch_transfer_row",
        lambda **_: {
            "transfer_id": "transfer_123",
            "status": "COMPLETED",
            "user_facing_status": "completed",
        },
    )
    monkeypatch.setattr(service, "_store_trade_intent", lambda **kwargs: stored_intent.update(kwargs))
    monkeypatch.setattr(service, "_record_trade_event", lambda **_: None)
    monkeypatch.setattr(service, "_serialize_trade_intent", lambda row: row)
    monkeypatch.setattr(
        service,
        "_fetch_trade_intent",
        lambda **_: {
            "intent_id": stored_intent.get("intent_id"),
            "status": stored_intent.get("status"),
            "transfer_id": stored_intent.get("transfer_id"),
        },
    )

    payload = await service.create_funded_trade_intent(
        user_id="user_123",
        funding_item_id="item_123",
        funding_account_id="acc_123",
        symbol="AAPL",
        user_legal_name="Test User",
        notional_usd=100,
    )

    assert stored_intent["status"] == "funding_pending"
    assert payload["intent"]["status"] == "funding_pending"


@pytest.mark.asyncio
async def test_run_reconciliation_uses_refreshed_status_for_stale_pending(monkeypatch):
    class _FakeDb:
        def __init__(self):
            self.summary_json = None

        def execute_raw(self, sql, params=None):
            params = params or {}
            if "FROM kai_funding_transfers" in sql:
                return type(
                    "Result",
                    (),
                    {
                        "data": [
                            {
                                "transfer_id": "transfer_123",
                                "user_id": "user_123",
                                "status": "PENDING",
                                "requested_at": "2026-04-20T00:00:00Z",
                            }
                        ]
                    },
                )()
            if "summary_json = CAST(:summary_json AS JSONB)" in sql:
                self.summary_json = params["summary_json"]
            return type("Result", (), {"data": []})()

    service = BrokerFundingService()
    fake_db = _FakeDb()
    service._db = fake_db
    monkeypatch.setenv("FUNDING_STALE_PENDING_SECONDS", "3600")

    async def _fake_get_transfer(**_: str):
        return {
            "reference": {"status": "SETTLED"},
        }

    monkeypatch.setattr(service, "get_transfer", _fake_get_transfer)

    payload = await service.run_reconciliation(user_id="user_123", max_rows=10)

    assert payload["summary"]["refreshed"] == 1
    assert payload["summary"]["status_changes"] == 1
    assert payload["summary"]["stale_pending"] == 0
    assert fake_db.summary_json is not None


@pytest.mark.asyncio
async def test_verify_plaid_webhook_accepts_es256_ec_jwk(monkeypatch):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
        environment="sandbox",
        base_url="https://sandbox.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hushh Kai",
        webhook_url="https://kai.hushh.ai/api/kai/plaid/webhook",
        frontend_url="https://kai.hushh.ai",
        redirect_path="/kai/plaid/oauth/return",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return",
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )

    raw_body = b'{"webhook_type":"ITEM","webhook_code":"PENDING_DISCONNECT","item_id":"item_123"}'
    signed = _build_signed_plaid_webhook(raw_body=raw_body)

    async def _fake_plaid_post(path: str, payload: dict):
        assert path == "/webhook_verification_key/get"
        assert payload == {"key_id": "plaid_ec_test_key"}
        return {
            "key": {
                "kty": "EC",
                "crv": "P-256",
                "x": _b64url(signed["public_numbers"].x),
                "y": _b64url(signed["public_numbers"].y),
            }
        }

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)

    verified, event_uid, key_id = await service._verify_plaid_webhook(
        raw_body=raw_body,
        headers={"Plaid-Verification": signed["token"]},
    )

    assert verified is True
    assert event_uid == "plaid_webhook_123"
    assert key_id == "plaid_ec_test_key"


@pytest.mark.asyncio
async def test_verify_plaid_webhook_rejects_missing_verification_header():
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
        environment="production",
        base_url="https://production.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hushh Kai",
        webhook_url="https://kai.hushh.ai/api/kai/plaid/webhook",
        frontend_url="https://kai.hushh.ai",
        redirect_path="/kai/plaid/oauth/return",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return",
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )

    with pytest.raises(PlaidWebhookVerificationError, match="Missing Plaid-Verification"):
        await service._verify_plaid_webhook(raw_body=b"{}", headers={})


@pytest.mark.asyncio
async def test_verify_plaid_webhook_rejects_body_hash_mismatch(monkeypatch):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
        environment="production",
        base_url="https://production.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hushh Kai",
        webhook_url="https://kai.hushh.ai/api/kai/plaid/webhook",
        frontend_url="https://kai.hushh.ai",
        redirect_path="/kai/plaid/oauth/return",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return",
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )
    raw_body = b'{"webhook_type":"ITEM","webhook_code":"PENDING_DISCONNECT","item_id":"item_123"}'
    signed = _build_signed_plaid_webhook(
        raw_body=raw_body,
        request_body_sha256="deadbeef",
    )

    async def _fake_plaid_post(path: str, payload: dict):
        assert path == "/webhook_verification_key/get"
        assert payload == {"key_id": signed["key_id"]}
        return {
            "key": {
                "kty": "EC",
                "crv": "P-256",
                "x": _b64url(signed["public_numbers"].x),
                "y": _b64url(signed["public_numbers"].y),
            }
        }

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)

    with pytest.raises(PlaidWebhookVerificationError, match="request body hash mismatch"):
        await service._verify_plaid_webhook(
            raw_body=raw_body,
            headers={"Plaid-Verification": signed["token"]},
        )


@pytest.mark.asyncio
async def test_verify_plaid_webhook_rejects_stale_timestamp(monkeypatch):
    service = BrokerFundingService()
    service._plaid_runtime_config = PlaidRuntimeConfig(
        environment="production",
        base_url="https://production.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hushh Kai",
        webhook_url="https://kai.hushh.ai/api/kai/plaid/webhook",
        frontend_url="https://kai.hushh.ai",
        redirect_path="/kai/plaid/oauth/return",
        redirect_uri="https://kai.hushh.ai/kai/plaid/oauth/return",
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )
    raw_body = b'{"webhook_type":"ITEM","webhook_code":"PENDING_DISCONNECT","item_id":"item_123"}'
    signed = _build_signed_plaid_webhook(
        raw_body=raw_body,
        issued_at=int(time.time()) - 3600,
    )

    async def _fake_plaid_post(path: str, payload: dict):
        assert path == "/webhook_verification_key/get"
        assert payload == {"key_id": signed["key_id"]}
        return {
            "key": {
                "kty": "EC",
                "crv": "P-256",
                "x": _b64url(signed["public_numbers"].x),
                "y": _b64url(signed["public_numbers"].y),
            }
        }

    monkeypatch.setattr(service, "_plaid_post", _fake_plaid_post)
    monkeypatch.setenv("PLAID_WEBHOOK_MAX_SKEW_SECONDS", "300")

    with pytest.raises(PlaidWebhookVerificationError, match="outside allowed skew"):
        await service._verify_plaid_webhook(
            raw_body=raw_body,
            headers={"Plaid-Verification": signed["token"]},
        )


@pytest.mark.asyncio
async def test_resume_route_falls_back_to_funding_oauth_service(monkeypatch):
    class _PortfolioService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            assert user_id == "user_123"
            assert resume_session_id == "resume_123"
            return None

    class _FundingService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            assert user_id == "user_123"
            assert resume_session_id == "resume_123"
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
    monkeypatch.setattr(plaid_route_module, "get_broker_funding_service", lambda: _FundingService())

    payload = await plaid_route_module.resume_plaid_oauth(
        PlaidOAuthResumeRequest(user_id="user_123", resume_session_id="resume_123"),
        token_data={"user_id": "user_123"},
    )

    assert payload["flow_type"] == "funding"
    assert payload["link_token"] == "link_funding_123"
