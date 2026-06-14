from __future__ import annotations

import pytest

from hushh_mcp.services.agent_voice_service import AgentVoiceService, _wav_from_pcm


def test_agent_voice_service_parses_structured_transcription(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    service = AgentVoiceService(model="gemini-2.5-flash")

    result = service._parse_transcription_response(
        '{"transcript":"  start   Nvidia analysis  ","uncertain":false}'
    )

    assert result.transcript == "start Nvidia analysis"
    assert result.uncertain is False
    assert result.reason is None
    assert result.model == "gemini-2.5-flash"


def test_agent_voice_service_marks_empty_transcript_uncertain(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    service = AgentVoiceService(model="gemini-2.5-flash")

    result = service._parse_transcription_response('{"transcript":"","uncertain":false}')

    assert result.transcript == ""
    assert result.uncertain is True
    assert result.reason == "The transcript was empty or too short."


def test_agent_voice_service_does_not_surface_malformed_transcription(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    service = AgentVoiceService(model="gemini-2.5-flash")

    result = service._parse_transcription_response("{")

    assert result.transcript == ""
    assert result.uncertain is True
    assert result.reason == "The transcription response was not structured."


@pytest.mark.asyncio
async def test_agent_voice_service_retries_malformed_transcription(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    service = AgentVoiceService(model="gemini-2.5-flash")
    service.client = object()
    responses = iter(
        [
            "{",
            '{"transcript":"hello after retry","uncertain":false}',
        ]
    )
    prompts: list[str] = []

    async def fake_generate_transcription_text(*, audio_bytes, mime_type, prompt):
        prompts.append(prompt)
        return next(responses)

    monkeypatch.setattr(
        service,
        "_generate_transcription_text",
        fake_generate_transcription_text,
    )

    result = await service.transcribe_audio(audio_bytes=b"audio", mime_type="audio/wav")

    assert result.transcript == "hello after retry"
    assert result.uncertain is False
    assert len(prompts) == 2
    assert "previous response was not valid JSON" in prompts[1]


def test_agent_voice_service_wraps_pcm_as_wav():
    wav = _wav_from_pcm(b"\x00\x00\x01\x00", sample_rate=24000)

    assert wav.startswith(b"RIFF")
    assert b"WAVEfmt " in wav[:24]
    assert wav.endswith(b"\x00\x00\x01\x00")
