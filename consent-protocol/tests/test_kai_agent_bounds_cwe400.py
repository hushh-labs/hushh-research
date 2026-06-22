"""CWE-400 bounds tests for Kai Agent Realtime and Voice routes."""

import pytest
from pydantic import ValidationError

from api.routes.kai.agent_realtime import (
    AgentRealtimeSessionRequest,
    AgentRealtimeSessionResponse,
)
from api.routes.kai.agent_voice import (
    AgentVoiceTranscriptionResponse,
    AgentVoiceTTSRequest,
)

# Placeholder, non-sensitive value for response model construction in tests.
_PLACEHOLDER_SECRET = "x" * 9


class TestAgentRealtimeSessionRequest:
    def test_valid(self):
        req = AgentRealtimeSessionRequest(user_id="user-123")
        assert req.user_id == "user-123"

    def test_user_id_bounds(self):
        with pytest.raises(ValidationError):
            AgentRealtimeSessionRequest(user_id="A" * 257)

    def test_voice_bounds(self):
        with pytest.raises(ValidationError):
            AgentRealtimeSessionRequest(user_id="user-123", voice="A" * 129)


class TestAgentRealtimeSessionResponse:
    def test_valid(self):
        resp = AgentRealtimeSessionResponse(
            client_secret=_PLACEHOLDER_SECRET,
            model="openai",
            voice="alloy",
            transcription_model="whisper-1",
            transcription_language="en",
            transcription_prompt="answer in english",
            silence_duration_ms=250,
        )
        assert resp.client_secret == _PLACEHOLDER_SECRET

    def test_client_secret_bounds(self):
        with pytest.raises(ValidationError):
            AgentRealtimeSessionResponse(
                client_secret="A" * 2049,
                model="openai",
                voice="alloy",
                transcription_model="whisper-1",
                transcription_language="en",
                transcription_prompt="prompt",
            )

    def test_model_bounds(self):
        with pytest.raises(ValidationError):
            AgentRealtimeSessionResponse(
                client_secret=_PLACEHOLDER_SECRET,
                model="A" * 129,
                voice="alloy",
                transcription_model="whisper-1",
                transcription_language="en",
                transcription_prompt="prompt",
            )

    def test_transcription_prompt_bounds(self):
        with pytest.raises(ValidationError):
            AgentRealtimeSessionResponse(
                client_secret=_PLACEHOLDER_SECRET,
                model="openai",
                voice="alloy",
                transcription_model="whisper-1",
                transcription_language="en",
                transcription_prompt="A" * 2049,
            )

    def test_silence_duration_bounds(self):
        with pytest.raises(ValidationError):
            AgentRealtimeSessionResponse(
                client_secret=_PLACEHOLDER_SECRET,
                model="openai",
                voice="alloy",
                transcription_model="whisper-1",
                transcription_language="en",
                transcription_prompt="prompt",
                silence_duration_ms=10001,
            )


class TestAgentVoiceTranscriptionResponse:
    def test_valid(self):
        resp = AgentVoiceTranscriptionResponse(transcript="hello world", uncertain=False)
        assert resp.transcript == "hello world"

    def test_transcript_bounds(self):
        with pytest.raises(ValidationError):
            AgentVoiceTranscriptionResponse(transcript="A" * 16385, uncertain=False)

    def test_reason_bounds(self):
        with pytest.raises(ValidationError):
            AgentVoiceTranscriptionResponse(transcript="hello", uncertain=False, reason="A" * 513)


class TestAgentVoiceTTSRequest:
    def test_valid(self):
        req = AgentVoiceTTSRequest(user_id="user-123", text="hello world")
        assert req.text == "hello world"
