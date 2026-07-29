"""
Tests for AgentRealtimeSessionRequest field bounds.

Creating an OpenAI Realtime API session is expensive (billed per session).
Unbounded user_id / voice fields allow denial-of-wallet attacks via
oversized payloads.  These tests confirm that Pydantic rejects inputs that
exceed the declared limits before the request reaches the HTTP layer.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.agent_realtime import (
    _USER_ID_MAX_LEN,
    _VOICE_MAX_LEN,
    AgentRealtimeSessionRequest,
)

# ---------------------------------------------------------------------------
# user_id
# ---------------------------------------------------------------------------


def test_user_id_at_max_len_accepted():
    req = AgentRealtimeSessionRequest(user_id="a" * _USER_ID_MAX_LEN)
    assert len(req.user_id) == _USER_ID_MAX_LEN


def test_user_id_over_max_len_rejected():
    with pytest.raises(ValidationError):
        AgentRealtimeSessionRequest(user_id="a" * (_USER_ID_MAX_LEN + 1))


def test_user_id_empty_rejected():
    with pytest.raises(ValidationError):
        AgentRealtimeSessionRequest(user_id="")


def test_user_id_typical_value_accepted():
    req = AgentRealtimeSessionRequest(user_id="user_abc123")
    assert req.user_id == "user_abc123"


# ---------------------------------------------------------------------------
# voice (optional)
# ---------------------------------------------------------------------------


def test_voice_none_accepted():
    req = AgentRealtimeSessionRequest(user_id="uid1", voice=None)
    assert req.voice is None


def test_voice_omitted_defaults_to_none():
    req = AgentRealtimeSessionRequest(user_id="uid1")
    assert req.voice is None


def test_voice_at_max_len_accepted():
    req = AgentRealtimeSessionRequest(user_id="uid1", voice="v" * _VOICE_MAX_LEN)
    assert len(req.voice) == _VOICE_MAX_LEN


def test_voice_over_max_len_rejected():
    with pytest.raises(ValidationError):
        AgentRealtimeSessionRequest(user_id="uid1", voice="v" * (_VOICE_MAX_LEN + 1))


def test_voice_known_values_accepted():
    for voice_name in ("alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"):
        req = AgentRealtimeSessionRequest(user_id="uid1", voice=voice_name)
        assert req.voice == voice_name
