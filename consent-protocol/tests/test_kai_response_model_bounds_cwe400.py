"""
Tests: CWE-400 -- KAI response models must enforce max_length bounds to prevent resource exhaustion.

Validates that response model fields with max_length constraints properly reject oversized inputs
when those models are used as Pydantic validators for response serialization.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.agent_chat import (
    AgentChatConversationModel,
    AgentChatConversationsResponse,
    AgentChatDeleteResponse,
    AgentChatHistoryResponse,
    AgentChatMessageModel,
)
from api.routes.kai.analyze import AnalyzeResponse
from api.routes.kai.chat import (
    AnalyzeLoserResponse,
    ConversationHistoryResponse,
    KaiChatResponseModel,
)
from api.routes.kai.consent import GrantConsentResponse
from api.routes.kai.decisions import DecisionHistoryResponse
from api.routes.kai.losers import AnalyzeLosersResponse
from api.routes.kai.portfolio import (
    DashboardProfilePick,
    DashboardProfilePicksResponse,
    PortfolioImportResponse,
    PortfolioSummaryResponse,
)
from api.routes.kai.voice import (
    VoiceCapabilityResponse,
    VoiceClarificationPayload,
    VoiceComposeResponse,
    VoiceRealtimeSessionResponse,
    VoiceResponsePayload,
)


class TestKaiChatResponseModelBounds:
    """Validate KaiChatResponseModel field bounds."""

    def test_conversation_id_max_length_256(self):
        """conversation_id must not exceed 256 chars."""
        valid = KaiChatResponseModel(
            conversation_id="c" * 256,
            response="Test response",
        )
        assert valid.conversation_id == "c" * 256

        with pytest.raises(ValidationError) as exc_info:
            KaiChatResponseModel(
                conversation_id="c" * 257,
                response="Test response",
            )
        assert "at most 256 characters" in str(exc_info.value)

    def test_response_max_length_8192(self):
        """response must not exceed 8192 chars."""
        valid = KaiChatResponseModel(
            conversation_id="conv-123",
            response="r" * 8192,
        )
        assert len(valid.response) == 8192

        with pytest.raises(ValidationError) as exc_info:
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="r" * 8193,
            )
        assert "at most 8192 characters" in str(exc_info.value)

    def test_component_type_max_length_128(self):
        """component_type must not exceed 128 chars."""
        valid = KaiChatResponseModel(
            conversation_id="conv-123",
            response="Test",
            component_type="t" * 128,
        )
        assert valid.component_type == "t" * 128

        with pytest.raises(ValidationError) as exc_info:
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="Test",
                component_type="t" * 129,
            )
        assert "at most 128 characters" in str(exc_info.value)

    def test_tokens_used_bounds(self):
        """tokens_used must be between 0 and 1000000."""
        valid = KaiChatResponseModel(
            conversation_id="conv-123",
            response="Test",
            tokens_used=1000000,
        )
        assert valid.tokens_used == 1000000

        with pytest.raises(ValidationError) as exc_info:
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="Test",
                tokens_used=1000001,
            )
        assert "less than or equal to 1000000" in str(exc_info.value)

        with pytest.raises(ValidationError) as exc_info:
            KaiChatResponseModel(
                conversation_id="conv-123",
                response="Test",
                tokens_used=-1,
            )
        assert "greater than or equal to 0" in str(exc_info.value)


class TestAnalyzeLoserResponseBounds:
    """Validate AnalyzeLoserResponse field bounds."""

    def test_conversation_id_max_length_256(self):
        """conversation_id must not exceed 256 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AnalyzeLoserResponse(
                conversation_id="c" * 257,
                ticker="AAPL",
                decision="BUY",
                confidence=0.85,
                summary="Test",
                reasoning="Test reasoning",
            )
        assert "at most 256 characters" in str(exc_info.value)

    def test_ticker_max_length_10(self):
        """ticker must not exceed 10 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="A" * 11,
                decision="BUY",
                confidence=0.85,
                summary="Test",
                reasoning="Test reasoning",
            )
        assert "at most 10 characters" in str(exc_info.value)

    def test_decision_max_length_32(self):
        """decision must not exceed 32 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="AAPL",
                decision="D" * 33,
                confidence=0.85,
                summary="Test",
                reasoning="Test reasoning",
            )
        assert "at most 32 characters" in str(exc_info.value)

    def test_confidence_bounds(self):
        """confidence must be between 0.0 and 1.0."""
        valid = AnalyzeLoserResponse(
            conversation_id="conv-123",
            ticker="AAPL",
            decision="BUY",
            confidence=1.0,
            summary="Test",
            reasoning="Test reasoning",
        )
        assert valid.confidence == 1.0

        with pytest.raises(ValidationError) as exc_info:
            AnalyzeLoserResponse(
                conversation_id="conv-123",
                ticker="AAPL",
                decision="BUY",
                confidence=1.1,
                summary="Test",
                reasoning="Test reasoning",
            )
        assert "less than or equal to 1" in str(exc_info.value)


class TestVoiceResponsePayloadBounds:
    """Validate VoiceResponsePayload field bounds."""

    def test_kind_max_length_64(self):
        """kind must not exceed 64 chars."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceResponsePayload(
                kind="k" * 65,
                message="Test",
            )
        assert "at most 64 characters" in str(exc_info.value)

    def test_message_max_length_4096(self):
        """message must not exceed 4096 chars."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceResponsePayload(
                kind="test",
                message="m" * 4097,
            )
        assert "at most 4096 characters" in str(exc_info.value)

    def test_ticker_max_length_10(self):
        """ticker must not exceed 10 chars."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceResponsePayload(
                kind="test",
                message="Test",
                ticker="T" * 11,
            )
        assert "at most 10 characters" in str(exc_info.value)


class TestVoiceComposeResponseBounds:
    """Validate VoiceComposeResponse field bounds."""

    def test_text_max_length_4096(self):
        """text must not exceed 4096 chars."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceComposeResponse(
                text="t" * 4097,
                segment_type="test",
                elapsed_ms=100,
                openai_http_ms=50,
                model="gpt-4",
            )
        assert "at most 4096 characters" in str(exc_info.value)

    def test_elapsed_ms_non_negative(self):
        """elapsed_ms must be non-negative."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceComposeResponse(
                text="Test",
                segment_type="test",
                elapsed_ms=-1,
                openai_http_ms=50,
                model="gpt-4",
            )
        assert "greater than or equal to 0" in str(exc_info.value)


class TestVoiceCapabilityResponseBounds:
    """Validate VoiceCapabilityResponse field bounds."""

    def test_user_id_max_length_256(self):
        """user_id must not exceed 256 chars."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceCapabilityResponse(
                user_id="u" * 257,
                enabled=True,
                voice_enabled=True,
                execution_allowed=False,
                tool_execution_disabled=False,
                rollout_reason="test",
                tts_timeout_ms=1000,
                tts_model="model",
                tts_voice="alloy",
                tts_format="pcm16",
            )
        assert "at most 256 characters" in str(exc_info.value)

    def test_canary_percent_bounds(self):
        """canary_percent must be between 0 and 100."""
        with pytest.raises(ValidationError) as exc_info:
            VoiceCapabilityResponse(
                user_id="user-123",
                enabled=True,
                voice_enabled=True,
                execution_allowed=False,
                tool_execution_disabled=False,
                rollout_reason="test",
                canary_percent=101,
                tts_timeout_ms=1000,
                tts_model="model",
                tts_voice="alloy",
                tts_format="pcm16",
            )
        assert "less than or equal to 100" in str(exc_info.value)


class TestPortfolioResponseBounds:
    """Validate Portfolio response model bounds."""

    def test_portfolio_summary_user_id_max_length(self):
        """user_id must not exceed 256 chars."""
        with pytest.raises(ValidationError) as exc_info:
            PortfolioSummaryResponse(
                user_id="u" * 257,
                has_portfolio=True,
            )
        assert "at most 256 characters" in str(exc_info.value)

    def test_dashboard_profile_pick_symbol_max_length(self):
        """symbol must not exceed 10 chars."""
        with pytest.raises(ValidationError) as exc_info:
            DashboardProfilePick(
                symbol="S" * 11,
                company_name="Test Company",
                rationale="Test rationale",
            )
        assert "at most 10 characters" in str(exc_info.value)

    def test_conviction_weight_bounds(self):
        """conviction_weight must be between 0.0 and 1.0."""
        with pytest.raises(ValidationError) as exc_info:
            DashboardProfilePick(
                symbol="AAPL",
                company_name="Test Company",
                conviction_weight=1.5,
                rationale="Test rationale",
            )
        assert "less than or equal to 1" in str(exc_info.value)


class TestConversationHistoryResponseBounds:
    """Validate ConversationHistoryResponse field bounds."""

    def test_conversation_id_max_length_256(self):
        """conversation_id must not exceed 256 chars."""
        with pytest.raises(ValidationError) as exc_info:
            ConversationHistoryResponse(
                conversation_id="c" * 257,
            )
        assert "at most 256 characters" in str(exc_info.value)


class TestAnalyzeLosersResponseBounds:
    """Validate AnalyzeLosersResponse field bounds."""

    def test_criteria_context_max_length_512(self):
        """criteria_context must not exceed 512 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AnalyzeLosersResponse(
                criteria_context="c" * 513,
                summary={},
                losers=[],
            )
        assert "at most 512 characters" in str(exc_info.value)


class TestAnalyzeResponseBounds:
    """Validate AnalyzeResponse field bounds."""

    def test_ticker_max_length_10(self):
        """ticker must not exceed 10 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AnalyzeResponse(
                decision_id="dec-123",
                ticker="T" * 11,
                decision="buy",
                confidence=0.85,
                headline="Test headline",
                processing_mode="normal",
                created_at="2026-01-01",
                raw_card={},
            )
        assert "at most 10 characters" in str(exc_info.value)

    def test_confidence_bounds(self):
        """confidence must be between 0.0 and 1.0."""
        with pytest.raises(ValidationError) as exc_info:
            AnalyzeResponse(
                decision_id="dec-123",
                ticker="AAPL",
                decision="buy",
                confidence=1.5,
                headline="Test headline",
                processing_mode="normal",
                created_at="2026-01-01",
                raw_card={},
            )
        assert "less than or equal to 1" in str(exc_info.value)


class TestAgentChatMessageModelBounds:
    """Validate AgentChatMessageModel field bounds."""

    def test_content_max_length_8192(self):
        """content must not exceed 8192 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AgentChatMessageModel(
                id="msg-123",
                conversation_id="conv-123",
                role="user",
                status="completed",
                content="c" * 8193,
            )
        assert "at most 8192 characters" in str(exc_info.value)

    def test_conversation_id_max_length_256(self):
        """conversation_id must not exceed 256 chars."""
        with pytest.raises(ValidationError) as exc_info:
            AgentChatMessageModel(
                id="msg-123",
                conversation_id="c" * 257,
                role="user",
                status="completed",
                content="Test content",
            )
        assert "at most 256 characters" in str(exc_info.value)


class TestDecisionHistoryResponseBounds:
    """Validate DecisionHistoryResponse field bounds."""

    def test_total_non_negative(self):
        """total must be non-negative."""
        with pytest.raises(ValidationError) as exc_info:
            DecisionHistoryResponse(
                decisions=[],
                total=-1,
            )
        assert "greater than or equal to 0" in str(exc_info.value)


class TestGrantConsentResponseBounds:
    """Validate GrantConsentResponse field bounds."""

    def test_consent_id_max_length_256(self):
        """consent_id must not exceed 256 chars."""
        with pytest.raises(ValidationError) as exc_info:
            GrantConsentResponse(
                consent_id="c" * 257,
                tokens={"scope": "token"},
                expires_at="2026-12-31",
            )
        assert "at most 256 characters" in str(exc_info.value)

    def test_expires_at_max_length_64(self):
        """expires_at must not exceed 64 chars."""
        with pytest.raises(ValidationError) as exc_info:
            GrantConsentResponse(
                consent_id="consent-123",
                tokens={"scope": "token"},
                expires_at="e" * 65,
            )
        assert "at most 64 characters" in str(exc_info.value)


class TestAgentChatConversationModelBounds:
    """Validate AgentChatConversationModel field bounds."""

    def test_id_max_length_256(self):
        with pytest.raises(ValidationError):
            AgentChatConversationModel(id="c" * 257, title="Test", status="active")

    def test_title_max_length_256(self):
        with pytest.raises(ValidationError):
            AgentChatConversationModel(id="conv-1", title="t" * 257, status="active")

    def test_status_max_length_64(self):
        with pytest.raises(ValidationError):
            AgentChatConversationModel(id="conv-1", title="Test", status="s" * 65)


class TestAgentChatConversationsResponseBounds:
    """Validate AgentChatConversationsResponse field bounds."""

    def test_user_id_max_length_256(self):
        with pytest.raises(ValidationError):
            AgentChatConversationsResponse(user_id="u" * 257, conversations=[])


class TestAgentChatHistoryResponseBounds:
    """Validate AgentChatHistoryResponse field bounds."""

    def test_conversation_id_max_length_256(self):
        with pytest.raises(ValidationError):
            AgentChatHistoryResponse(conversation_id="c" * 257, messages=[])


class TestAgentChatDeleteResponseBounds:
    """Validate AgentChatDeleteResponse field bounds."""

    def test_conversation_id_max_length_256(self):
        with pytest.raises(ValidationError):
            AgentChatDeleteResponse(conversation_id="c" * 257, deleted=True)


class TestDashboardProfilePicksResponseBounds:
    """Validate DashboardProfilePicksResponse field bounds."""

    def test_user_id_max_length_256(self):
        with pytest.raises(ValidationError):
            DashboardProfilePicksResponse(user_id="u" * 257, picks=[], generated_at="2026-01-01", risk_profile="balanced")

    def test_generated_at_max_length_64(self):
        with pytest.raises(ValidationError):
            DashboardProfilePicksResponse(user_id="user-1", picks=[], generated_at="d" * 65, risk_profile="balanced")

    def test_risk_profile_max_length_64(self):
        with pytest.raises(ValidationError):
            DashboardProfilePicksResponse(user_id="user-1", picks=[], generated_at="2026-01-01", risk_profile="r" * 65)


class TestPortfolioImportResponseBounds:
    """Validate PortfolioImportResponse field bounds."""

    def test_source_max_length_64(self):
        with pytest.raises(ValidationError):
            PortfolioImportResponse(success=True, source="s" * 65)


class TestVoiceClarificationPayloadBounds:
    """Validate VoiceClarificationPayload field bounds."""

    def test_reason_max_length_256(self):
        with pytest.raises(ValidationError):
            VoiceClarificationPayload(reason="r" * 257, question="What is this?")

    def test_question_max_length_512(self):
        with pytest.raises(ValidationError):
            VoiceClarificationPayload(reason="Testing", question="q" * 513)


class TestVoiceRealtimeSessionResponseBounds:
    """Validate VoiceRealtimeSessionResponse field bounds."""

    def test_client_secret_max_length_512(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionResponse(client_secret="s" * 513)

    def test_model_max_length_128(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionResponse(client_secret="valid-secret", model="m" * 129)  # noqa: S106
