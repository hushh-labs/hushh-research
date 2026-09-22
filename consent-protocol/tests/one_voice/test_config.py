"""ONE_VOICE_LIVE_ENABLED / VERTEX_LIVE_MODEL_ID / VERTEX_LIVE_LOCATION contract."""

from __future__ import annotations

import pytest

from hushh_mcp.one_voice.config import (
    ONE_VOICE_LIVE_ENABLED_ENV,
    VERTEX_LIVE_LOCATION_ENV,
    VERTEX_LIVE_MODEL_ID_ENV,
    OneVoiceConfigError,
    OneVoiceLiveConfig,
    live_voice_enabled,
)


def test_flag_off_never_reads_the_model_contract(monkeypatch):
    monkeypatch.delenv(ONE_VOICE_LIVE_ENABLED_ENV, raising=False)
    monkeypatch.delenv(VERTEX_LIVE_MODEL_ID_ENV, raising=False)
    monkeypatch.delenv(VERTEX_LIVE_LOCATION_ENV, raising=False)
    config = OneVoiceLiveConfig.from_environment()
    assert config.enabled is False
    assert config.model_id == ""
    assert live_voice_enabled() is False


def test_flag_on_requires_an_explicit_model_id(monkeypatch):
    monkeypatch.setenv(ONE_VOICE_LIVE_ENABLED_ENV, "true")
    monkeypatch.delenv(VERTEX_LIVE_MODEL_ID_ENV, raising=False)
    monkeypatch.setenv(VERTEX_LIVE_LOCATION_ENV, "us-central1")
    with pytest.raises(OneVoiceConfigError, match=VERTEX_LIVE_MODEL_ID_ENV):
        OneVoiceLiveConfig.from_environment()


@pytest.mark.parametrize("location", ["", "global", "us", "eu", "US-CENTRAL1!"])
def test_flag_on_rejects_non_regional_locations(monkeypatch, location):
    monkeypatch.setenv(ONE_VOICE_LIVE_ENABLED_ENV, "true")
    monkeypatch.setenv(VERTEX_LIVE_MODEL_ID_ENV, "gemini-live-2.5-flash-native-audio")
    monkeypatch.setenv(VERTEX_LIVE_LOCATION_ENV, location)
    with pytest.raises(OneVoiceConfigError, match=VERTEX_LIVE_LOCATION_ENV):
        OneVoiceLiveConfig.from_environment()


def test_flag_on_reads_the_pinned_contract(monkeypatch):
    monkeypatch.setenv(ONE_VOICE_LIVE_ENABLED_ENV, "true")
    monkeypatch.setenv(VERTEX_LIVE_MODEL_ID_ENV, "gemini-live-2.5-flash-native-audio")
    monkeypatch.setenv(VERTEX_LIVE_LOCATION_ENV, "US-Central1")
    monkeypatch.setenv("ONE_VOICE_SESSION_MAX_MINUTES", "10")
    config = OneVoiceLiveConfig.from_environment()
    assert config.enabled is True
    assert config.model_id == "gemini-live-2.5-flash-native-audio"
    assert config.location == "us-central1"
    assert config.session_max_seconds == 600
    assert config.idle_close_seconds == 90


def test_limits_must_be_positive_integers(monkeypatch):
    monkeypatch.setenv(ONE_VOICE_LIVE_ENABLED_ENV, "true")
    monkeypatch.setenv(VERTEX_LIVE_MODEL_ID_ENV, "gemini-live-2.5-flash-native-audio")
    monkeypatch.setenv(VERTEX_LIVE_LOCATION_ENV, "us-central1")
    monkeypatch.setenv("ONE_VOICE_IDLE_CLOSE_SECONDS", "0")
    with pytest.raises(OneVoiceConfigError, match="ONE_VOICE_IDLE_CLOSE_SECONDS"):
        OneVoiceLiveConfig.from_environment()
