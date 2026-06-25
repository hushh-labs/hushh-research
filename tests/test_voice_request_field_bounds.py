"""Tests for input bounds on voice request models (CWE-400).

POST /kai/voice/plan, /kai/voice/compose, /kai/voice/tts, and
/kai/voice/realtime/session all pass caller-supplied strings directly into
third-party AI inference APIs (OpenAI GPT / TTS).

Before this fix the four request models had no max_length on any string field:

  VoicePlanRequest.transcript     -- fed verbatim to OpenAI for planning
  VoiceComposeRequest.transcript  -- fed verbatim to OpenAI for composition
  VoiceTTSRequest.text            -- submitted to OpenAI TTS (API limit: 4096 chars)
  user_id fields across all models

A caller with a valid vault token could submit a multi-MB transcript or TTS
body and force expensive inference with a single request (CWE-400 uncontrolled
resource consumption).

Fix: Added Field(max_length=...) to every unbounded string field in the four
request models. VoiceTTSRequest.text is capped at 4096, matching the OpenAI
TTS API hard limit. transcript fields are capped at 10_000. user_id fields are
capped at 128 (Firebase UID maximum). Short identifier fields (turn_id,
response_id, mode, action_id, reply_strategy, voice) are capped at 32-128.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.voice import (
    VoiceCapabilityRequest,
    VoiceComposeRequest,
    VoicePlanRequest,
    VoiceRealtimeSessionRequest,
    VoiceResponsePayload,
    VoiceTTSRequest,
)

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

_VALID_RESPONSE_PAYLOAD = VoiceResponsePayload(kind="message", message="ok")


# ---------------------------------------------------------------------------
# VoicePlanRequest bounds
# ---------------------------------------------------------------------------


class TestVoicePlanRequestBounds:
    def test_oversized_transcript_rejected(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(
                user_id="uid",
                transcript="x" * 10_001,
            )

    def test_empty_transcript_rejected(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="uid", transcript="")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u" * 129, transcript="hello")

    def test_oversized_turn_id_rejected(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="uid", transcript="hello", turn_id="t" * 129)

    def test_oversized_transcript_final_rejected(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(
                user_id="uid",
                transcript="hello",
                transcript_final="x" * 10_001,
            )

    def test_valid_request_accepted(self):
        req = VoicePlanRequest(user_id="uid123", transcript="What is AAPL?")
        assert req.transcript == "What is AAPL?"


# ---------------------------------------------------------------------------
# VoiceComposeRequest bounds
# ---------------------------------------------------------------------------


class TestVoiceComposeRequestBounds:
    def test_oversized_transcript_rejected(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(
                user_id="uid",
                transcript="x" * 10_001,
                response=_VALID_RESPONSE_PAYLOAD,
            )

    def test_empty_transcript_rejected(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(
                user_id="uid",
                transcript="",
                response=_VALID_RESPONSE_PAYLOAD,
            )

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(
                user_id="u" * 129,
                transcript="hello",
                response=_VALID_RESPONSE_PAYLOAD,
            )

    def test_oversized_turn_id_rejected(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(
                user_id="uid",
                transcript="hello",
                response=_VALID_RESPONSE_PAYLOAD,
                turn_id="t" * 129,
            )

    def test_oversized_mode_rejected(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(
                user_id="uid",
                transcript="hello",
                response=_VALID_RESPONSE_PAYLOAD,
                mode="m" * 51,
            )

    def test_valid_request_accepted(self):
        req = VoiceComposeRequest(
            user_id="uid123",
            transcript="Buy AAPL",
            response=_VALID_RESPONSE_PAYLOAD,
        )
        assert req.user_id == "uid123"


# ---------------------------------------------------------------------------
# VoiceTTSRequest bounds
# ---------------------------------------------------------------------------


class TestVoiceTTSRequestBounds:
    def test_text_exceeding_openai_limit_rejected(self):
        """OpenAI TTS rejects text over 4096 chars; block it at the API boundary."""
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="uid", text="x" * 4097)

    def test_empty_text_rejected(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="uid", text="")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="u" * 129, text="hello")

    def test_oversized_voice_rejected(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="uid", text="hello", voice="v" * 33)

    def test_valid_request_accepted(self):
        req = VoiceTTSRequest(user_id="uid123", text="Hello world", voice="alloy")
        assert req.text == "Hello world"

    def test_exactly_4096_chars_accepted(self):
        req = VoiceTTSRequest(user_id="uid", text="x" * 4096)
        assert len(req.text) == 4096


# ---------------------------------------------------------------------------
# VoiceCapabilityRequest and VoiceRealtimeSessionRequest bounds
# ---------------------------------------------------------------------------


class TestVoiceCapabilityRequestBounds:
    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            VoiceCapabilityRequest(user_id="u" * 129)

    def test_valid_request_accepted(self):
        req = VoiceCapabilityRequest(user_id="uid123")
        assert req.user_id == "uid123"


class TestVoiceRealtimeSessionRequestBounds:
    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionRequest(user_id="u" * 129)

    def test_oversized_voice_rejected(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionRequest(user_id="uid", voice="v" * 33)

    def test_valid_request_accepted(self):
        req = VoiceRealtimeSessionRequest(user_id="uid123", voice="alloy")
        assert req.voice == "alloy"
