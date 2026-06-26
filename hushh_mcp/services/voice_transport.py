"""Provider-neutral voice transport contract.

The Agent brain stays text-only; voice is swappable transport (audio in ->
transcript text, response text -> audio out). Two transport implementations
already exist: the Gemini chained path (``AgentVoiceService``) and the OpenAI
path (in ``voice_intent_service``). This module declares the single structural
contract both satisfy so callers can route by provider behind the existing
voice endpoints instead of branching on provider or adding a parallel path.

This is intentionally additive: it documents and types the existing seam. It
does not introduce a new microphone, STT, or TTS surface -- per
kai-voice-governance, any new voice capability must be an adapter over the
existing gateway.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from hushh_mcp.runtime_providers.registry import ProviderId, normalize_provider


@runtime_checkable
class VoiceTranscriber(Protocol):
    """Audio -> transcript text. Matches ``AgentVoiceService.transcribe_audio``."""

    async def transcribe_audio(self, *, audio_bytes: bytes, mime_type: str): ...


@runtime_checkable
class VoiceSynthesizer(Protocol):
    """Response text -> audio. Matches ``AgentVoiceService.synthesize_speech``."""

    async def synthesize_speech(self, *, text: str, voice: str | None = None): ...


# Which provider backs the chained STT/TTS transport. Gemini and OpenAI are the
# two implemented chained transports today; Anthropic and Grok have no native
# speech APIs, so they always borrow a speech-capable provider for the audio
# legs while keeping their own brain.
CHAINED_SPEECH_PROVIDERS: tuple[ProviderId, ...] = ("gemini", "openai")

# Providers that expose a native full-duplex realtime audio API.
NATIVE_REALTIME_PROVIDERS: tuple[ProviderId, ...] = ("gemini", "openai")


def supports_native_realtime(provider: str | None) -> bool:
    try:
        return normalize_provider(provider) in NATIVE_REALTIME_PROVIDERS
    except ValueError:
        return False


def speech_provider_for(
    brain_provider: str | None, *, default: ProviderId = "gemini"
) -> ProviderId:
    """Pick the speech (STT/TTS) provider for a given brain provider.

    Speech-capable brains use themselves for the audio legs. Brains without a
    native speech API (Anthropic, Grok) fall back to the configured default
    speech provider so the chained lane still works.
    """

    try:
        brain = normalize_provider(brain_provider)
    except ValueError:
        return default
    if brain in CHAINED_SPEECH_PROVIDERS:
        return brain
    return default


def select_voice_lane(brain_provider: str | None, *, realtime_enabled: bool) -> str:
    """Return the voice lane id for a brain provider.

    * ``"realtime"`` when the brain has a native realtime API and realtime is
      enabled by rollout/killswitch.
    * ``"chained"`` otherwise (STT -> brain -> TTS), which always works.
    """

    if realtime_enabled and supports_native_realtime(brain_provider):
        return "realtime"
    return "chained"
