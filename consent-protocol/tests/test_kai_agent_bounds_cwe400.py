"""CWE-400 bounds tests for Kai Agent Voice routes."""

import pytest
from pydantic import ValidationError

from api.routes.kai.agent_voice import (
    AgentVoiceTranscriptionResponse,
    AgentVoiceTTSRequest,
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
