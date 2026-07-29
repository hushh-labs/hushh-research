"""
Tests for input bounds on voice and support request models.

Canonical attach points
-----------------------
api.routes.kai.voice.kai_voice_plan
  -> payload: VoicePlanRequest (user_id max_length=128, transcript max_length=10000,
     memory_short list max_length=100)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.kai.voice.kai_voice_capability
  -> payload: VoiceCapabilityRequest (user_id max_length=128)
  -> FastAPI returns HTTP 422 when any bound is exceeded

api.routes.kai.support.send_support_message
  -> payload: SupportMessageRequest (user_id max_length=128, subject max_length=140,
     message max_length=8000)
  -> FastAPI returns HTTP 422 when any bound is exceeded

Covers:
- VoicePlanRequest: user_id, transcript, turn_id, transcript_final,
  memory_short, memory_retrieved
- VoiceComposeRequest: user_id, transcript, turn_id, response_id, mode,
  action_id, guards, reply_strategy, action_completion, memory lists
- VoiceTTSRequest: user_id, text, voice
- VoiceCapabilityRequest: user_id
- VoiceRealtimeSessionRequest: user_id, voice
- SupportMessageRequest: user_id
"""

import pytest
from pydantic import ValidationError

from api.routes.kai.support import SupportMessageRequest
from api.routes.kai.voice import (
    VoiceCapabilityRequest,
    VoiceClarificationPayload,
    VoiceComposeRequest,
    VoicePlanRequest,
    VoiceRealtimeSessionRequest,
    VoiceResponsePayload,
    VoiceTTSRequest,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_RESPONSE_PAYLOAD = {
    "kind": "reply",
    "message": "Hello",
}


# ---------------------------------------------------------------------------
# VoicePlanRequest
# ---------------------------------------------------------------------------


class TestVoicePlanRequest:
    def test_valid_passes(self):
        r = VoicePlanRequest(user_id="u1", transcript="Buy Apple")
        assert r.user_id == "u1"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="", transcript="Buy Apple")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u" * 129, transcript="Buy Apple")

    def test_transcript_empty_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u1", transcript="")

    def test_transcript_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u1", transcript="t" * 10_001)

    def test_transcript_at_max_passes(self):
        r = VoicePlanRequest(user_id="u1", transcript="t" * 10_000)
        assert len(r.transcript) == 10_000

    def test_turn_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u1", transcript="t", turn_id="x" * 129)

    def test_transcript_final_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u1", transcript="t", transcript_final="f" * 10_001)

    def test_memory_short_over_100_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u1", transcript="t", memory_short=[{}] * 101)

    def test_memory_retrieved_over_100_raises(self):
        with pytest.raises(ValidationError):
            VoicePlanRequest(user_id="u1", transcript="t", memory_retrieved=[{}] * 101)

    def test_memory_short_at_max_passes(self):
        r = VoicePlanRequest(user_id="u1", transcript="t", memory_short=[{}] * 100)
        assert len(r.memory_short) == 100


# ---------------------------------------------------------------------------
# VoiceComposeRequest
# ---------------------------------------------------------------------------


class TestVoiceComposeRequest:
    def _valid(self, **kw) -> dict:
        base = dict(user_id="u1", transcript="Hello", response=_RESPONSE_PAYLOAD)
        return {**base, **kw}

    def test_valid_passes(self):
        r = VoiceComposeRequest(**self._valid())
        assert r.user_id == "u1"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(user_id=""))

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(user_id="u" * 129))

    def test_transcript_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(transcript="t" * 10_001))

    def test_turn_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(turn_id="x" * 129))

    def test_response_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(response_id="r" * 129))

    def test_mode_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(mode="m" * 51))

    def test_action_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(action_id="a" * 129))

    def test_guards_over_50_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(guards=["g"] * 51))

    def test_reply_strategy_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(reply_strategy="r" * 51))

    def test_action_completion_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(action_completion="a" * 257))

    def test_memory_short_over_100_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(memory_short=[{}] * 101))

    def test_memory_retrieved_over_100_raises(self):
        with pytest.raises(ValidationError):
            VoiceComposeRequest(**self._valid(memory_retrieved=[{}] * 101))


# ---------------------------------------------------------------------------
# VoiceTTSRequest
# ---------------------------------------------------------------------------


class TestVoiceTTSRequest:
    def test_valid_passes(self):
        r = VoiceTTSRequest(user_id="u1", text="Hello there")
        assert r.voice == "alloy"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="", text="Hello")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="u" * 129, text="Hello")

    def test_text_empty_raises(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="u1", text="")

    def test_text_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="u1", text="t" * 4097)

    def test_text_at_max_passes(self):
        r = VoiceTTSRequest(user_id="u1", text="t" * 4096)
        assert len(r.text) == 4096

    def test_voice_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceTTSRequest(user_id="u1", text="Hello", voice="v" * 33)


# ---------------------------------------------------------------------------
# VoiceCapabilityRequest
# ---------------------------------------------------------------------------


class TestVoiceCapabilityRequest:
    def test_valid_passes(self):
        r = VoiceCapabilityRequest(user_id="u1")
        assert r.user_id == "u1"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            VoiceCapabilityRequest(user_id="")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceCapabilityRequest(user_id="u" * 129)


# ---------------------------------------------------------------------------
# VoiceRealtimeSessionRequest
# ---------------------------------------------------------------------------


class TestVoiceRealtimeSessionRequest:
    def test_valid_passes(self):
        r = VoiceRealtimeSessionRequest(user_id="u1")
        assert r.voice is None

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionRequest(user_id="")

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionRequest(user_id="u" * 129)

    def test_voice_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceRealtimeSessionRequest(user_id="u1", voice="v" * 33)


# ---------------------------------------------------------------------------
# SupportMessageRequest
# ---------------------------------------------------------------------------


class TestSupportMessageRequest:
    def _valid(self, **kw) -> dict:
        base = dict(
            user_id="u1",
            kind="support_request",
            subject="App crashes on login",
            message="When I tap login the app crashes immediately.",
        )
        return {**base, **kw}

    def test_valid_passes(self):
        r = SupportMessageRequest(**self._valid())
        assert r.user_id == "u1"

    def test_user_id_empty_raises(self):
        with pytest.raises(ValidationError):
            SupportMessageRequest(**self._valid(user_id=""))

    def test_user_id_too_long_raises(self):
        with pytest.raises(ValidationError):
            SupportMessageRequest(**self._valid(user_id="u" * 129))

    def test_user_id_at_max_passes(self):
        r = SupportMessageRequest(**self._valid(user_id="u" * 128))
        assert len(r.user_id) == 128

    def test_invalid_kind_raises(self):
        with pytest.raises(ValidationError):
            SupportMessageRequest(**self._valid(kind="spam"))

    def test_subject_too_long_raises(self):
        with pytest.raises(ValidationError):
            SupportMessageRequest(**self._valid(subject="s" * 141))

    def test_message_too_long_raises(self):
        with pytest.raises(ValidationError):
            SupportMessageRequest(**self._valid(message="m" * 8001))


# ---------------------------------------------------------------------------
# Response-payload bounds (defense in depth on UNTRUSTED LLM/orchestrator output)
# ---------------------------------------------------------------------------
# VoiceResponsePayload(**response_payload) and
# VoiceClarificationPayload(**response_payload["clarification"]) are built in
# api.routes.kai.voice from model/orchestrator output (kai_voice_plan). The
# upper bounds below ensure an LLM that emits an oversized field cannot push
# unbounded text downstream into the compose pipeline, TTS, or the client.
# These tests would FAIL if the max_length guards were removed again.


class TestVoiceResponsePayloadBounds:
    def test_valid_passes(self):
        p = VoiceResponsePayload(kind="reply", message="Hi")
        assert p.kind == "reply"

    def test_kind_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceResponsePayload(kind="k" * 65, message="Hi")

    def test_message_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceResponsePayload(kind="reply", message="m" * 4097)

    def test_message_at_max_passes(self):
        p = VoiceResponsePayload(kind="reply", message="m" * 4096)
        assert len(p.message) == 4096

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceResponsePayload(kind="reply", message="Hi", reason="r" * 257)

    def test_ticker_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceResponsePayload(kind="reply", message="Hi", ticker="T" * 11)


class TestVoiceClarificationPayloadBounds:
    def test_valid_passes(self):
        p = VoiceClarificationPayload(reason="need info", question="Which one?")
        assert p.question == "Which one?"

    def test_reason_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceClarificationPayload(reason="r" * 257, question="Which one?")

    def test_question_too_long_raises(self):
        with pytest.raises(ValidationError):
            VoiceClarificationPayload(reason="need info", question="q" * 513)

    def test_options_over_cap_raises(self):
        with pytest.raises(ValidationError):
            VoiceClarificationPayload(reason="need info", question="Which one?", options=["o"] * 21)


# ===========================================================================
# Canonical route-level caller proof
# ===========================================================================

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import api.routes.kai.support as support_module  # noqa: E402
import api.routes.kai.voice as voice_module  # noqa: E402
from api.middleware import require_firebase_auth, require_vault_owner_token  # noqa: E402


def _vault_owner_stub() -> dict:
    return {"user_id": "test-uid", "token": "fake-token", "scope": "vault.owner"}  # noqa: S105


def _firebase_stub() -> str:
    return "test-uid"


def _voice_client() -> TestClient:
    app = FastAPI()
    app.include_router(voice_module.router)
    app.dependency_overrides[require_vault_owner_token] = _vault_owner_stub
    return TestClient(app, raise_server_exceptions=False)


def _support_client() -> TestClient:
    app = FastAPI()
    app.include_router(support_module.router)
    app.dependency_overrides[require_firebase_auth] = _firebase_stub
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.kai.voice.kai_voice_plan
# POST /voice/plan  ->  VoicePlanRequest
# ---------------------------------------------------------------------------


class TestKaiVoicePlanRouteInputBounds:
    """
    api.routes.kai.voice.kai_voice_plan is the canonical owner of
    VoicePlanRequest validation for POST /voice/plan.

    Proves FastAPI returns HTTP 422 when user_id, transcript, or
    memory_short exceed their bounds, before any LLM pipeline runs.
    """

    _URL = "/voice/plan"

    def _valid_body(self, **overrides) -> dict:
        base = {
            "user_id": "test-uid",
            "transcript": "Buy Apple",
        }
        return {**base, **overrides}

    def test_valid_body_passes_validation(self):
        """A valid body must not be rejected by Pydantic validation."""
        resp = _voice_client().post(self._URL, json=self._valid_body())
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _voice_client().post(self._URL, json=self._valid_body(user_id="u" * 129))
        assert resp.status_code == 422

    def test_transcript_over_max_returns_422(self):
        """transcript > 10000 chars must be rejected with 422."""
        resp = _voice_client().post(self._URL, json=self._valid_body(transcript="t" * 10_001))
        assert resp.status_code == 422

    def test_memory_short_over_max_returns_422(self):
        """memory_short list > 100 items must be rejected with 422."""
        resp = _voice_client().post(self._URL, json=self._valid_body(memory_short=[{}] * 101))
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.kai.voice.kai_voice_capability
# POST /voice/capability  ->  VoiceCapabilityRequest
# ---------------------------------------------------------------------------


class TestKaiVoiceCapabilityRouteInputBounds:
    """
    api.routes.kai.voice.kai_voice_capability is the canonical owner of
    VoiceCapabilityRequest validation for POST /voice/capability.

    Proves FastAPI returns HTTP 422 when user_id exceeds max_length=128.
    """

    _URL = "/voice/capability"

    def test_valid_user_id_passes_validation(self):
        """A valid user_id must not be rejected by Pydantic validation."""
        resp = _voice_client().post(self._URL, json={"user_id": "test-uid"})
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _voice_client().post(self._URL, json={"user_id": "u" * 129})
        assert resp.status_code == 422

    def test_empty_user_id_returns_422(self):
        """Empty user_id must be rejected with 422."""
        resp = _voice_client().post(self._URL, json={"user_id": ""})
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Canonical attach point: api.routes.kai.support.send_support_message
# POST /support/message  ->  SupportMessageRequest
# ---------------------------------------------------------------------------


class TestSendSupportMessageRouteInputBounds:
    """
    api.routes.kai.support.send_support_message is the canonical owner of
    SupportMessageRequest validation for POST /support/message.

    Proves FastAPI returns HTTP 422 when user_id, subject, or message
    exceed their bounds, before any downstream handling.
    """

    _URL = "/support/message"

    def _valid_body(self, **overrides) -> dict:
        base = {
            "user_id": "test-uid",
            "kind": "support_request",
            "subject": "App crashes",
            "message": "Crash on login.",
        }
        return {**base, **overrides}

    def test_valid_body_passes_validation(self):
        """A valid body must not be rejected by Pydantic validation."""
        resp = _support_client().post(self._URL, json=self._valid_body())
        assert resp.status_code != 422

    def test_user_id_over_max_returns_422(self):
        """user_id > 128 chars must be rejected with 422."""
        resp = _support_client().post(self._URL, json=self._valid_body(user_id="u" * 129))
        assert resp.status_code == 422

    def test_subject_over_max_returns_422(self):
        """subject > 140 chars must be rejected with 422."""
        resp = _support_client().post(self._URL, json=self._valid_body(subject="s" * 141))
        assert resp.status_code == 422

    def test_message_over_max_returns_422(self):
        """message > 8000 chars must be rejected with 422."""
        resp = _support_client().post(self._URL, json=self._valid_body(message="m" * 8001))
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Response-model output bounds (maintainer patch — defense in depth)
# ---------------------------------------------------------------------------
# VoiceComposeResponse, VoiceCapabilityResponse, and VoiceRealtimeSessionResponse
# are server-constructed but must keep upper bounds so an oversized/malformed
# field (model output, an ephemeral OpenAI client_secret, a rollout reason)
# cannot be surfaced to the client unchecked. These tests FAIL if the
# max_length / ge / le guards are removed again, locking the trust boundary.


class TestVoiceResponseModelBounds:
    def test_compose_response_text_over_max_raises(self):
        from api.routes.kai.voice import VoiceComposeResponse

        with pytest.raises(ValidationError):
            VoiceComposeResponse(
                text="t" * 4097,
                segment_type="final",
                elapsed_ms=1,
                openai_http_ms=1,
                model="gpt-4o",
            )

    def test_compose_response_negative_elapsed_raises(self):
        from api.routes.kai.voice import VoiceComposeResponse

        with pytest.raises(ValidationError):
            VoiceComposeResponse(
                text="ok",
                segment_type="final",
                elapsed_ms=-1,
                openai_http_ms=1,
                model="gpt-4o",
            )

    def test_capability_response_canary_over_100_raises(self):
        from api.routes.kai.voice import VoiceCapabilityResponse

        with pytest.raises(ValidationError):
            VoiceCapabilityResponse(
                user_id="u1",
                enabled=True,
                voice_enabled=True,
                execution_allowed=True,
                tool_execution_disabled=False,
                rollout_reason="canary",
                canary_percent=101,
                tts_timeout_ms=1000,
                tts_model="tts-1",
                tts_voice="alloy",
                tts_format="mp3",
            )

    def test_realtime_response_client_secret_over_max_raises(self):
        from api.routes.kai.voice import VoiceRealtimeSessionResponse

        with pytest.raises(ValidationError):
            VoiceRealtimeSessionResponse(
                client_secret="s" * 513,
                model="gpt-4o-realtime",
                voice="alloy",
            )

    def test_realtime_response_valid_passes(self):
        from api.routes.kai.voice import VoiceRealtimeSessionResponse

        token_value = "ek_" + ("x" * 16)  # synthetic ephemeral token, not a real secret
        r = VoiceRealtimeSessionResponse(
            client_secret=token_value,
            model="gpt-4o-realtime",
            voice="alloy",
        )
        assert r.client_secret == token_value
