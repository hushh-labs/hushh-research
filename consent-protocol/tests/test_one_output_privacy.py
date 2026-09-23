"""Public-output privacy against the real AG-UI and provider message types."""

from __future__ import annotations

import pytest
from ag_ui.core import (
    BaseEvent,
    EventType,
    MessagesSnapshotEvent,
    RunFinishedEvent,
    TextMessageContentEvent,
)
from ag_ui_adk import ADKAgent
from google.adk.events import Event
from google.genai import types

from hushh_mcp.one_adk.agui_turn_timing import HEAD_INTRO, HEAD_ONE
from hushh_mcp.one_adk.output_privacy import public_event, public_text
from tests.test_agui_turn_timing import _agent, _input, _scripted_run


@pytest.mark.parametrize("head", [HEAD_ONE, HEAD_INTRO])
@pytest.mark.parametrize(
    "kind", [kind for kind in EventType if kind.value.startswith("REASONING_")]
)
async def test_both_heads_suppress_every_reasoning_event(monkeypatch, head, kind):
    answer = TextMessageContentEvent(message_id="a", delta="Visible answer")
    finish = RunFinishedEvent(thread_id="thread", run_id="run")
    thought = BaseEvent(type=kind, raw_event={"thought": "private reasoning"})
    monkeypatch.setattr(ADKAgent, "run", _scripted_run([(0, thought), (0, answer), (0, finish)]))
    assert [event async for event in _agent(head).run(_input())] == [answer, finish]
    assert thought.raw_event == {"thought": "private reasoning"}


def test_snapshot_filters_reasoning_without_mutating_history_or_tool_pairing():
    event = MessagesSnapshotEvent(
        messages=[
            {"id": "u", "role": "user", "content": "Find my file"},
            {"id": "r", "role": "reasoning", "content": "Private reasoning"},
            {
                "id": "a",
                "role": "assistant",
                "content": "Found a file",
                "toolCalls": [
                    {
                        "id": "call",
                        "type": "function",
                        "function": {"name": "search_files", "arguments": "{}"},
                    }
                ],
            },
            {"id": "t", "role": "tool", "toolCallId": "call", "content": "{}"},
        ],
        raw_event={"thought": "Private reasoning"},
    )
    original = event.model_dump()
    projected = public_event(event)
    assert projected is not event
    assert [message.role for message in projected.messages] == ["user", "assistant", "tool"]
    assert projected.messages[1].tool_calls[0].id == projected.messages[2].tool_call_id
    assert projected.raw_event is None
    assert event.model_dump() == original


def test_public_text_hides_thoughts_but_preserves_opaque_signature():
    signature = b"provider-continuation-signature"
    event = Event(
        author="one",
        content=types.Content(
            role="model",
            parts=[
                types.Part(text="Private reasoning", thought=True, thought_signature=signature),
                types.Part(text="Visible answer", thought_signature=signature),
            ],
        ),
    )
    assert public_text(event) == "Visible answer"
    assert event.content.parts[0].thought_signature == signature
    assert event.content.parts[1].thought_signature == signature


def test_history_and_both_capabilities_follow_public_policy():
    from api.routes.one import agent_chat

    event = Event(
        author="one",
        content=types.Content(
            role="model",
            parts=[
                types.Part(text="Private reasoning", thought=True),
            ],
        ),
    )
    assert agent_chat._event_text(event) == ""
    for capabilities in (agent_chat._authenticated_capabilities, agent_chat._intro_capabilities):
        assert capabilities["reasoning"] == {
            "supported": False,
            "streaming": False,
            "encrypted": False,
        }


def test_raw_provider_event_is_not_a_secondary_reasoning_channel():
    event = TextMessageContentEvent(
        message_id="a", delta="Visible answer", raw_event={"thought": "private"}
    )
    assert public_event(event).raw_event is None
    assert event.raw_event == {"thought": "private"}


def test_one_builders_keep_reasoning_internal():
    from hushh_mcp.one_adk.agent_tree import build_one_intro_text_agent, build_one_text_agent

    for builder in (build_one_intro_text_agent, build_one_text_agent):
        assert (
            builder(model="gemini-test").generate_content_config.thinking_config.include_thoughts
            is False
        )
