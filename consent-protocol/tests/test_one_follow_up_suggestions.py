"""Smart follow-ups ride on One's answer: one model call per turn, never a second.

The production One text agent runs through the real AG-UI bridge (the same
construction as Agent Chat and the startup warmup) against a scripted model, so
the model call count is measured, not assumed.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.agent_tree import _SPECIALIST_MODEL, build_one_text_agent
from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent
from hushh_mcp.one_adk.consent_continuation import STATE_CONSENT_CONTINUATION
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE, STATE_EXTERNAL_READ
from hushh_mcp.one_adk.follow_up_suggestions import (
    FOLLOW_UP_INSTRUCTION,
    FOLLOW_UP_TOOL_NAME,
    normalize_follow_ups,
    suggest_follow_ups,
)
from hushh_mcp.one_adk.turn_completion import newest_turn_answered

ANSWER = "You have standup at 9 and a design review at 2."
SUGGESTIONS = ["Find a free hour after my 2pm", "Move standup to 9:30"]


def _follow_ups(suggestions: list[str] = SUGGESTIONS) -> types.Part:
    return types.Part(
        function_call=types.FunctionCall(
            name=FOLLOW_UP_TOOL_NAME, args={"suggestions": suggestions}
        )
    )


class _ScriptedLlm(BaseLlm):
    """Answers each model call with the next scripted response; counts calls."""

    script: list[list[types.Part]]
    calls: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        del llm_request, stream
        parts = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        yield LlmResponse(content=types.Content(role="model", parts=parts))


async def _run_turn(script: list[list[types.Part]], *, surface: str = "typed_chat"):
    model = _ScriptedLlm(model=_SPECIALIST_MODEL, script=script)
    sessions = InMemorySessionService()
    agent = TimedADKAgent.from_app(
        App(
            name="one_follow_ups",
            root_agent=build_one_text_agent(
                model=model, allow_workspace_tools=True, include_thought_summaries=True
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        head=HEAD_ONE,
        user_id_extractor=lambda _input: "owner",
        session_service=sessions,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    run = RunAgentInput(
        thread_id="thread",
        run_id="run",
        state={STATE_EXECUTION_SURFACE: surface},
        context=[],
        forwarded_props={},
        messages=[UserMessage(id="m-1", role="user", content="What is on tomorrow?")],
        tools=[],
    )
    events = [event async for event in agent.run(run)]
    session = await sessions.get_session(
        app_name="one_follow_ups", user_id="owner", session_id="thread"
    )
    return model, events, session


def _results(events) -> list[dict]:
    names = {
        event.tool_call_id: event.tool_call_name
        for event in events
        if event.type == EventType.TOOL_CALL_START
    }
    return [
        json.loads(event.content)
        for event in events
        if event.type == EventType.TOOL_CALL_RESULT
        and names.get(event.tool_call_id) == FOLLOW_UP_TOOL_NAME
    ]


def _text(events) -> str:
    return "".join(event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT)


@pytest.mark.asyncio
async def test_follow_ups_end_the_turn_in_the_same_model_call():
    model, events, session = await _run_turn([[types.Part(text=ANSWER), _follow_ups()]])

    assert model.calls == 1
    assert _text(events) == ANSWER
    assert _results(events) == [{"status": "shown", "suggestions": SUGGESTIONS}]
    assert str(events[-1].type).endswith("RUN_FINISHED")
    # The detached-turn push still sees an answered turn.
    assert newest_turn_answered(session.events)


@pytest.mark.asyncio
async def test_negative_control_an_ordinary_tool_costs_a_second_model_call():
    """Without the skip, ADK asks the model again after any tool result."""
    clock = types.Part(function_call=types.FunctionCall(name="get_current_time", args={}))
    model, events, _ = await _run_turn([[types.Part(text=ANSWER), clock], [types.Part(text="ok")]])

    assert model.calls == 2
    assert _results(events) == []


@pytest.mark.asyncio
async def test_follow_ups_without_an_answer_never_end_the_turn_silently():
    model, events, _ = await _run_turn([[_follow_ups()], [types.Part(text=ANSWER)]])

    assert model.calls == 2
    assert _text(events) == ANSWER
    assert _results(events) == [{"status": "ignored", "reason": "call_alone_after_your_answer"}]


@pytest.mark.asyncio
async def test_parallel_follow_ups_never_drop_another_tools_summary():
    clock = types.Part(function_call=types.FunctionCall(name="get_current_time", args={}))
    model, events, _ = await _run_turn(
        [[types.Part(text="Checking."), clock, _follow_ups()], [types.Part(text=ANSWER)]]
    )

    assert model.calls == 2
    assert _text(events).endswith(ANSWER)
    assert _results(events) == [{"status": "ignored", "reason": "call_alone_after_your_answer"}]


@pytest.mark.asyncio
async def test_follow_ups_are_typed_chat_only():
    model, events, _ = await _run_turn(
        [[types.Part(text=ANSWER), _follow_ups()], [types.Part(text="ok")]], surface="voice"
    )

    assert model.calls == 2
    assert _results(events) == [{"status": "unavailable"}]


def test_follow_ups_are_on_the_roster_with_the_rule_in_typed_chat_only():
    roster = agent_tree._one_roster_tools(specialist_model="test-model")
    assert suggest_follow_ups in roster

    class _Context:
        def __init__(self, surface: str) -> None:
            self.state = {STATE_EXECUTION_SURFACE: surface}

    assert FOLLOW_UP_INSTRUCTION in agent_tree._one_runtime_instruction(_Context("typed_chat"))
    assert FOLLOW_UP_INSTRUCTION not in agent_tree._one_runtime_instruction(_Context("voice"))
    for rule in ("suggest_follow_ups", "Do not call it on most turns", "greetings", "consent"):
        assert rule in FOLLOW_UP_INSTRUCTION


def test_follow_ups_pass_the_post_read_barrier_and_a_consent_answer():
    """They read and act on nothing; a same-named tool gets no exemption."""

    class _Tool:
        def __init__(self, func) -> None:
            self.func = func
            self.name = FOLLOW_UP_TOOL_NAME

    class _Context:
        invocation_id = "turn"
        user_id = "owner"
        state = {STATE_EXECUTION_SURFACE: "typed_chat", STATE_EXTERNAL_READ: "turn"}

    assert agent_tree._before_one_tool(_Tool(suggest_follow_ups), {}, _Context()) is None

    async def impostor() -> dict:
        return {}

    blocked = agent_tree._before_one_tool(_Tool(impostor), {}, _Context())
    assert blocked["reason"] == "connector_read_complete"

    class _AnswerContext:
        invocation_id = "turn"
        user_id = "owner"
        session = None
        state = {
            STATE_EXECUTION_SURFACE: "typed_chat",
            STATE_CONSENT_CONTINUATION: {"bundleId": "b", "outcome": "granted"},
        }

    # A consent answer admits One's own chips (they end the turn in the same
    # model call) and nothing else, whatever it is named.
    assert agent_tree._before_one_tool(_Tool(suggest_follow_ups), {}, _AnswerContext()) is None
    refused = agent_tree._before_one_tool(_Tool(impostor), {}, _AnswerContext())
    assert refused["reason"] == "consent_answer_turn"


def test_suggestions_are_bounded_single_line_and_distinct():
    long = "x" * 81
    assert normalize_follow_ups(
        ["  Find\na  slot ", "find a slot", long, 7, "Draft a reply", "Show more", "Fourth"]
    ) == ["Find a slot", "Draft a reply", "Show more"]
    assert normalize_follow_ups("Find a slot") == []
