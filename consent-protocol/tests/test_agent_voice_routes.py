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
