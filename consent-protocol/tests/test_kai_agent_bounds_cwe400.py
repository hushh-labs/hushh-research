"""Bounded context remains shared by commands and text chat."""

from api.routes.one.live_context import bounded_text


def test_live_text_fields_are_bounded_before_session_state():
    assert bounded_text("hello", 5) == "hello"
    assert bounded_text("A" * 513, 512) == "A" * 512
