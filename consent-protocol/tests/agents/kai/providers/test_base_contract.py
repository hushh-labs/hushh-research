# tests/agents/kai/providers/test_base_contract.py
"""Provider ABC and dataclass invariants."""

from __future__ import annotations

import pytest

from hushh_mcp.operons.kai.providers import (
    CompletionRequest,
    CompletionResponse,
    LLMProvider,
    Message,
    Role,
    StreamEvent,
)


def test_completion_request_synthesizes_messages_when_empty():
    req = CompletionRequest(prompt="hello", system_instruction="be terse")
    msgs = req.synthesized_messages()
    assert len(msgs) == 2
    assert msgs[0].role == Role.SYSTEM
    assert msgs[0].content == "be terse"
    assert msgs[1].role == Role.USER
    assert msgs[1].content == "hello"


def test_completion_request_preserves_explicit_messages():
    explicit = (
        Message(role=Role.USER, content="q1"),
        Message(role=Role.ASSISTANT, content="a1"),
        Message(role=Role.USER, content="q2"),
    )
    req = CompletionRequest(prompt="ignored", messages=explicit)
    out = req.synthesized_messages()
    assert out == explicit


def test_completion_request_no_system_no_messages_yields_user_only():
    req = CompletionRequest(prompt="hi")
    msgs = req.synthesized_messages()
    assert len(msgs) == 1
    assert msgs[0].role == Role.USER


def test_completion_request_empty_prompt_yields_empty_messages():
    req = CompletionRequest()
    assert req.synthesized_messages() == ()


def test_completion_response_default_usage_is_empty_mapping():
    resp = CompletionResponse(text="hi", provider="x", model="y")
    assert resp.usage == {}


def test_provider_abc_cannot_instantiate():
    with pytest.raises(TypeError):
        LLMProvider()  # type: ignore[abstract]


def test_stream_event_default_metadata():
    e = StreamEvent(type="token", text="hi")
    assert e.metadata == {}


def test_role_enum_values():
    assert Role.SYSTEM.value == "system"
    assert Role.USER.value == "user"
    assert Role.ASSISTANT.value == "assistant"
