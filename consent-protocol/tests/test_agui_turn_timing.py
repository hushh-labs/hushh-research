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


async def test_vault_catalog_handoff_is_consumed_before_bridge_state(monkeypatch):
    from hushh_mcp.one_adk.mcp_turn_scope import (
        STATE_MCP_CONFIGURATION,
        admit_turn_configurations,
        current_mcp_turn,
    )

    run = _input()
    run.state = {
        "hussh:user_id": "owner",
        STATE_MCP_CONFIGURATION: admit_turn_configurations(
            {"mcpConfigurations": []},
            owner_id="owner",
            conversation_id=run.thread_id,
        ),
    }

    async def bridge(self, input):
        assert STATE_MCP_CONFIGURATION not in input.state
        assert current_mcp_turn().has_vault_configurations
        assert current_mcp_turn().vault_catalog("owner") == []
        yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)

    monkeypatch.setattr(ADKAgent, "run", bridge)
    assert len([event async for event in _agent().run(run)]) == 1


@pytest.mark.asyncio
async def test_disconnect_closes_bridge_before_turn_resources(monkeypatch):
    from hushh_mcp.one_adk.mcp_turn_scope import current_mcp_turn

    observed = []

    async def run(self, input):
        scope = current_mcp_turn()
        try:
            yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
        finally:
            # The bridge may still need its MCP resources during teardown.
            assert current_mcp_turn() is scope
            observed.append(scope)

    monkeypatch.setattr(ADKAgent, "run", run)
    stream = _agent().run(_input())
    await anext(stream)
    await stream.aclose()
    assert len(observed) == 1
    assert observed[0]._closed


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
    assert fields["error_class"] == "model"
    assert fields["first_visible_ms"] == "None"
    assert fields["events"] == "2"


@pytest.mark.asyncio
async def test_escaped_exception_marks_outcome_error_without_reaching_endpoint(monkeypatch, caplog):
    async def failing_run(self: ADKAgent, input: RunAgentInput):
        yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
        raise RuntimeError("runner exploded")

    monkeypatch.setattr(ADKAgent, "run", failing_run)
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    events = await _drain(_agent())

    assert _fields(_timing_lines(caplog)[0])["outcome"] == OUTCOME_ERROR
    assert _fields(_timing_lines(caplog)[0])["error_class"] == "escaped_exception"
    assert events[-1].type == "RUN_ERROR"
    assert "runner exploded" not in events[-1].model_dump_json()


def _provider_error_text(status_code: int, status: str) -> str:
    from google.adk.models.google_llm import _ResourceExhaustedError
    from google.genai.errors import APIError

    body = {"error": {"code": status_code, "status": status, "message": "PRIVATE_PROVIDER_TEXT"}}
    error = APIError(status_code, body)
    return str(_ResourceExhaustedError(error) if status_code == 429 else error)


@pytest.mark.parametrize(
    ("status_code", "status", "code", "retryable"),
    [
        (429, "RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED", True),
        (503, "UNAVAILABLE", "MODEL_UNAVAILABLE", True),
        # Negative control: a request the provider rejected is not retryable.
        (400, "INVALID_ARGUMENT", "AGENT_ERROR", None),
    ],
)
async def test_provider_failure_after_first_chunk_ends_with_retryable_terminal_error(
    monkeypatch, caplog, status_code, status, code, retryable
):
    """Failover moves a request only while it opens; a later 429/5xx must still end the turn."""
    script = [
        (0.0, RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)),
        (0.0, TextMessageContentEvent(message_id="a-1", delta="Partial answer")),
        (
            0.0,
            RunErrorEvent(
                message=_provider_error_text(status_code, status),
                code="BACKGROUND_EXECUTION_ERROR",
            ),
        ),
    ]
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(script))
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    events = await _drain(_agent())

    terminal = events[-1]
    assert terminal.type == "RUN_ERROR"
    assert terminal.code == code
    assert (terminal.metadata or {}).get("retryable") is retryable
    wire = terminal.model_dump_json()
    assert "PRIVATE_PROVIDER_TEXT" not in wire and str(status_code) not in wire
    fields = _fields(_timing_lines(caplog)[0])
    assert fields["outcome"] == OUTCOME_ERROR
    assert fields["error_class"] == ("model" if retryable else "other")


async def test_escaped_provider_capacity_error_is_retryable(monkeypatch):
    from google.genai.errors import ClientError

    async def failing_run(self: ADKAgent, input: RunAgentInput):
        yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
        raise ClientError(429, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "PRIVATE"}})

    monkeypatch.setattr(ADKAgent, "run", failing_run)

    terminal = (await _drain(_agent()))[-1]

    assert terminal.code == "RESOURCE_EXHAUSTED"
    assert terminal.metadata == {"retryable": True}
    assert "PRIVATE" not in terminal.model_dump_json()


async def test_shutdown_cancellation_is_not_counted_as_the_person_leaving(monkeypatch, caplog):
    from sse_starlette.sse import AppStatus

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
    monkeypatch.setattr(AppStatus, "should_exit", True)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert _fields(_timing_lines(caplog)[0])["outcome"] == "server_restarting"


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("MCP_CATALOG_UNAVAILABLE", "connector"),
        ("DATABASE_UNAVAILABLE", "database"),
        ("AGENT_RUNTIME_MODEL_UNAVAILABLE", "runtime"),
        ("MODEL_ERROR", "model"),
        ("RESOURCE_EXHAUSTED", "model"),
        ("MODEL_UNAVAILABLE", "model"),
        ("SERVER_RESTARTING", "shutdown"),
        ("PRIVATE_OWNER_VALUE", "other"),
        (None, "untyped"),
    ],
)
def test_error_class_discards_untrusted_code_and_message(code, expected):
    assert agui_turn_timing._error_class(code) == expected


def test_bridge_logger_discards_provider_exception_and_traceback():
    try:
        raise RuntimeError("private provider response")
    except RuntimeError:
        import sys

        exception = sys.exc_info()
    record = logging.LogRecord(
        "ag_ui_adk.adk_agent",
        logging.ERROR,
        __file__,
        1,
        "Background execution error: private provider response",
        (),
        exception,
    )
    agui_turn_timing._NoModelTextPreview().filter(record)
    assert record.getMessage() == "[ADK_BRIDGE] phase=background kind=other details=[redacted]"
    assert record.exc_info is None
    assert "private provider response" not in logging.Formatter().format(record)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (TimeoutError("secret"), "timeout"),
        (ConnectionError("secret"), "connection"),
        (PermissionError("secret"), "permission"),
        (ValueError("secret"), "validation"),
        (KeyError("secret"), "missing_key"),
    ],
)
def test_bridge_logger_keeps_only_safe_failure_category(error, expected):
    record = logging.LogRecord(
        "ag_ui_adk.adk_agent",
        logging.ERROR,
        __file__,
        1,
        "Error in new execution: secret",
        (),
        (type(error), error, None),
    )
    agui_turn_timing._NoModelTextPreview().filter(record)
    assert record.getMessage() == f"[ADK_BRIDGE] phase=execution kind={expected} details=[redacted]"
    assert "secret" not in logging.Formatter().format(record)


def test_bridge_logger_does_not_log_untrusted_exception_class_or_log_prefix():
    class PrivateCustomerEmailError(Exception):
        pass

    error = PrivateCustomerEmailError("secret")
    record = logging.LogRecord(
        "ag_ui_adk.adk_agent",
        logging.ERROR,
        __file__,
        1,
        "PrivateCustomerEmailError: secret",
        (),
        (type(error), error, None),
    )
    agui_turn_timing._NoModelTextPreview().filter(record)
    assert record.getMessage() == "[ADK_BRIDGE] phase=other kind=other details=[redacted]"
    assert "PrivateCustomerEmailError" not in logging.Formatter().format(record)


def test_endpoint_logger_drops_serialized_events_and_sanitizes_errors():
    debug_record = logging.LogRecord(
        "ag_ui_adk.endpoint", logging.DEBUG, __file__, 1, "HTTP Response: private", (), None
    )
    assert agui_turn_timing._NoEndpointPayload().filter(debug_record) is False
    error_record = logging.LogRecord(
        "ag_ui_adk.endpoint",
        logging.ERROR,
        __file__,
        1,
        "ADKAgent error: private",
        (),
        (ValueError, ValueError("private"), None),
    )
    assert agui_turn_timing._NoEndpointPayload().filter(error_record) is True
    assert (
        error_record.getMessage() == "[ADK_BRIDGE] phase=other kind=validation details=[redacted]"
    )
    assert error_record.exc_info is None


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
    observed = await anext(stream)
    if terminal_error:
        assert observed.type == terminal.type
        assert observed.code == "AGENT_ERROR"
        assert observed.message != terminal.message
    else:
        assert observed is terminal
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


# ── A turn outlives its client ─────────────────────────────────────────────────
# These drive the installed ag_ui_adk bridge with a real ADK agent and session
# store, so they prove the bridge's own behaviour rather than a scripted stand-in:
# the run is a task of its own, and closing the stream does not cancel it.

DETACHED_ANSWER = "the answer written after the client left"
CHAT_KEY = bytes.fromhex("3c" * 32)


def _slow_answer_agent(delay: float = 0.2):
    from google.adk.agents import BaseAgent
    from google.adk.events import Event
    from google.genai import types

    class SlowAnswer(BaseAgent):
        async def _run_async_impl(self, ctx):
            yield Event(
                author=self.name,
                invocation_id=ctx.invocation_id,
                partial=True,
                content=types.Content(role="model", parts=[types.Part(text="working")]),
            )
            await asyncio.sleep(delay)
            yield Event(
                author=self.name,
                invocation_id=ctx.invocation_id,
                content=types.Content(role="model", parts=[types.Part(text=DETACHED_ANSWER)]),
            )

    return SlowAnswer(name="one")


def _bridge_agent(hook, delay: float = 0.2):
    from google.adk.sessions import InMemorySessionService

    store = InMemorySessionService()
    agent = TimedADKAgent(
        adk_agent=_slow_answer_agent(delay),
        app_name="one_detach_probe",
        user_id_extractor=lambda _input: USER_ID,
        session_service=store,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    agent.head = HEAD_ONE
    agent.detached_turn_hook = hook
    return agent, store


async def _leave_mid_turn(stream) -> None:
    # The bridge starts the turn's task only after RUN_STARTED, so a client that
    # leaves on that first event never started a turn at all. Leave once the
    # turn is visibly running, as a person switching away mid-answer does.
    assert (await anext(stream)).type == "RUN_STARTED"
    await anext(stream)
    await stream.aclose()


def _owner_input() -> RunAgentInput:
    run = _input()
    run.state = {"hussh:user_id": USER_ID}
    run.forwarded_props = {"notifyOnDetach": True}  # the native app asks for the push
    return run


async def _stored_texts(store) -> list[str]:
    session = await store.get_session(
        app_name="one_detach_probe", user_id=USER_ID, session_id=THREAD_ID
    )
    return [
        part.text
        for event in session.events
        if event.content
        for part in (event.content.parts or [])
        if part.text
    ]


@pytest.mark.asyncio
async def test_a_turn_finishes_and_persists_after_its_client_leaves():
    from hushh_mcp.one_adk.turn_completion import newest_turn_answered, newest_turn_pending

    settled: asyncio.Queue = asyncio.Queue()

    async def hook(owner_id: str, conversation_id: str) -> None:
        await settled.put((owner_id, conversation_id))

    agent, store = _bridge_agent(hook)
    await _leave_mid_turn(agent.run(_owner_input()))  # before the answer existed

    assert await asyncio.wait_for(settled.get(), timeout=5) == (USER_ID, THREAD_ID)
    assert DETACHED_ANSWER in await _stored_texts(store)
    session = await store.get_session(
        app_name="one_detach_probe", user_id=USER_ID, session_id=THREAD_ID
    )
    # What the history route tells a returning client: settled, with an answer.
    assert newest_turn_answered(session.events)
    assert not newest_turn_pending(session.events)


@pytest.mark.asyncio
async def test_a_client_that_stays_gets_the_answer_and_no_detached_notice():
    calls: list[tuple[str, str]] = []

    async def hook(owner_id: str, conversation_id: str) -> None:
        calls.append((owner_id, conversation_id))

    agent, store = _bridge_agent(hook)
    events = [event async for event in agent.run(_owner_input())]

    assert events[-1].type == "RUN_FINISHED"
    await asyncio.sleep(0.1)  # let the background task finish its own cleanup
    # The attached client saw the answer live; a push beside it is a duplicate.
    assert calls == []
    assert DETACHED_ANSWER in await _stored_texts(store)


@pytest.mark.asyncio
async def test_a_detached_turn_seals_with_its_own_key_then_drops_it():
    from hushh_mcp.services.chat_key import (
        RequestChatKey,
        bind_request_chat_key,
        request_has_chat_key,
    )

    held_during_hook: list[bool] = []
    settled = asyncio.Event()

    async def hook(owner_id: str, _conversation_id: str) -> None:
        held_during_hook.append(request_has_chat_key(owner_id))
        settled.set()

    agent, store = _bridge_agent(hook)
    holder = RequestChatKey(CHAT_KEY)
    holder.bind_owner(USER_ID)
    with bind_request_chat_key(holder):  # the HTTP exchange, as ChatKeyMiddleware binds it
        await _leave_mid_turn(agent.run(_owner_input()))
    # The exchange is over; only the turn's own reference keeps the key alive.
    await asyncio.wait_for(settled.wait(), timeout=5)
    await asyncio.sleep(0.05)

    assert held_during_hook == [True]
    assert not holder.bound  # released once the turn settled, not kept for later
    session = await store.get_session(
        app_name="one_detach_probe", user_id=USER_ID, session_id=THREAD_ID
    )
    stored = session.model_dump_json()
    assert CHAT_KEY.hex() not in stored and CHAT_KEY.hex().upper() not in stored


def test_only_authenticated_one_turns_are_watched_for_a_detached_notice():
    async def hook(_owner_id: str, _conversation_id: str) -> None:
        return None

    agent = _agent(HEAD_ONE)
    agent.detached_turn_hook = hook
    run = _owner_input()
    assert agent._detach_watch(run) is not None
    # A web tab does not ask for it: its closed stream must not wake a phone.
    web = _owner_input()
    web.forwarded_props = {}
    assert agent._detach_watch(web) is None
    run.state = {"hussh:user_id": "anonymous:abc"}
    assert agent._detach_watch(run) is None
    intro = _agent(HEAD_INTRO)
    intro.detached_turn_hook = hook
    assert intro._detach_watch(_owner_input()) is None


@pytest.mark.asyncio
async def test_a_client_that_leaves_after_the_run_settled_is_still_notified():
    settled: asyncio.Queue = asyncio.Queue()

    async def hook(owner_id: str, conversation_id: str) -> None:
        await settled.put((owner_id, conversation_id))

    # The run finishes at once, while its answer still waits in the bridge's
    # queue for a reader that then leaves without taking it.
    agent, _store = _bridge_agent(hook, delay=0.0)
    stream = agent.run(_owner_input())
    assert (await anext(stream)).type == "RUN_STARTED"
    await anext(stream)
    await asyncio.sleep(0.3)
    await stream.aclose()

    assert await asyncio.wait_for(settled.get(), timeout=10) == (USER_ID, THREAD_ID)


def test_failed_drive_guard_does_not_count_a_model_call():
    from google.adk.models.llm_request import LlmRequest

    from hushh_mcp.one_adk.external_read_boundary import STATE_DRIVE_READ_OUTCOME

    context = SimpleNamespace(
        invocation_id="current",
        state={STATE_DRIVE_READ_OUTCOME: {"invocation": "current", "outcome": "failed"}},
    )
    timing = agui_turn_timing.TurnTiming(head=HEAD_ONE, run="run", started_at=time.perf_counter())
    token = agui_turn_timing._CURRENT_TURN.set(timing)
    try:
        result = agui_turn_timing.timed_one_before_model(context, LlmRequest())
        assert result is not None and result.turn_complete is True
        agui_turn_timing.timed_one_after_model(context, result)
        assert timing.model_calls == 0
        assert timing.model_call_total_ms == 0
    finally:
        agui_turn_timing._CURRENT_TURN.reset(token)


@pytest.mark.asyncio
async def test_first_model_call_is_split_into_session_and_request_build(monkeypatch, caplog):
    """Production could not say where 22 s before the first model call went.

    The line now splits it at ADK's agent start and says whether this was the
    process's first turn and whether the startup warmup had run. A run with no
    agent start (the negative control) reports no split rather than a guess.
    """
    import threading

    monkeypatch.setattr(agui_turn_timing, "_TURN_PATH_WARMED", threading.Event())
    request = SimpleNamespace(model="gemini-3.6-flash", config=None, contents=[])
    monkeypatch.setattr(agui_turn_timing, "before_external_read_model", lambda *_: None)

    def bridge(*, start_agent: bool):
        async def run(self, input):
            yield RunStartedEvent(thread_id=THREAD_ID, run_id=RUN_ID)
            await asyncio.sleep(0.02)
            if start_agent:
                agui_turn_timing.timed_one_before_agent(object())
            agui_turn_timing.record_instruction_build(7.4)
            await asyncio.sleep(0.02)
            agui_turn_timing.timed_one_before_model(object(), request)
            agui_turn_timing.timed_one_after_model(object(), object())
            yield RunFinishedEvent(thread_id=THREAD_ID, run_id=RUN_ID)

        return run

    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    monkeypatch.setattr(ADKAgent, "run", bridge(start_agent=True))
    await _drain(_agent())
    agui_turn_timing.mark_turn_path_warmed()
    monkeypatch.setattr(ADKAgent, "run", bridge(start_agent=False))
    await _drain(_agent())

    split, unsplit = (_fields(line) for line in _timing_lines(caplog))
    assert int(split["session_ms"]) >= 15
    assert int(split["request_build_ms"]) >= 15
    assert (
        abs(
            int(split["session_ms"])
            + int(split["request_build_ms"])
            - int(split["first_model_call_ms"])
        )
        <= 1
    )
    assert split["instruction_ms"] == "7"
    assert split["path_warmed"] == "false"
    assert unsplit["session_ms"] == "None" and unsplit["request_build_ms"] == "None"
    assert unsplit["path_warmed"] == "true"
    assert int(unsplit["process_turn"]) == int(split["process_turn"]) + 1

    # Outside a turn the recorders are inert rather than failing a build.
    agui_turn_timing.record_instruction_build(5.0)
    agui_turn_timing.timed_one_before_agent(object())


def _supersede_probe(monkeypatch, *, fail: bool = False):
    calls: list[tuple[str, str]] = []

    async def supersede(owner_id, conversation_id):
        calls.append((owner_id, conversation_id))
        if fail:
            raise RuntimeError("synthetic")

    monkeypatch.setattr(agui_turn_timing, "supersede_unanswered_reviews", supersede)
    monkeypatch.setattr(ADKAgent, "run", _scripted_run(_normal_script()))
    return calls


async def test_a_new_typed_turn_supersedes_unanswered_connector_reviews(monkeypatch):
    calls = _supersede_probe(monkeypatch)
    events = [event async for event in _agent().run(_owner_input())]
    assert calls == [(USER_ID, THREAD_ID)]
    assert events[-1].type == "RUN_FINISHED"


async def test_a_resume_or_tool_result_never_supersedes_a_review(monkeypatch):
    from ag_ui.core import ResumeEntry, ToolMessage

    calls = _supersede_probe(monkeypatch)
    resumed = _owner_input()
    resumed.resume = [ResumeEntry(interrupt_id="call-1", status="resolved", payload={})]
    answered = _owner_input()
    answered.messages = [
        *answered.messages,
        ToolMessage(id="t-1", role="tool", tool_call_id="call-1", content="{}"),
    ]
    for run in (resumed, answered):
        await _drain_run(_agent(), run)
    assert calls == []


async def test_turn_start_never_supersedes_for_other_heads_or_anonymous_owners(monkeypatch):
    calls = _supersede_probe(monkeypatch)
    await _drain_run(_agent(HEAD_INTRO), _owner_input())
    anonymous = _owner_input()
    anonymous.state = {"hussh:user_id": "anonymous:abc"}
    await _drain_run(_agent(), anonymous)
    assert calls == []


async def test_a_failed_supersede_never_breaks_the_turn(monkeypatch):
    from hushh_mcp.one_adk import mcp_call_approval

    class FailingStore:
        async def cancel_unconfirmed_adk_chat(self, **_):
            raise RuntimeError("synthetic")

    monkeypatch.setattr(ADKAgent, "run", _scripted_run(_normal_script()))
    monkeypatch.setattr(mcp_call_approval, "ActionDirectiveStore", FailingStore)
    events = await _drain_run(_agent(), _owner_input())
    assert events[-1].type == "RUN_FINISHED"


async def _drain_run(agent: TimedADKAgent, run: RunAgentInput) -> list[BaseEvent]:
    return [event async for event in agent.run(run)]
