"""
Tests for input bounds on Plaid, stream-analyze, and Kai chat request models.

Covers:
- PlaidLinkTokenRequest
- PlaidPublicTokenExchangeRequest
- PlaidOAuthResumeRequest
- PlaidRefreshRequest / PlaidRefreshCancelRequest
- PlaidSourcePreferenceRequest
- PlaidFundingTransactionsSyncRequest
- PlaidFundingDefaultAccountRequest
- PlaidFundingBrokerageAccountRequest
- PlaidTransferCreateRequest
- PlaidFundingReconciliationRequest
- PlaidFundingEscalationRequest
- AlpacaConnectStartRequest / AlpacaConnectCompleteRequest
- PlaidFundedTradeCreateRequest / PlaidFundedTradeRefreshRequest
- StreamAnalyzeRequest / StartAnalyzeRunRequest
- KaiChatRequest / AnalyzeLoserRequest
"""

import pytest
from pydantic import ValidationError

from api.routes.kai.chat import AnalyzeLoserRequest, KaiChatRequest
from api.routes.kai.plaid import (
    AlpacaConnectCompleteRequest,
    AlpacaConnectStartRequest,
    PlaidFundedTradeCreateRequest,
    PlaidFundedTradeRefreshRequest,
    PlaidFundingEscalationRequest,
    PlaidFundingTransactionsSyncRequest,
    PlaidLinkTokenRequest,
    PlaidOAuthResumeRequest,
    PlaidPublicTokenExchangeRequest,
    PlaidRefreshCancelRequest,
    PlaidRefreshRequest,
    PlaidTransferCreateRequest,
)
from api.routes.kai.stream import StartAnalyzeRunRequest, StreamAnalyzeRequest

# ---------------------------------------------------------------------------
# PlaidLinkTokenRequest
# ---------------------------------------------------------------------------


class TestPlaidLinkTokenRequest:
    def test_valid_passes(self):
        r = PlaidLinkTokenRequest(user_id="u1")
        assert r.user_id == "u1"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="u" * 129)

    def test_item_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="u1", item_id="i" * 129)

    def test_redirect_uri_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidLinkTokenRequest(user_id="u1", redirect_uri="h" * 2049)


# ---------------------------------------------------------------------------
# PlaidPublicTokenExchangeRequest
# ---------------------------------------------------------------------------


_PLAID_TOKEN = "tok123"  # noqa: S105


class TestPlaidPublicTokenExchangeRequest:
    def test_valid_passes(self):
        r = PlaidPublicTokenExchangeRequest(user_id="u1", public_token=_PLAID_TOKEN)  # noqa: S106
        assert r.public_token == _PLAID_TOKEN  # noqa: S105

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(user_id="u" * 129, public_token="tok")  # noqa: S106

    def test_public_token_empty_raises(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(user_id="u1", public_token="")  # noqa: S106

    def test_public_token_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(user_id="u1", public_token="t" * 513)  # noqa: S106

    def test_resume_session_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(
                user_id="u1",
                public_token="t",  # noqa: S106
                resume_session_id="r" * 129,
            )

    def test_terms_version_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(
                user_id="u1",
                public_token="t",  # noqa: S106
                terms_version="v" * 51,
            )

    def test_alpaca_account_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidPublicTokenExchangeRequest(
                user_id="u1",
                public_token="t",  # noqa: S106
                alpaca_account_id="a" * 129,
            )


# ---------------------------------------------------------------------------
# PlaidOAuthResumeRequest
# ---------------------------------------------------------------------------


class TestPlaidOAuthResumeRequest:
    def test_valid_passes(self):
        r = PlaidOAuthResumeRequest(user_id="u1", resume_session_id="sess1")
        assert r.resume_session_id == "sess1"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidOAuthResumeRequest(user_id="u" * 129, resume_session_id="s")

    def test_resume_session_id_empty_raises(self):
        with pytest.raises(ValidationError):
            PlaidOAuthResumeRequest(user_id="u1", resume_session_id="")

    def test_resume_session_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidOAuthResumeRequest(user_id="u1", resume_session_id="s" * 129)


# ---------------------------------------------------------------------------
# PlaidRefreshRequest / PlaidRefreshCancelRequest
# ---------------------------------------------------------------------------


class TestPlaidRefreshRequest:
    def test_valid_passes(self):
        r = PlaidRefreshRequest(user_id="u1")
        assert r.item_id is None

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidRefreshRequest(user_id="u" * 129)

    def test_item_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidRefreshRequest(user_id="u1", item_id="i" * 129)


class TestPlaidRefreshCancelRequest:
    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidRefreshCancelRequest(user_id="u" * 129)


# ---------------------------------------------------------------------------
# PlaidFundingTransactionsSyncRequest
# ---------------------------------------------------------------------------


class TestPlaidFundingTransactionsSyncRequest:
    def test_valid_passes(self):
        r = PlaidFundingTransactionsSyncRequest(user_id="u1", item_id="item1")
        assert r.cursor is None

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingTransactionsSyncRequest(user_id="u" * 129, item_id="i")

    def test_item_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingTransactionsSyncRequest(user_id="u1", item_id="i" * 129)

    def test_cursor_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingTransactionsSyncRequest(user_id="u1", item_id="i1", cursor="c" * 513)


# ---------------------------------------------------------------------------
# PlaidTransferCreateRequest
# ---------------------------------------------------------------------------


class TestPlaidTransferCreateRequest:
    def _valid(self, **kw) -> dict:
        base = dict(
            user_id="u1",
            funding_item_id="fi1",
            funding_account_id="fa1",
            amount=100.0,
            user_legal_name="Alice Smith",
        )
        return {**base, **kw}

    def test_valid_passes(self):
        r = PlaidTransferCreateRequest(**self._valid())
        assert r.network == "ach"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._valid(user_id="u" * 129))

    def test_user_legal_name_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._valid(user_legal_name="n" * 257))

    def test_network_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._valid(network="n" * 51))

    def test_description_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._valid(description="d" * 257))

    def test_idempotency_key_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._valid(idempotency_key="k" * 129))

    def test_redirect_uri_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidTransferCreateRequest(**self._valid(redirect_uri="h" * 2049))


# ---------------------------------------------------------------------------
# PlaidFundingEscalationRequest
# ---------------------------------------------------------------------------


class TestPlaidFundingEscalationRequest:
    def test_valid_passes(self):
        r = PlaidFundingEscalationRequest(user_id="u1", notes="Transfer stuck")
        assert r.severity == "normal"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(user_id="u" * 129, notes="n")

    def test_notes_empty_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(user_id="u1", notes="")

    def test_notes_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(user_id="u1", notes="n" * 4001)

    def test_notes_at_max_passes(self):
        r = PlaidFundingEscalationRequest(user_id="u1", notes="n" * 4000)
        assert len(r.notes) == 4000

    def test_transfer_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundingEscalationRequest(user_id="u1", notes="n", transfer_id="t" * 129)


# ---------------------------------------------------------------------------
# AlpacaConnect requests
# ---------------------------------------------------------------------------


class TestAlpacaConnectStartRequest:
    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            AlpacaConnectStartRequest(user_id="u" * 129)

    def test_redirect_uri_too_long_raises(self):
        with pytest.raises(ValidationError):
            AlpacaConnectStartRequest(user_id="u1", redirect_uri="h" * 2049)


class TestAlpacaConnectCompleteRequest:
    def test_valid_passes(self):
        r = AlpacaConnectCompleteRequest(user_id="u1", state="s1", code="c1")
        assert r.state == "s1"

    def test_state_too_long_raises(self):
        with pytest.raises(ValidationError):
            AlpacaConnectCompleteRequest(user_id="u1", state="s" * 513, code="c")

    def test_code_too_long_raises(self):
        with pytest.raises(ValidationError):
            AlpacaConnectCompleteRequest(user_id="u1", state="s", code="c" * 513)


# ---------------------------------------------------------------------------
# PlaidFundedTradeCreateRequest
# ---------------------------------------------------------------------------


class TestPlaidFundedTradeCreateRequest:
    def _valid(self, **kw) -> dict:
        base = dict(
            user_id="u1",
            funding_item_id="fi1",
            funding_account_id="fa1",
            symbol="AAPL",
            user_legal_name="Alice Smith",
            notional_usd=100.0,
        )
        return {**base, **kw}

    def test_valid_passes(self):
        r = PlaidFundedTradeCreateRequest(**self._valid())
        assert r.side == "buy"

    def test_symbol_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._valid(symbol="A" * 21))

    def test_user_legal_name_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._valid(user_legal_name="n" * 257))

    def test_brokerage_account_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._valid(brokerage_account_id="b" * 129))

    def test_trade_idempotency_key_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeCreateRequest(**self._valid(trade_idempotency_key="k" * 129))


class TestPlaidFundedTradeRefreshRequest:
    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            PlaidFundedTradeRefreshRequest(user_id="u" * 129)


# ---------------------------------------------------------------------------
# StreamAnalyzeRequest
# ---------------------------------------------------------------------------


class TestStreamAnalyzeRequest:
    def test_valid_passes(self):
        r = StreamAnalyzeRequest(user_id="u1", ticker="AAPL")
        assert r.risk_profile == "balanced"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(user_id="u" * 129, ticker="AAPL")

    def test_ticker_empty_raises(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(user_id="u1", ticker="")

    def test_ticker_too_long_raises(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(user_id="u1", ticker="A" * 21)

    def test_risk_profile_too_long_raises(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(user_id="u1", ticker="AAPL", risk_profile="r" * 65)

    def test_run_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(user_id="u1", ticker="AAPL", run_id="r" * 129)

    def test_resume_cursor_negative_raises(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(user_id="u1", ticker="AAPL", resume_cursor=-1)


# ---------------------------------------------------------------------------
# StartAnalyzeRunRequest
# ---------------------------------------------------------------------------


class TestStartAnalyzeRunRequest:
    def test_valid_passes(self):
        r = StartAnalyzeRunRequest(user_id="u1", debate_session_id="sess1", ticker="AAPL")
        assert r.ticker == "AAPL"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(user_id="u" * 129, debate_session_id="s", ticker="AAPL")

    def test_debate_session_id_empty_raises(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(user_id="u1", debate_session_id="", ticker="AAPL")

    def test_debate_session_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(user_id="u1", debate_session_id="s" * 129, ticker="AAPL")

    def test_ticker_too_long_raises(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(user_id="u1", debate_session_id="s1", ticker="A" * 21)

    def test_pick_source_too_long_raises(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="u1", debate_session_id="s1", ticker="AAPL", pick_source="p" * 257
            )

    def test_pick_source_kind_too_long_raises(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="u1", debate_session_id="s1", ticker="AAPL", pick_source_kind="k" * 65
            )


# ---------------------------------------------------------------------------
# KaiChatRequest
# ---------------------------------------------------------------------------


class TestKaiChatRequest:
    def test_valid_passes(self):
        r = KaiChatRequest(user_id="u1", message="Hello")
        assert r.conversation_id is None

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            KaiChatRequest(user_id="", message="Hello")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            KaiChatRequest(user_id="u" * 129, message="Hello")

    def test_message_empty_raises(self):
        with pytest.raises(ValidationError):
            KaiChatRequest(user_id="u1", message="")

    def test_message_too_long_raises(self):
        with pytest.raises(ValidationError):
            KaiChatRequest(user_id="u1", message="m" * 4001)

    def test_conversation_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            KaiChatRequest(user_id="u1", message="Hello", conversation_id="c" * 129)


# ---------------------------------------------------------------------------
# AnalyzeLoserRequest
# ---------------------------------------------------------------------------


class TestAnalyzeLoserRequest:
    def test_valid_passes(self):
        r = AnalyzeLoserRequest(user_id="u1", symbol="AAPL")
        assert r.symbol == "AAPL"

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLoserRequest(user_id="u" * 129, symbol="AAPL")

    def test_symbol_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLoserRequest(user_id="u1", symbol="A" * 11)

    def test_conversation_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            AnalyzeLoserRequest(user_id="u1", symbol="AAPL", conversation_id="c" * 129)
