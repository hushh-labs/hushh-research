"""CWE-400 bounds tests for Kai Plaid routes (15 models, comprehensive)."""

import pytest
from pydantic import ValidationError

from api.routes.kai.plaid import (
    AlpacaConnectCompleteRequest,
    AlpacaConnectStartRequest,
    PlaidFundedTradeCreateRequest,
    PlaidFundedTradeRefreshRequest,
    PlaidFundingBrokerageAccountRequest,
    PlaidFundingDefaultAccountRequest,
    PlaidFundingEscalationRequest,
    PlaidFundingReconciliationRequest,
    PlaidFundingTransactionsSyncRequest,
    PlaidItemRemoveRequest,
    PlaidLinkTokenRequest,
    PlaidOAuthResumeRequest,
    PlaidPublicTokenExchangeRequest,
    PlaidRefreshCancelRequest,
    PlaidRefreshRequest,
    PlaidSourcePreferenceRequest,
    PlaidTransferCreateRequest,
)


class TestPlaidLinkTokenRequest:
    def test_valid(self):
        req = PlaidLinkTokenRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="A" * 257)

    def test_item_id_bounds(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="user-123", item_id="A" * 513)

    def test_redirect_uri_bounds(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="user-123", redirect_uri="A" * 2049)


class TestPlaidPublicTokenExchangeRequest:
    def test_valid(self):
        req = PlaidPublicTokenExchangeRequest(user_id="user-123", public_token="t" * 8)
        assert req.user_id == "user-123"

    def test_public_token_bounds(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(user_id="user-123", public_token="A" * 1025)

    def test_resume_session_id_bounds(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(
                user_id="user-123", public_token="t" * 8, resume_session_id="A" * 257
            )


class TestPlaidOAuthResumeRequest:
    def test_valid(self):
        req = PlaidOAuthResumeRequest(user_id="user-123", resume_session_id="session123")
        assert req.user_id == "user-123"

    def test_resume_session_id_bounds(self):
        with pytest.raises(ValidationError):
            PlaidOAuthResumeRequest(user_id="user-123", resume_session_id="A" * 257)


class TestPlaidRefreshRequest:
    def test_valid(self):
        req = PlaidRefreshRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_item_id_bounds(self):
        with pytest.raises(ValidationError):
            PlaidRefreshRequest(user_id="user-123", item_id="A" * 513)


class TestPlaidItemRemoveRequest:
    def test_valid(self):
        req = PlaidItemRemoveRequest(user_id="user-123")
        assert req.user_id == "user-123"


class TestPlaidSourcePreferenceRequest:
    def test_valid(self):
        req = PlaidSourcePreferenceRequest(user_id="user-123", active_source="plaid")
        assert req.active_source == "plaid"


class TestPlaidRefreshCancelRequest:
    def test_valid(self):
        req = PlaidRefreshCancelRequest(user_id="user-123")
        assert req.user_id == "user-123"


class TestPlaidFundingTransactionsSyncRequest:
    def test_valid(self):
        req = PlaidFundingTransactionsSyncRequest(user_id="user-123", item_id="item123")
        assert req.item_id == "item123"

    def test_cursor_bounds(self):
        with pytest.raises(ValidationError):
            PlaidFundingTransactionsSyncRequest(
                user_id="user-123", item_id="item123", cursor="A" * 2049
            )


class TestPlaidFundingDefaultAccountRequest:
    def test_valid(self):
        req = PlaidFundingDefaultAccountRequest(
            user_id="user-123", item_id="item123", account_id="acc123"
        )
        assert req.account_id == "acc123"


class TestPlaidFundingBrokerageAccountRequest:
    def test_valid(self):
        req = PlaidFundingBrokerageAccountRequest(user_id="user-123")
        assert req.set_default is True

    def test_alpaca_account_id_bounds(self):
        with pytest.raises(ValidationError):
            PlaidFundingBrokerageAccountRequest(
                user_id="user-123", alpaca_account_id="A" * 257
            )


class TestPlaidTransferCreateRequest:
    def test_valid(self):
        req = PlaidTransferCreateRequest(
            user_id="user-123",
            funding_item_id="item123",
            funding_account_id="acc123",
            amount=1000.0,
            user_legal_name="John Doe",
        )
        assert req.amount == 1000.0

    def test_amount_bounds(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(
                user_id="user-123",
                funding_item_id="item123",
                funding_account_id="acc123",
                amount=2000000000.0,
                user_legal_name="John Doe",
            )

    def test_description_bounds(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(
                user_id="user-123",
                funding_item_id="item123",
                funding_account_id="acc123",
                amount=1000.0,
                user_legal_name="John Doe",
                description="A" * 513,
            )


class TestPlaidFundingReconciliationRequest:
    def test_valid(self):
        req = PlaidFundingReconciliationRequest(user_id="user-123")
        assert req.max_rows == 200


class TestPlaidFundingEscalationRequest:
    def test_valid(self):
        req = PlaidFundingEscalationRequest(user_id="user-123", notes="Issue")
        assert req.severity == "normal"

    def test_notes_bounds(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(user_id="user-123", notes="A" * 2049)


class TestAlpacaConnectStartRequest:
    def test_valid(self):
        req = AlpacaConnectStartRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_redirect_uri_bounds(self):
        with pytest.raises(ValidationError):
            AlpacaConnectStartRequest(user_id="user-123", redirect_uri="A" * 2049)


class TestAlpacaConnectCompleteRequest:
    def test_valid(self):
        req = AlpacaConnectCompleteRequest(user_id="user-123", state="state123", code="code123")
        assert req.code == "code123"

    def test_code_bounds(self):
        with pytest.raises(ValidationError):
            AlpacaConnectCompleteRequest(
                user_id="user-123", state="state123", code="A" * 2049
            )


class TestPlaidFundedTradeCreateRequest:
    def test_valid(self):
        req = PlaidFundedTradeCreateRequest(
            user_id="user-123",
            funding_item_id="item123",
            funding_account_id="acc123",
            symbol="AAPL",
            user_legal_name="John Doe",
            notional_usd=10000.0,
        )
        assert req.symbol == "AAPL"

    def test_symbol_bounds(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(
                user_id="user-123",
                funding_item_id="item123",
                funding_account_id="acc123",
                symbol="A" * 21,
                user_legal_name="John Doe",
                notional_usd=10000.0,
            )

    def test_notional_bounds(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(
                user_id="user-123",
                funding_item_id="item123",
                funding_account_id="acc123",
                symbol="AAPL",
                user_legal_name="John Doe",
                notional_usd=2000000000.0,
            )


class TestPlaidFundedTradeRefreshRequest:
    def test_valid(self):
        req = PlaidFundedTradeRefreshRequest(user_id="user-123")
        assert req.user_id == "user-123"
