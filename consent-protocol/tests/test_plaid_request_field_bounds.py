"""Tests for input bounds on Plaid financial request models (CWE-400).

The Plaid/brokerage endpoints handle real money transfers. Before this fix most
of the request models had min_length guards but no max_length, and two string
fields that Plaid validates against specific allowed sets were accepted as plain
str:

  PlaidTransferCreateRequest.network   -- any string accepted (should be Literal)
  PlaidTransferCreateRequest.ach_class -- any string accepted (should be Literal)
  PlaidTransferCreateRequest.description -- no length cap (Plaid caps at 10 chars)
  PlaidTransferCreateRequest.user_legal_name -- no length cap (Plaid caps at 100)
  PlaidFundedTradeCreateRequest.symbol -- no length cap (ticker symbols max 10)
  All user_id fields across all models -- no max_length

Fix: Added max_length to every unbounded string field. Changed network and
ach_class to Literal types matching Plaid-documented allowed values. Capped
description at 10 (NACHA ACH descriptor limit), user_legal_name at 100 (Plaid
API limit), symbol at 10 (ticker symbol maximum), idempotency keys at 36
(UUID format).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.plaid import (
    AlpacaConnectCompleteRequest,
    PlaidFundedTradeCreateRequest,
    PlaidFundingEscalationRequest,
    PlaidFundingTransactionsSyncRequest,
    PlaidItemRemoveRequest,
    PlaidLinkTokenRequest,
    PlaidOAuthResumeRequest,
    PlaidPublicTokenExchangeRequest,
    PlaidRefreshCancelRequest,
    PlaidTransferCreateRequest,
)

# ---------------------------------------------------------------------------
# PlaidLinkTokenRequest
# ---------------------------------------------------------------------------


class TestPlaidLinkTokenRequestBounds:
    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="u" * 129)

    def test_oversized_item_id_rejected(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="uid", item_id="i" * 257)

    def test_oversized_redirect_uri_rejected(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="uid", redirect_uri="https://x.com/" + "a" * 2040)

    def test_valid_request_accepted(self):
        req = PlaidLinkTokenRequest(user_id="uid123")
        assert req.user_id == "uid123"


# ---------------------------------------------------------------------------
# PlaidTransferCreateRequest (financial transfer -- highest risk)
# ---------------------------------------------------------------------------


class TestPlaidTransferCreateRequestBounds:
    def _base(self, **kwargs) -> dict:
        base = {
            "user_id": "uid123",
            "funding_item_id": "item1",
            "funding_account_id": "acct1",
            "amount": 100.0,
            "user_legal_name": "John Smith",
        }
        base.update(kwargs)
        return base

    def test_oversized_user_legal_name_rejected(self):
        """Plaid API rejects user_legal_name over 100 characters."""
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._base(user_legal_name="A" * 101))

    def test_oversized_description_rejected(self):
        """ACH statement descriptor is capped at 10 characters (NACHA standard)."""
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._base(description="D" * 11))

    def test_invalid_network_rejected(self):
        """network must be one of ach, same-day-ach, rtp."""
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._base(network="wire"))

    def test_invalid_ach_class_rejected(self):
        """ach_class must be one of ccd, ppd, tel, web."""
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._base(ach_class="cor"))

    def test_oversized_idempotency_key_rejected(self):
        """Idempotency keys are UUID-shaped; cap at 36 characters."""
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._base(idempotency_key="k" * 37))

    def test_valid_defaults_accepted(self):
        req = PlaidTransferCreateRequest(**self._base())
        assert req.network == "ach"
        assert req.ach_class == "web"

    def test_valid_same_day_ach_accepted(self):
        req = PlaidTransferCreateRequest(**self._base(network="same-day-ach"))
        assert req.network == "same-day-ach"

    def test_zero_amount_rejected(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._base(amount=0.0))


# ---------------------------------------------------------------------------
# PlaidFundedTradeCreateRequest (financial trade -- highest risk)
# ---------------------------------------------------------------------------


class TestPlaidFundedTradeCreateRequestBounds:
    def _base(self, **kwargs) -> dict:
        base = {
            "user_id": "uid123",
            "funding_item_id": "item1",
            "funding_account_id": "acct1",
            "symbol": "AAPL",
            "user_legal_name": "Jane Doe",
            "notional_usd": 500.0,
        }
        base.update(kwargs)
        return base

    def test_oversized_symbol_rejected(self):
        """Ticker symbols max 10 characters (e.g. BRK.B)."""
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._base(symbol="X" * 11))

    def test_oversized_user_legal_name_rejected(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._base(user_legal_name="A" * 101))

    def test_oversized_transfer_idempotency_key_rejected(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._base(transfer_idempotency_key="k" * 37))

    def test_oversized_trade_idempotency_key_rejected(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._base(trade_idempotency_key="k" * 37))

    def test_valid_request_accepted(self):
        req = PlaidFundedTradeCreateRequest(**self._base())
        assert req.symbol == "AAPL"


# ---------------------------------------------------------------------------
# PlaidFundingEscalationRequest
# ---------------------------------------------------------------------------


class TestPlaidFundingEscalationRequestBounds:
    def test_oversized_notes_rejected(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(
                user_id="uid",
                notes="n" * 2001,
            )

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(user_id="u" * 129, notes="notes text")

    def test_valid_request_accepted(self):
        req = PlaidFundingEscalationRequest(
            user_id="uid123",
            notes="Transfer stuck in pending.",
        )
        assert req.severity == "normal"


# ---------------------------------------------------------------------------
# Other models -- user_id max_length
# ---------------------------------------------------------------------------


class TestOtherPlaidModelBounds:
    def test_plaid_oauth_resume_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            PlaidOAuthResumeRequest(user_id="u" * 129, resume_session_id="sess")

    def test_plaid_item_remove_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            PlaidItemRemoveRequest(user_id="u" * 129)

    def test_plaid_refresh_cancel_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            PlaidRefreshCancelRequest(user_id="u" * 129)

    def test_alpaca_connect_complete_oversized_code_rejected(self):
        with pytest.raises(ValidationError):
            AlpacaConnectCompleteRequest(
                user_id="uid",
                state="state123",
                code="c" * 257,
            )

    def test_plaid_public_token_exchange_oversized_token_rejected(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(
                user_id="uid",
                public_token="t" * 257,
            )

    def test_plaid_funding_transactions_sync_oversized_cursor_rejected(self):
        with pytest.raises(ValidationError):
            PlaidFundingTransactionsSyncRequest(
                user_id="uid",
                item_id="item1",
                cursor="c" * 513,
            )
