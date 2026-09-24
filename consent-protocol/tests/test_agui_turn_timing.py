"""Turn timing on the canonical AG-UI agent-chat transport.

Offline: ``ADKAgent.run`` is replaced with a scripted event generator, so no
model, session store or network is touched. The assertions cover the measured
latencies, the three outcomes, the privacy of the log line and the wiring of
both route heads.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncGenerator
from types import SimpleNamespace

import pytest
from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    UserMessage,
)
from ag_ui_adk import ADKAgent

from hushh_mcp.one_adk import agui_turn_timing
from hushh_mcp.one_adk.agui_turn_timing import (
    HEAD_INTRO,
    HEAD_ONE,
    OUTCOME_CLIENT_DISCONNECT,
    OUTCOME_ERROR,
    OUTCOME_FINISHED,
    TimedADKAgent,
)

LOGGER_NAME = agui_turn_timing.logger.name
LINE_PREFIX = "one_agent_chat_turn_complete "

THREAD_ID = "thread-9f3c2a7e-secret-thread"
RUN_ID = "run-0123456789abcdef"
USER_ID = "user-7d1a-secret-owner"
MESSAGE_TEXT = "my private note about the holdings"


def _input() -> RunAgentInput:
    return RunAgentInput(
        thread_id=THREAD_ID,
        run_id=RUN_ID,
        state={"user_id": USER_ID, "hushh_pkm": "sealed"},
        messages=[UserMessage(id="m-1", role="user", content=MESSAGE_TEXT)],
        tools=[],
        context=[],
        forwarded_props={},
    )


def _agent(head: str = HEAD_ONE) -> TimedADKAgent:
    # ``run`` is patched in every test, so the constructor's collaborators are
    # never exercised. Skipping ``__init__`` keeps the fixture offline and fast.
    agent = TimedADKAgent.__new__(TimedADKAgent)
    agent.head = head
    return agent


def _scripted_run(events: list[tuple[float, BaseEvent]]):
    async def run(self: ADKAgent, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        for delay_s, event in events:
            if delay_s:
                await asyncio.sleep(delay_s)
            yield event

    return run


def _normal_script() -> list[tuple[float, BaseEvent]]:
    return [
        (0.0, RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)),
        (0.03, TextMessageContentEvent(message_id="a-1", delta=MESSAGE_TEXT)),
        (0.0, ToolCallStartEvent(tool_call_id="t-1", tool_call_name="ask_finance_specialist")),
        (0.0, ToolCallStartEvent(tool_call_id="t-2", tool_call_name="navigate_to_screen")),
        (0.0, CustomEvent(name="hussh:directive", value={"screen": "home"})),
        (0.02, RunFinishedEvent(thread_id=THREAD_ID, run_id=RUN_ID)),
    ]


def _timing_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == LOGGER_NAME and record.getMessage().startswith(LINE_PREFIX)
    ]


def _fields(line: str) -> dict[str, str]:
    return dict(re.findall(r"(\w+)=(\S+)", line[len(LINE_PREFIX) :]))


async def _drain(agent: TimedADKAgent) -> list[BaseEvent]:
    return [event async for event in agent.run(_input())]


@pytest.mark.asyncio
async def test_measures_first_visible_and_elapsed_and_counts(monkeypatch, caplog):
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(_normal_script()))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    events = await _drain(_agent())

    assert len(events) == 6, "the wrapper must pass every event through unchanged"
    lines = _timing_lines(caplog)
    assert len(lines) == 1, "exactly one timing line per turn"
    fields = _fields(lines[0])
    assert fields["head"] == HEAD_ONE
    assert fields["run"] == RUN_ID[:8]
    assert int(fields["first_visible_ms"]) >= 25
    assert int(fields["first_answer_token_ms"]) >= 25
    assert int(fields["first_tool_call_ms"]) >= int(fields["first_answer_token_ms"])
    assert fields["first_activity_ms"] == "None"
    assert int(fields["elapsed_ms"]) >= int(fields["first_visible_ms"])
    assert fields["events"] == "6"
    assert fields["tool_calls"] == "2"
    assert fields["specialist_calls"] == "1"
    assert fields["outcome"] == OUTCOME_FINISHED


@pytest.mark.asyncio
async def test_log_line_carries_no_identifying_records(monkeypatch, caplog):
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(_normal_script()))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    await _drain(_agent())

    line = _timing_lines(caplog)[0]
    assert MESSAGE_TEXT not in line


def test_model_callback_times_provider_and_keeps_prompt_text_out_of_logs(monkeypatch, caplog):
    monkeypatch.setenv("HUSHH_ONE_CHAT_TIMING_DETAIL", "1")
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    timing = agui_turn_timing.TurnTiming(
        head=HEAD_ONE, run="timing01", started_at=time.perf_counter()
    )
    token = agui_turn_timing._CURRENT_TURN.set(timing)
    request = SimpleNamespace(
        model="gemini-3.8-flash",
        config=SimpleNamespace(
            system_instruction="private system instruction",
            thinking_config=SimpleNamespace(thinking_level=SimpleNamespace(value="LOW")),
            tools=[{"name": "safe_tool_schema"}],
        ),
        contents=[SimpleNamespace(parts=[SimpleNamespace(text="private request text")])],
    )
    barrier_calls = []
    monkeypatch.setattr(
        agui_turn_timing,
        "before_external_read_model",
        lambda context, llm_request: barrier_calls.append((context, llm_request)),
    )
    try:
        agui_turn_timing.timed_one_before_model(object(), request)
        time.sleep(0.01)
        agui_turn_timing.timed_one_after_model(object(), object())
    finally:
        agui_turn_timing._CURRENT_TURN.reset(token)

    assert len(barrier_calls) == 1
    assert timing.model_calls == 1
    assert timing.model_call_total_ms >= 5
    assert timing.prompt_chars_peak == len("private system instructionprivate request text")
    assert timing.tool_schema_chars_peak == len(repr(request.config.tools))
    assert timing.history_items_peak == 1

    timing.log()
    line = _timing_lines(caplog)[-1]
    assert "model_calls=1" in line
    assert "model_id=gemini-3.8-flash" in line
    assert "thinking_level=LOW" in line
    assert "private system instruction" not in line
    assert "private request text" not in line
    assert THREAD_ID not in line
    assert USER_ID not in line
    assert RUN_ID not in line, "only the eight-character run label may appear"
    assert "sealed" not in line, "state values never reach the log"


@pytest.mark.asyncio
async def test_drive_tool_arguments_and_result_do_not_stream(monkeypatch):
    private_value = "PRIVATE_DRIVE_SENTINEL"
    script = [
        (0.0, ToolCallStartEvent(tool_call_id="drive-1", tool_call_name="read_google_drive")),
        (0.0, ToolCallArgsEvent(tool_call_id="drive-1", delta=private_value)),
        (
            0.0,
            ToolCallResultEvent(
                message_id="result-1",
                tool_call_id="drive-1",
                content='{"source":"google_drive_mcp","result":"PRIVATE_DRIVE_SENTINEL"}',
            ),
        ),
    ]
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(script))
    events = await _drain(_agent())
    assert len(events) == 2
    assert private_value not in "".join(event.model_dump_json() for event in events)


@pytest.mark.asyncio
async def test_run_error_event_marks_outcome_error(monkeypatch, caplog):
    script = [
        (0.0, RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)),
        (0.0, RunErrorEvent(message="model unavailable", code="MODEL_ERROR")),
    ]
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(script))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    await _drain(_agent(HEAD_INTRO))

    fields = _fields(_timing_lines(caplog)[0])
    assert fields["head"] == HEAD_INTRO
    assert fields["outcome"] == OUTCOME_ERROR
    assert fields["first_visible_ms"] == "None"
    assert fields["events"] == "2"


@pytest.mark.asyncio
async def test_escaped_exception_marks_outcome_error_and_reraises(monkeypatch, caplog):
    async def failing_run(self: ADKAgent, input: RunAgentInput):
        yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
        raise RuntimeError("runner exploded")

    monkeypatch.setattr(ADKAgent, "run", failing_run)
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    with pytest.raises(RuntimeError):
        await _drain(_agent())

    assert _fields(_timing_lines(caplog)[0])["outcome"] == OUTCOME_ERROR


@pytest.mark.asyncio
async def test_consumer_closing_early_marks_client_disconnect(monkeypatch, caplog):
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(_normal_script()))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    stream = _agent().run(_input())
    first = await stream.__anext__()
    assert first.type == "RUN_STARTED"
    await stream.aclose()

    lines = _timing_lines(caplog)
    assert len(lines) == 1
    fields = _fields(lines[0])
    assert fields["outcome"] == OUTCOME_CLIENT_DISCONNECT
    assert fields["events"] == "1"


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_error", [False, True])
@pytest.mark.parametrize("close_kind", ["close", "cancel"])
async def test_terminal_event_preserves_outcome_when_consumer_closes(
    monkeypatch,
    caplog,
    terminal_error,
    close_kind,
):
    terminal = (
        RunErrorEvent(message="private error", code="MODEL_ERROR")
        if terminal_error
        else RunFinishedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
    )
    monkeypatch.setattr(ADKAgent, "run", _scripted_run([(0.0, terminal)]))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    agent = _agent_with_registry()
    stream = agent.run(_input())
    assert await anext(stream) is terminal
    if close_kind == "close":
        await stream.aclose()
    else:
        with pytest.raises(asyncio.CancelledError):
            await stream.athrow(asyncio.CancelledError())
    lines = _timing_lines(caplog)
    assert len(lines) == 1
    assert _fields(lines[0])["outcome"] == (OUTCOME_ERROR if terminal_error else OUTCOME_FINISHED)
    # This change only corrects telemetry; interrupted execution cleanup stays
    # identical even when the client has already received a terminal event.
    assert (THREAD_ID, USER_ID) not in agent._active_executions


@pytest.mark.asyncio
async def test_error_terminal_is_not_overwritten_by_later_finished_event(monkeypatch, caplog):
    monkeypatch.setattr(
        ADKAgent,
        "run",
        _scripted_run(
            [
                (0.0, RunErrorEvent(message="private", code="MODEL_ERROR")),
                (0.0, RunFinishedEvent(thread_id=THREAD_ID, run_id=RUN_ID)),
            ]
        ),
    )
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    await _drain(_agent())
    assert _fields(_timing_lines(caplog)[0])["outcome"] == OUTCOME_ERROR


@pytest.mark.asyncio
async def test_task_cancellation_marks_client_disconnect(monkeypatch, caplog):
    started = asyncio.Event()

    async def slow_run(self: ADKAgent, input: RunAgentInput):
        yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
        started.set()
        await asyncio.sleep(10)
        yield RunFinishedEvent(thread_id=THREAD_ID, run_id=RUN_ID)

    monkeypatch.setattr(ADKAgent, "run", slow_run)
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    task = asyncio.create_task(_drain(_agent()))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert _fields(_timing_lines(caplog)[0])["outcome"] == OUTCOME_CLIENT_DISCONNECT


def test_agent_chat_route_builds_timed_agents_for_both_heads():
    from api.routes.one import agent_chat

    assert isinstance(agent_chat._agent, TimedADKAgent)
    assert agent_chat._agent.head == HEAD_ONE
    assert isinstance(agent_chat._intro_agent, TimedADKAgent)
    assert agent_chat._intro_agent.head == HEAD_INTRO
    assert agent_chat._agent is not agent_chat._intro_agent


def _agent_with_registry(head: str = HEAD_ONE) -> TimedADKAgent:
    agent = _agent(head)
    agent._active_executions = {(THREAD_ID, USER_ID): object()}
    agent._execution_lock = asyncio.Lock()
    agent._get_user_id = lambda input_data: USER_ID  # type: ignore[method-assign]
    return agent


async def test_errored_run_releases_its_execution_slot(monkeypatch, caplog):
    script = [
        (0.0, RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)),
        (0.0, RunErrorEvent(message="deadline expired", code="EXECUTION_ERROR")),
    ]
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(script))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    agent = _agent_with_registry()

    await _drain(agent)

    assert (THREAD_ID, USER_ID) not in agent._active_executions
    assert _fields(_timing_lines(caplog)[0])["outcome"] == OUTCOME_ERROR


async def test_finished_run_leaves_the_bridge_registry_alone(monkeypatch, caplog):
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(_normal_script()))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    agent = _agent_with_registry()

    await _drain(agent)

    # A finished run may legitimately keep its execution for a HITL resume;
    # only the bridge decides that, never the timing wrapper.
    assert (THREAD_ID, USER_ID) in agent._active_executions


async def test_client_disconnect_releases_its_execution_slot(monkeypatch, caplog):
    async def stalling_run(self: ADKAgent, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
        await asyncio.sleep(10)
        yield RunFinishedEvent(thread_id=THREAD_ID, run_id=RUN_ID)

    monkeypatch.setattr(ADKAgent, "run", stalling_run)
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    agent = _agent_with_registry()
    stream = agent.run(_input())
    await stream.__anext__()
    await stream.aclose()

    assert (THREAD_ID, USER_ID) not in agent._active_executions
    assert _fields(_timing_lines(caplog)[0])["outcome"] == OUTCOME_CLIENT_DISCONNECT


def test_agent_chat_route_bounds_the_execution_registry():
    from api.routes.one import agent_chat

    for agent in (agent_chat._agent, agent_chat._intro_agent):
        assert agent._max_concurrent == agent_chat._MAX_CONCURRENT_EXECUTIONS
        assert agent._execution_timeout == agent_chat._EXECUTION_TIMEOUT_SECONDS
    assert agent_chat._MAX_CONCURRENT_EXECUTIONS > 10
    # Cold, locally pinned Drive retrieval is bounded by its own 160s gate;
    # One leaves a narrow orchestration margin without the bridge's 600s default.
    assert 160 < agent_chat._EXECUTION_TIMEOUT_SECONDS <= 200
