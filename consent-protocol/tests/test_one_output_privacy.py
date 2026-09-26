"""Public-output privacy against the real AG-UI and provider message types."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from ag_ui.core import (
    BaseEvent,
    EventType,
    MessagesSnapshotEvent,
    ReasoningMessageContentEvent,
    RunErrorEvent,
    RunFinishedEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
)
from ag_ui_adk import ADKAgent
from google.adk.events import Event
from google.genai import types

from hushh_mcp.one_adk.agui_turn_timing import HEAD_INTRO, HEAD_ONE
from hushh_mcp.one_adk.output_privacy import public_event, public_text
from tests.test_agui_turn_timing import _agent, _input, _scripted_run


def test_approval_reference_never_enters_wire_state():
    key = "temp:hussh:mcp_approval"
    private = "one_secret_ref:private"
    snapshot = StateSnapshotEvent(snapshot={key: private, "visible": 1})
    assert public_event(snapshot).snapshot == {"visible": 1}
    assert snapshot.snapshot[key] == private
    event = StateDeltaEvent(
        delta=[
            {"op": "add", "path": "/" + key, "value": private},
            {"op": "copy", "from": "/" + key, "path": "/copied"},
            {"op": "replace", "path": "", "value": {key: private, "visible": 2}},
            {"op": "add", "path": "/visible", "value": 3},
        ]
    )
    projected = public_event(event)
    assert private not in projected.model_dump_json()
    assert len(projected.delta) == 2
    assert projected.delta[0]["value"] == {"visible": 2}
    assert event.delta[0]["value"] == private


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


def test_authenticated_chat_projects_only_bounded_summary_text():
    signature = "provider-continuation-signature"
    thought = ReasoningMessageContentEvent(
        message_id="r",
        delta="summary " * 400,
        metadata={"signature": signature},
        raw_event={"signature": signature},
    )
    assert public_event(thought) is None
    visible = public_event(thought, allow_thought_summary=True)
    assert isinstance(visible, ReasoningMessageContentEvent)
    assert visible.delta == thought.delta[:2048]
    assert visible.metadata == {"husshThoughtSummary": True}
    assert visible.raw_event is None
    assert signature not in visible.model_dump_json()
    assert thought.raw_event == {"signature": signature}


@pytest.mark.parametrize("head", [HEAD_ONE, HEAD_INTRO])
async def test_timed_adk_chat_streams_summary_only_for_authenticated_head(monkeypatch, head):
    summary = ReasoningMessageContentEvent(
        message_id="r",
        delta="Provider summary",
        raw_event={"signature": "secret"},
    )
    monkeypatch.setattr(ADKAgent, "run", _scripted_run([(0, summary)]))
    events = [event async for event in _agent(head).run(_input())]
    if head == HEAD_INTRO:
        assert events == []
    else:
        assert len(events) == 1
        assert events[0].delta == "Provider summary"
        assert "secret" not in events[0].model_dump_json()


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
    assert agent_chat._authenticated_capabilities["reasoning"] == {
        "supported": True,
        "streaming": True,
        "encrypted": False,
    }
    assert agent_chat._intro_capabilities["reasoning"] == {
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


@pytest.mark.parametrize("head", [HEAD_ONE, HEAD_INTRO])
async def test_bridge_error_message_and_code_never_reach_chat_wire(monkeypatch, head):
    secret = "private connector result and credential"
    original = RunErrorEvent(
        message=secret,
        code=secret,
        raw_event={"exception": secret},
    )
    monkeypatch.setattr(ADKAgent, "run", _scripted_run([(0, original)]))
    projected = [event async for event in _agent(head).run(_input())]
    assert len(projected) == 1
    assert projected[0].code == "AGENT_ERROR"
    assert secret not in projected[0].model_dump_json()
    assert original.message == secret


def test_one_builders_keep_reasoning_internal():
    from hushh_mcp.one_adk.agent_tree import build_one_intro_text_agent, build_one_text_agent

    for builder in (build_one_intro_text_agent, build_one_text_agent):
        assert (
            builder(model="gemini-test").generate_content_config.thinking_config.include_thoughts
            is False
        )
    assert (
        build_one_text_agent(
            model="gemini-test", include_thought_summaries=True
        ).generate_content_config.thinking_config.include_thoughts
        is True
    )


def _summary(message_id: str, delta: str):
    from ag_ui.core import ReasoningMessageContentEvent

    return ReasoningMessageContentEvent(message_id=message_id, delta=delta)


def test_summary_replay_from_the_final_aggregated_event_is_dropped():
    # Measured 2026-09-25: the partial event streamed a 231-char summary and the
    # final aggregated event replayed the same text under a new message id.
    from hushh_mcp.one_adk.output_privacy import ThoughtSummaryReplayFilter

    text = "**Clarifying My Role**\n\nI'm explaining what I can help with."
    replays = ThoughtSummaryReplayFilter()
    assert replays.admit(_summary("m1", text)) is True
    assert replays.admit(_summary("m2", text)) is False
    # Every later chunk of a suppressed replay stays suppressed.
    assert replays.admit(_summary("m2", " more")) is False


def test_summary_replay_of_several_streamed_messages_is_dropped():
    from hushh_mcp.one_adk.output_privacy import ThoughtSummaryReplayFilter

    replays = ThoughtSummaryReplayFilter()
    assert replays.admit(_summary("m1", "**First**\n\nOne. ")) is True
    assert replays.admit(_summary("m2", "**Second**\n\nTwo.")) is True
    assert replays.admit(_summary("m3", "**First**\n\nOne. **Second**\n\nTwo.")) is False


def test_genuine_streaming_pieces_are_never_dropped_as_substrings():
    from hushh_mcp.one_adk.output_privacy import ThoughtSummaryReplayFilter

    replays = ThoughtSummaryReplayFilter()
    assert replays.admit(_summary("m1", "**Checking the")) is True
    assert replays.admit(_summary("m1", " the connected file**")) is True
    # A new message whose first chunk is only a fragment of earlier text is new content.
    assert replays.admit(_summary("m2", "the")) is True
    assert replays.admit(_summary("m3", "**Next step**\n\nA different summary.")) is True


def test_replay_filter_admits_every_non_summary_event():
    from ag_ui.core import TextMessageContentEvent

    from hushh_mcp.one_adk.output_privacy import ThoughtSummaryReplayFilter

    replays = ThoughtSummaryReplayFilter()
    text_event = TextMessageContentEvent(message_id="t1", delta="Hello")
    assert replays.admit(text_event) is True
    assert replays.admit(TextMessageContentEvent(message_id="t2", delta="Hello")) is True


def test_empty_thought_part_is_dropped_from_the_outgoing_request_only():
    # Measured 2026-09-25: a stored model turn of [empty thought, answer, signature]
    # made every second turn fail with a provider 400.
    from google.genai import types as gtypes

    from hushh_mcp.one_adk.output_privacy import drop_empty_history_parts

    request = SimpleNamespace(
        contents=[
            gtypes.Content(role="user", parts=[gtypes.Part(text="hi")]),
            gtypes.Content(
                role="model",
                parts=[
                    gtypes.Part(text="", thought=True),
                    gtypes.Part(text="answer"),
                    gtypes.Part(text="", thought_signature=b"sig"),
                ],
            ),
            gtypes.Content(role="user", parts=[gtypes.Part(text="next")]),
        ]
    )
    assert drop_empty_history_parts(request) == 1
    model_parts = request.contents[1].parts
    assert [p.text for p in model_parts] == ["answer", ""]
    assert model_parts[1].thought_signature == b"sig"
    assert [c.role for c in request.contents] == ["user", "model", "user"]


def test_function_parts_and_text_are_never_dropped():
    from google.genai import types as gtypes

    from hushh_mcp.one_adk.output_privacy import drop_empty_history_parts

    call = gtypes.Part(function_call=gtypes.FunctionCall(name="x", args={}))
    reply = gtypes.Part(function_response=gtypes.FunctionResponse(name="x", response={}))
    request = SimpleNamespace(
        contents=[
            gtypes.Content(role="model", parts=[call]),
            gtypes.Content(role="user", parts=[reply]),
        ]
    )
    assert drop_empty_history_parts(request) == 0
    assert len(request.contents) == 2
