"""CWE-400 bounds tests for the canonical One Live voice relay."""

import base64

from api.routes.one.adk_live import (
    _MAX_BROWSER_FRAME_CHARS,
    _MAX_REALTIME_AUDIO_BYTES,
    _browser_frame_within_bounds,
    _decode_realtime_audio,
)
from api.routes.one.live_context import bounded_text


def test_live_browser_frames_have_an_application_bound():
    assert _browser_frame_within_bounds("A" * _MAX_BROWSER_FRAME_CHARS) is True
    assert _browser_frame_within_bounds("A" * (_MAX_BROWSER_FRAME_CHARS + 1)) is False


def test_live_audio_base64_is_strict_and_bounded():
    allowed = b"A" * _MAX_REALTIME_AUDIO_BYTES
    encoded = base64.b64encode(allowed).decode("ascii")

    assert _decode_realtime_audio(encoded) == allowed
    assert _decode_realtime_audio(base64.b64encode(allowed + b"A").decode("ascii")) is None
    assert _decode_realtime_audio("not-valid-base64!!!") is None


def test_live_text_fields_are_bounded_before_session_state():
    assert bounded_text("hello", 5) == "hello"
    assert bounded_text("A" * 513, 512) == "A" * 512
