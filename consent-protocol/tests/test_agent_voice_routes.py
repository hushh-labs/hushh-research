from __future__ import annotations

from dataclasses import dataclass

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import agent_voice
from hushh_mcp.services.agent_voice_service import AgentVoiceSynthesis, AgentVoiceTranscription


@dataclass
class _FakeAgentVoiceService:
    transcript: str = "start Nvidia analysis"
    uncertain: bool = False
    reason: str | None = None
    model: str = "gemini-2.5-flash"
    last_audio_bytes: bytes | None = None
    last_mime_type: str | None = None
    last_tts_text: str | None = None
    last_tts_voice: str | None = None

    async def transcribe_audio(self, *, audio_bytes: bytes, mime_type: str):
        self.last_audio_bytes = audio_bytes
        self.last_mime_type = mime_type
        return AgentVoiceTranscription(
            transcript=self.transcript,
            uncertain=self.uncertain,
            reason=self.reason,
            model=self.model,
        )

    async def synthesize_speech(self, *, text: str, voice: str | None = None):
        self.last_tts_text = text
        self.last_tts_voice = voice
        return AgentVoiceSynthesis(
            audio=b"fake-wav",
            mime_type="audio/wav",
            model="gemini-2.5-flash-preview-tts",
            voice=voice or "Sulafat",
        )


@dataclass
class _ErroringAgentVoiceService:
    """Service that raises RuntimeError with an internal message."""

    stt_error: str = "Internal SDK error: PERMISSION_DENIED at /api/v1/endpoint"
    tts_runtime_error: str = "Internal TTS error: connection refused"

    async def transcribe_audio(self, *, audio_bytes: bytes, mime_type: str):
        raise RuntimeError(self.stt_error)

    async def synthesize_speech(self, *, text: str, voice: str | None = None):
        raise RuntimeError(self.tts_runtime_error)


@dataclass
class _ValueErrorAgentVoiceService:
    value_error_msg: str = "Internal validation detail"

    async def transcribe_audio(self, *, audio_bytes: bytes, mime_type: str):
        raise ValueError(self.value_error_msg)

    async def synthesize_speech(self, *, text: str, voice: str | None = None):
        raise ValueError(self.value_error_msg)


def _client(user_id: str = "user-1") -> TestClient:
    app = FastAPI()
    app.include_router(agent_voice.router)
    app.dependency_overrides[agent_voice.require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "scope": "vault.owner",
    }
    return TestClient(app)


def test_agent_voice_stt_transcribes_audio_upload(monkeypatch) -> None:
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/stt",
        data={"user_id": "user-1"},
        files={"audio": ("utterance.webm", b"fake-audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "transcript": "start Nvidia analysis",
        "uncertain": False,
        "reason": None,
    }
    assert service.last_audio_bytes == b"fake-audio"
    assert service.last_mime_type == "audio/webm"


def test_agent_voice_stt_rejects_token_user_mismatch(monkeypatch) -> None:
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client(user_id="other-user")

    response = client.post(
        "/agent/voice/stt",
        data={"user_id": "user-1"},
        files={"audio": ("utterance.webm", b"fake-audio", "audio/webm")},
    )

    assert response.status_code == 403


def test_agent_voice_stt_rejects_non_audio_upload(monkeypatch) -> None:
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/stt",
        data={"user_id": "user-1"},
        files={"audio": ("utterance.txt", b"hello", "text/plain")},
    )

    assert response.status_code == 415


def test_agent_voice_tts_returns_transient_audio(monkeypatch) -> None:
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "Starting Nvidia analysis.", "voice": "Kore"},
    )

    assert response.status_code == 200
    assert response.content == b"fake-wav"
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-agent-tts-source"] == "backend_gemini_audio"
    assert service.last_tts_text == "Starting Nvidia analysis."
    assert service.last_tts_voice == "Kore"


def test_agent_voice_tts_rejects_empty_text(monkeypatch) -> None:
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "   "},
    )

    assert response.status_code == 422


def test_agent_voice_routes_respect_kill_switch(monkeypatch) -> None:
    service = _FakeAgentVoiceService()
    monkeypatch.setenv("AGENT_GEMINI_VOICE_ENABLED", "false")
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    stt_response = client.post(
        "/agent/voice/stt",
        data={"user_id": "user-1"},
        files={"audio": ("utterance.webm", b"fake-audio", "audio/webm")},
    )
    tts_response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "Hello."},
    )

    assert stt_response.status_code == 503
    assert tts_response.status_code == 503


def test_stt_runtime_error_is_opaque(monkeypatch) -> None:
    """RuntimeError from the STT service must not expose its message to the caller."""
    internal_msg = "PERMISSION_DENIED: Request had insufficient authentication scopes."
    service = _ErroringAgentVoiceService(stt_error=internal_msg)
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/stt",
        data={"user_id": "user-1"},
        files={"audio": ("utterance.webm", b"fake-audio", "audio/webm")},
    )

    assert response.status_code == 503
    assert internal_msg not in response.text


def test_tts_runtime_error_is_opaque(monkeypatch) -> None:
    """RuntimeError from the TTS service must not expose its message to the caller."""
    internal_msg = "connection refused to internal endpoint /v1/tts"
    service = _ErroringAgentVoiceService(tts_runtime_error=internal_msg)
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "Hello Kai."},
    )

    assert response.status_code == 503
    assert internal_msg not in response.text


def test_tts_value_error_is_opaque(monkeypatch) -> None:
    """ValueError from the TTS service must not expose its message to the caller."""
    internal_msg = "internal validation: max_tokens exceeded for model context"
    service = _ValueErrorAgentVoiceService(value_error_msg=internal_msg)
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "Hello Kai."},
    )

    assert response.status_code == 422
    assert internal_msg not in response.text


def test_stt_rejects_oversized_user_id(monkeypatch) -> None:
    """user_id longer than 128 chars must be rejected before any processing."""
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client(user_id="x" * 129)

    response = client.post(
        "/agent/voice/stt",
        data={"user_id": "x" * 129},
        files={"audio": ("utterance.webm", b"fake-audio", "audio/webm")},
    )

    assert response.status_code == 422


def test_tts_rejects_oversized_user_id(monkeypatch) -> None:
    """user_id longer than 128 chars in TTS body must be rejected."""
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client(user_id="x" * 129)

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "x" * 129, "text": "Hello."},
    )

    assert response.status_code == 422


def test_tts_rejects_oversized_text(monkeypatch) -> None:
    """text longer than 4096 chars in TTS body must be rejected."""
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "A" * 4097},
    )

    assert response.status_code == 422


def test_tts_rejects_oversized_voice(monkeypatch) -> None:
    """voice longer than 64 chars in TTS body must be rejected."""
    service = _FakeAgentVoiceService()
    monkeypatch.setattr(agent_voice, "get_agent_voice_service", lambda: service)
    client = _client()

    response = client.post(
        "/agent/voice/tts",
        json={"user_id": "user-1", "text": "Hello.", "voice": "V" * 65},
    )

    assert response.status_code == 422
