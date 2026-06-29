"""Tests for the provider-neutral voice transport contract."""

from __future__ import annotations

from hushh_mcp.services.agent_voice_service import AgentVoiceService
from hushh_mcp.services.voice_transport import (
    VoiceSynthesizer,
    VoiceTranscriber,
    select_voice_lane,
    speech_provider_for,
    supports_native_realtime,
)


def test_speech_provider_self_for_speech_capable_brains() -> None:
    assert speech_provider_for("gemini") == "gemini"
    assert speech_provider_for("openai") == "openai"


def test_speech_provider_falls_back_for_text_only_brains() -> None:
    # Anthropic and Grok have no native speech API -> borrow the default.
    assert speech_provider_for("anthropic") == "gemini"
    assert speech_provider_for("grok") == "gemini"
    assert speech_provider_for("anthropic", default="openai") == "openai"


def test_speech_provider_handles_aliases_and_unknowns() -> None:
    assert speech_provider_for("google") == "gemini"
    assert speech_provider_for("claude") == "gemini"
    assert speech_provider_for("xai") == "gemini"
    # Unknown / empty falls closed to the default speech provider.
    assert speech_provider_for(None) == "gemini"
    assert speech_provider_for("") == "gemini"
    assert speech_provider_for("totally-unknown") == "gemini"


def test_supports_native_realtime() -> None:
    assert supports_native_realtime("gemini") is True
    assert supports_native_realtime("openai") is True
    assert supports_native_realtime("anthropic") is False
    assert supports_native_realtime("grok") is False
    assert supports_native_realtime("nope") is False
    assert supports_native_realtime(None) is False


def test_select_voice_lane_realtime_only_when_enabled_and_capable() -> None:
    assert select_voice_lane("gemini", realtime_enabled=True) == "realtime"
    assert select_voice_lane("openai", realtime_enabled=True) == "realtime"
    # Realtime disabled -> always chained, even for capable brains.
    assert select_voice_lane("gemini", realtime_enabled=False) == "chained"
    # Capable provider but realtime off -> chained.
    assert select_voice_lane("openai", realtime_enabled=False) == "chained"


def test_select_voice_lane_text_only_brains_always_chained() -> None:
    assert select_voice_lane("anthropic", realtime_enabled=True) == "chained"
    assert select_voice_lane("grok", realtime_enabled=True) == "chained"
    assert select_voice_lane(None, realtime_enabled=True) == "chained"


def test_agent_voice_service_satisfies_transport_protocols() -> None:
    # The existing Gemini chained service must remain structurally compatible
    # with the neutral transport contract so callers can route by provider.
    service = AgentVoiceService.__new__(AgentVoiceService)
    assert isinstance(service, VoiceTranscriber)
    assert isinstance(service, VoiceSynthesizer)
