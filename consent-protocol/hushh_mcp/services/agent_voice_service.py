"""Gemini-backed Agent voice adapters.

This service is intentionally transport-only: audio comes in, transcript text
comes out. The text Agent remains the only Agent brain.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import struct
from dataclasses import dataclass
from typing import Any

from google import genai
from google.genai import types as genai_types

from hushh_mcp.runtime_settings import get_core_security_settings

logger = logging.getLogger(__name__)

AGENT_STT_MODEL_ENV = "AGENT_GEMINI_STT_MODEL"
AGENT_TTS_MODEL_ENV = "AGENT_GEMINI_TTS_MODEL"
AGENT_TTS_VOICE_ENV = "AGENT_GEMINI_TTS_VOICE"
AGENT_TTS_MAX_ATTEMPTS_ENV = "AGENT_GEMINI_TTS_MAX_ATTEMPTS"
DEFAULT_AGENT_STT_MODEL = "gemini-2.5-flash"
DEFAULT_AGENT_TTS_MODEL = "gemini-2.5-flash-preview-tts"
DEFAULT_AGENT_TTS_VOICE = "Sulafat"
DEFAULT_AGENT_TTS_MAX_ATTEMPTS = 2

_TRANSCRIPTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "transcript": {"type": "STRING"},
        "uncertain": {"type": "BOOLEAN"},
        "reason": {"type": "STRING"},
    },
    "required": ["transcript", "uncertain"],
}

_TRANSCRIPTION_PROMPT = """Transcribe the user's speech exactly.

Return JSON only with:
- transcript: the clean text the user spoke.
- uncertain: true when there is no clear speech, heavy noise, or the words are not reliable.
- reason: a short reason when uncertain is true.

Do not answer the user. Do not summarize. Do not add punctuation unless it is obvious from the speech.
"""


@dataclass(frozen=True)
class AgentVoiceTranscription:
    transcript: str
    uncertain: bool
    reason: str | None
    model: str


@dataclass(frozen=True)
class AgentVoiceSynthesis:
    audio: bytes
    mime_type: str
    model: str
    voice: str


class AgentVoiceService:
    def __init__(self, *, model: str | None = None, tts_model: str | None = None):
        self.settings = get_core_security_settings()
        configured_model = model or os.getenv(AGENT_STT_MODEL_ENV, "").strip()
        self.model = configured_model or DEFAULT_AGENT_STT_MODEL
        configured_tts_model = tts_model or os.getenv(AGENT_TTS_MODEL_ENV, "").strip()
        self.tts_model = configured_tts_model or DEFAULT_AGENT_TTS_MODEL
        self.tts_default_voice = (
            os.getenv(AGENT_TTS_VOICE_ENV, "").strip() or DEFAULT_AGENT_TTS_VOICE
        )
        self.tts_max_attempts = _read_int_env(
            AGENT_TTS_MAX_ATTEMPTS_ENV,
            default=DEFAULT_AGENT_TTS_MAX_ATTEMPTS,
            minimum=1,
            maximum=4,
        )
        self.client: genai.Client | None = None
        self._client_error: str | None = None

        api_key = self.settings.google_api_key or os.getenv("GOOGLE_API_KEY", "").strip()
        if not api_key:
            self._client_error = "GOOGLE_API_KEY is not configured."
            logger.warning("Agent voice STT disabled: GOOGLE_API_KEY is not configured.")
            return

        try:
            self.client = genai.Client(api_key=api_key)
        except Exception as error:  # pragma: no cover - defensive SDK initialization guard
            self._client_error = str(error)
            logger.exception("Failed to initialize Gemini Agent voice client: %s", error)

    async def transcribe_audio(
        self,
        *,
        audio_bytes: bytes,
        mime_type: str,
    ) -> AgentVoiceTranscription:
        if not self.client:
            raise RuntimeError(self._client_error or "Gemini Agent voice client is unavailable.")
        if not audio_bytes:
            return AgentVoiceTranscription(
                transcript="",
                uncertain=True,
                reason="No audio was received.",
                model=self.model,
            )

        config = genai_types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=256,
            response_mime_type="application/json",
            response_schema=_TRANSCRIPTION_SCHEMA,
            automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
        )
        response = await self.client.aio.models.generate_content(
            model=self.model,
            contents=genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part.from_text(text=_TRANSCRIPTION_PROMPT),
                    genai_types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
                ],
            ),
            config=config,
        )
        return self._parse_transcription_response(response.text or "")

    async def synthesize_speech(
        self,
        *,
        text: str,
        voice: str | None = None,
    ) -> AgentVoiceSynthesis:
        if not self.client:
            raise RuntimeError(self._client_error or "Gemini Agent voice client is unavailable.")

        clean_text = " ".join(str(text or "").strip().split())
        if not clean_text:
            raise ValueError("Text is required for Agent voice TTS.")

        selected_voice = str(voice or "").strip() or self.tts_default_voice
        config = genai_types.GenerateContentConfig(
            temperature=0.7,
            response_modalities=["AUDIO"],
            speech_config=genai_types.SpeechConfig(
                voice_config=genai_types.VoiceConfig(
                    prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(
                        voice_name=selected_voice,
                    )
                )
            ),
            automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
        )
        audio = b""
        mime_type = ""
        last_error: Exception | None = None
        for attempt in range(1, self.tts_max_attempts + 1):
            try:
                response = await self.client.aio.models.generate_content(
                    model=self.tts_model,
                    contents=genai_types.Content(
                        role="user",
                        parts=[
                            genai_types.Part.from_text(
                                text=(
                                    "Synthesize speech for the Kai Agent.\n"
                                    "Read only the text under TRANSCRIPT.\n\n"
                                    "VOICE DIRECTION: warm, clear, concise, helpful.\n"
                                    f"TRANSCRIPT:\n{clean_text}"
                                )
                            )
                        ],
                    ),
                    config=config,
                )
                audio, mime_type = _extract_audio_part(response)
                if audio:
                    break
                last_error = RuntimeError("Gemini TTS response did not include audio.")
            except Exception as error:  # pragma: no cover - SDK transient behavior
                last_error = error

            if attempt < self.tts_max_attempts:
                await asyncio.sleep(0.15 * attempt)

        if not audio:
            raise RuntimeError("Gemini TTS response did not include audio.") from last_error
        audio, mime_type = _normalize_browser_audio(audio, mime_type)
        return AgentVoiceSynthesis(
            audio=audio,
            mime_type=mime_type,
            model=self.tts_model,
            voice=selected_voice,
        )

    def _parse_transcription_response(self, response_text: str) -> AgentVoiceTranscription:
        try:
            payload = json.loads(response_text)
        except json.JSONDecodeError:
            logger.warning("Agent voice STT returned non-JSON response.")
            return AgentVoiceTranscription(
                transcript=response_text.strip(),
                uncertain=True,
                reason="The transcription response was not structured.",
                model=self.model,
            )

        transcript = _clean_transcript(payload.get("transcript"))
        uncertain = bool(payload.get("uncertain"))
        reason = payload.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            reason = None

        if _is_clearly_uncertain_transcript(transcript):
            uncertain = True
            reason = reason or "The transcript was empty or too short."

        return AgentVoiceTranscription(
            transcript=transcript,
            uncertain=uncertain,
            reason=reason,
            model=self.model,
        )


def _clean_transcript(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())


def _is_clearly_uncertain_transcript(transcript: str) -> bool:
    if not transcript:
        return True
    alphanumeric_count = sum(1 for char in transcript if char.isalnum())
    return alphanumeric_count < 2


def _extract_audio_part(response: genai_types.GenerateContentResponse) -> tuple[bytes, str]:
    for candidate in response.candidates or []:
        content = candidate.content
        for part in content.parts if content and content.parts else []:
            inline_data = part.inline_data
            if inline_data and inline_data.data:
                return inline_data.data, inline_data.mime_type or "audio/wav"
    return b"", ""


def _normalize_browser_audio(audio: bytes, mime_type: str) -> tuple[bytes, str]:
    normalized = str(mime_type or "").strip().lower()
    if normalized.startswith("audio/l16") or normalized.startswith("audio/pcm"):
        return _wav_from_pcm(
            audio, sample_rate=_sample_rate_from_mime_type(normalized)
        ), "audio/wav"
    return audio, mime_type or "audio/wav"


def _sample_rate_from_mime_type(mime_type: str) -> int:
    match = re.search(r"(?:rate|sample_rate)=(\d+)", mime_type)
    if not match:
        return 24000
    try:
        return max(8000, min(192000, int(match.group(1))))
    except ValueError:
        return 24000


def _read_int_env(name: str, *, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _wav_from_pcm(pcm: bytes, *, sample_rate: int) -> bytes:
    channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    header = b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + len(pcm)),
            b"WAVEfmt ",
            struct.pack(
                "<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample
            ),
            b"data",
            struct.pack("<I", len(pcm)),
        ]
    )
    return header + pcm


_SERVICE: AgentVoiceService | None = None


def get_agent_voice_service() -> AgentVoiceService:
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = AgentVoiceService()
    return _SERVICE
