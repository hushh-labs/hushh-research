"""Test CWE-400 mitigation: Kai response model field bounds.

Validates that all Kai response model fields have appropriate bounds
to prevent resource exhaustion attacks through unbounded responses.
"""

import pytest
from pydantic import ValidationError

from api.routes.kai.chat import (
    AnalyzeLoserResponse,
    ConversationHistoryResponse,
    KaiChatResponseModel,
)


class TestKaiChatResponseModelBounds:
    """Verify KaiChatResponseModel enforces field bounds."""

    def test_conversation_id_respects_max_length(self):
        """conversation_id should reject values exceeding max_length=256."""
        with pytest.raises(ValidationError):
            KaiChatResponseModel(
                conversation_id="x" * 300,
                response="test",
            )

    def test_response_respects_max_length(self):
        """response should reject values exceeding max_length=8192."""
        with pytest.raises(ValidationError):
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="x" * 10000,
            )

    def test_tokens_used_respects_bounds(self):
        """tokens_used should reject negative or oversized values."""
        with pytest.raises(ValidationError):
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="test",
                tokens_used=-1,
            )
        with pytest.raises(ValidationError):
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="test",
                tokens_used=2000000,
            )

    def test_valid_response_is_accepted(self):
        """Valid response within bounds should be accepted."""
        response = KaiChatResponseModel(
            conversation_id="conv-123",
            response="This is a valid response",
            component_type="widget",
            tokens_used=150,
        )
        assert response.conversation_id == "conv-123"
        assert response.response == "This is a valid response"
        assert response.tokens_used == 150


class TestConversationHistoryResponseBounds:
    """Verify ConversationHistoryResponse enforces field bounds."""

    def test_conversation_id_respects_max_length(self):
        """conversation_id should reject values exceeding max_length=256."""
        with pytest.raises(ValidationError):
            ConversationHistoryResponse(
                conversation_id="x" * 300,
                messages=[],
            )

    def test_messages_respects_max_items(self):
        """messages should reject lists exceeding max_items=1000."""
        with pytest.raises(ValidationError):
            ConversationHistoryResponse(
                conversation_id="conv-123",
                messages=[{"text": "msg"}] * 1001,
            )


class TestAnalyzeLoserResponseBounds:
    """Verify AnalyzeLoserResponse enforces field bounds."""

    def test_ticker_respects_max_length(self):
        """ticker should reject values exceeding max_length=10."""
        with pytest.raises(ValidationError):
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="TOOLONGTICKERRRRR",
                decision="BUY",
                confidence=0.8,
                summary="test",
                reasoning="test",
            )

    def test_decision_respects_max_length(self):
        """decision should reject values exceeding max_length=32."""
        with pytest.raises(ValidationError):
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="AAPL",
                decision="x" * 50,
                confidence=0.8,
                summary="test",
                reasoning="test",
            )

    def test_confidence_respects_bounds(self):
        """confidence should only accept values between 0.0 and 1.0."""
        with pytest.raises(ValidationError):
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="AAPL",
                decision="BUY",
                confidence=1.5,
                summary="test",
                reasoning="test",
            )
        with pytest.raises(ValidationError):
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="AAPL",
                decision="BUY",
                confidence=-0.1,
                summary="test",
                reasoning="test",
            )

    def test_valid_response_is_accepted(self):
        """Valid analyze response within bounds should be accepted."""
        response = AnalyzeLoserResponse(
            conversation_id="conv-123",
            ticker="AAPL",
            decision="HOLD",
            confidence=0.72,
            summary="Mixed signals",
            reasoning="Apple shows strength and weakness",
        )
        assert response.ticker == "AAPL"
        assert response.decision == "HOLD"
        assert response.confidence == 0.72
