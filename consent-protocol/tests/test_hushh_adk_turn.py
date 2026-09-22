import asyncio
from contextvars import ContextVar
from types import SimpleNamespace

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.tools import ToolContext
from google.adk.tools.agent_tool import AgentTool
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.events import AdkEventCleanupError, bounded_adk_events
from hushh_mcp.hushh_adk.tools import hushh_tool
from hushh_mcp.hushh_adk.turn import (
    SpecialistAdkCallLimitError,
    SpecialistAdkTurnError,
    hushh_tool_error_callback,
    run_specialist_adk_turn,
)


def response(text=None, call=None):
    parts = [types.Part.from_text(text=text)] if text else []
    if call:
        parts.append(types.Part(function_call=types.FunctionCall(name=call, args={})))
    return LlmResponse(content=types.Content(role="model", parts=parts))


class ScriptedLlm(BaseLlm):
    _steps: list = PrivateAttr()
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self, steps):
        super().__init__(model="fixture")
        self._steps = list(steps)

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request)
        step = self._steps.pop(0)
        if isinstance(step, Exception):
            raise step
        yield step


def agent(model, **kwargs):
    return LlmAgent(name="specialist", model=model, instruction="Fixture", **kwargs)


async def run(built, **kwargs):
    return await run_specialist_adk_turn(
        agent=built,
        app_name="hushh_test",
        user_id="owner",
        consent_token="private-token",  # noqa: S106 - synthetic authority fixture
        message="fixture request",
        **kwargs,
    )


@pytest.mark.asyncio
async def test_real_runner_executes_tool_with_context_and_preserves_state():
    async def read_record(tool_context: ToolContext) -> dict:
        context = HushhContext.current()
        assert context.consent_token == "private-token"
        assert context.scope_tokens == {"scope": "scoped-token"}
        assert context.service_ports["fixture"] == "port"
        assert "private-token" not in repr(tool_context.state.to_dict())
        tool_context.state["result"] = "done"
        return {"ok": True}

    model = ScriptedLlm([response(call="read_record"), response(text="Done")])
    initial = {"nested": {"keep": True}}
    result = await run(
        agent(model, tools=[read_record]),
        state=initial,
        scope_tokens={"scope": "scoped-token"},
        service_ports={"fixture": "port"},
    )
    assert result.final_text == "Done"
    assert result.llm_calls == 2
    assert result.state["result"] == "done"
    assert [call.name for call in result.tool_calls] == ["read_record"]
    assert result.tool_results[0].response == {"ok": True}
    assert initial == {"nested": {"keep": True}}
    assert HushhContext.current() is None


@pytest.mark.asyncio
async def test_history_bounds_and_new_session_each_turn():
    model = ScriptedLlm([response(text="First"), response(text="Second")])
    history = [{"role": "user", "content": str(i) + "x" * 2500} for i in range(20)]
    await run(agent(model), history=history)
    first = model._requests[0].contents
    assert len(first) == 13
    assert first[0].parts[0].text.startswith("8x")
    assert all(len(item.parts[0].text) == 2000 for item in first[:-1])
    await run(agent(model))
    assert len(model._requests[1].contents) == 1


@pytest.mark.asyncio
async def test_scoped_async_tool_and_expected_error_callback(monkeypatch):
    checks = []

    async def validate(token, *, expected_scope):
        checks.append((token, expected_scope))
        return True, None, SimpleNamespace(user_id="owner")

    monkeypatch.setattr("hushh_mcp.hushh_adk.tools.validate_token_with_db", validate)

    @hushh_tool(scope="attr.identity.legal_name")
    async def scoped_read() -> dict:
        assert HushhContext.current().user_id == "owner"
        raise ValueError("private argument details")

    model = ScriptedLlm([response(call="scoped_read"), response(text="Please correct the input")])
    result = await run(
        agent(model, tools=[scoped_read], on_tool_error_callback=hushh_tool_error_callback)
    )
    assert len(checks) == 1
    assert result.tool_results[0].response == {"error": "invalid_argument"}
    assert "private argument details" not in repr(result.tool_results)


@pytest.mark.asyncio
async def test_nested_agent_state_and_model_call_count():
    async def propose(tool_context: ToolContext) -> dict:
        assert HushhContext.current().user_id == "owner"
        tool_context.state["hussh:specialist_directive"] = {"kind": "prompt"}
        tool_context.actions.skip_summarization = True
        return {"status": "confirmation_required"}

    child_model = ScriptedLlm([response(call="propose")])
    child = LlmAgent(name="child", model=child_model, tools=[propose])
    parent_model = ScriptedLlm([response(call="child"), response(text="Please confirm")])
    result = await run(agent(parent_model, tools=[AgentTool(agent=child)]))
    assert result.llm_calls == 3
    assert result.state["hussh:specialist_directive"] == {"kind": "prompt"}
    assert len(child_model._requests) == 1  # stop-at-prompt honored
    assert [call.name for call in result.tool_calls] == ["child", "propose"]
    assert [result.name for result in result.tool_results] == ["propose", "child"]
    assert result.tool_results[0].response == {"status": "confirmation_required"}


@pytest.mark.asyncio
async def test_model_failure_after_tool_never_replays_side_effect():
    writes = []

    async def write_once() -> dict:
        writes.append("committed")
        return {"ok": True}

    model = ScriptedLlm([response(call="write_once"), RuntimeError("provider unavailable")])
    with pytest.raises(SpecialistAdkTurnError) as caught:
        await run(agent(model, tools=[write_once]))
    assert isinstance(caught.value.__cause__, RuntimeError)
    assert str(caught.value.__cause__) == "provider unavailable"
    assert caught.value.partial_turn.tool_results[0].response == {"ok": True}
    assert writes == ["committed"]
    assert len(model._requests) == 2
    assert HushhContext.current() is None


@pytest.mark.asyncio
async def test_nested_calls_share_global_budget():
    child = LlmAgent(name="child", model=ScriptedLlm([response(text="child done")]))
    parent = agent(
        ScriptedLlm([response(call="child"), response(text="must not run")]),
        tools=[AgentTool(agent=child)],
    )
    with pytest.raises(SpecialistAdkTurnError) as caught:
        await run(parent, max_llm_calls=2)
    assert isinstance(caught.value.__cause__.__cause__, SpecialistAdkCallLimitError)
    assert caught.value.partial_turn.llm_calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_real_runner_stall_cancels_model_and_restores_context(cancel):
    started = asyncio.Event()
    stopped = asyncio.Event()

    class SlowLlm(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            assert HushhContext.current().user_id == "owner"
            started.set()
            try:
                await asyncio.sleep(10)
                yield response(text="late")
            finally:
                stopped.set()

    task = asyncio.create_task(
        run(
            agent(SlowLlm(model="fixture")),
            first_event_timeout_s=0.03,
            between_event_timeout_s=0.03,
        )
    )
    await started.wait()
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        with pytest.raises(SpecialistAdkTurnError) as caught:
            await task
        assert isinstance(caught.value.__cause__, TimeoutError)
    assert stopped.is_set()
    assert HushhContext.current() is None


@pytest.mark.asyncio
async def test_runner_rejects_single_turn_mode_without_rewriting_agent():
    model = ScriptedLlm([response(text="must not run")])
    built = agent(model, mode="single_turn")
    with pytest.raises(SpecialistAdkTurnError) as caught:
        await run(built)
    assert isinstance(caught.value.__cause__, ValueError)
    assert built.mode == "single_turn"
    assert not model._requests


@pytest.mark.parametrize(
    "error,expected",
    [
        (PermissionError("private"), {"error": "consent_denied"}),
        (ValueError("private"), {"error": "invalid_argument"}),
        (RuntimeError("private"), None),
    ],
)
def test_error_callback_does_not_leak_values(error, expected):
    assert hushh_tool_error_callback(tool=None, args={}, tool_context=None, error=error) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["first", "gap", "total", "cancel"])
async def test_bounded_source_closes_on_timeouts_and_cancellation(phase):
    closed = asyncio.Event()

    async def source():
        try:
            if phase == "gap":
                yield "initial"
            if phase == "total":
                while True:
                    await asyncio.sleep(0.005)
                    yield "progress"
            await asyncio.sleep(10)
            yield "late"
        finally:
            closed.set()

    async def consume():
        async for _ in bounded_adk_events(
            source(), first_event_timeout_s=0.03, between_event_timeout_s=0.03, total_timeout_s=0.06
        ):
            pass

    if phase == "cancel":
        task = asyncio.create_task(consume())
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        with pytest.raises(asyncio.TimeoutError):
            await consume()
    assert closed.is_set()


@pytest.mark.asyncio
async def test_source_uses_one_context_and_does_not_prefetch_after_yield():
    context = ContextVar("test_source_scope", default=None)
    writes = []
    closed = []

    async def source():
        token = context.set("active")
        try:
            yield "initial"
            writes.append("unexpected prefetch")
        finally:
            context.reset(token)
            closed.append(True)

    events = bounded_adk_events(source())
    assert await anext(events) == "initial"
    await asyncio.sleep(0.01)
    await events.aclose()
    assert writes == []
    assert closed == [True]


@pytest.mark.asyncio
async def test_cancellation_resistant_source_reports_unconfirmed_cleanup(monkeypatch):
    monkeypatch.setattr("hushh_mcp.hushh_adk.events._CLOSE_TIMEOUT_S", 0.02)
    release = asyncio.Event()
    stopped = asyncio.Event()

    async def source():
        try:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                await release.wait()
            yield "late"
        finally:
            stopped.set()

    try:
        with pytest.raises(AdkEventCleanupError, match="termination unconfirmed"):
            async for _ in bounded_adk_events(source(), first_event_timeout_s=0.01):
                pass
    finally:
        release.set()
        await asyncio.wait_for(stopped.wait(), timeout=1)


@pytest.mark.asyncio
async def test_nested_progress_extends_idle_without_prefetch():
    loop = asyncio.get_running_loop()
    progress = [None]
    writes = []

    async def source():
        for _ in range(4):
            await asyncio.sleep(0.025)
            progress[0] = loop.time()
        yield "nested result"
        writes.append("must await demand")
        yield "next result"

    events = bounded_adk_events(
        source(),
        first_event_timeout_s=0.06,
        total_timeout_s=0.5,
        progress_timestamp=lambda: progress[0],
    )
    assert await anext(events) == "nested result"
    await asyncio.sleep(0.03)
    assert writes == []
    await events.aclose()
    assert writes == []


@pytest.mark.asyncio
async def test_stalled_child_expires_after_last_real_progress():
    loop = asyncio.get_running_loop()
    progress = [None]
    stopped = asyncio.Event()

    async def source():
        try:
            await asyncio.sleep(0.03)
            progress[0] = loop.time()
            await asyncio.Event().wait()
            yield "unreachable"
        finally:
            stopped.set()

    started = loop.time()
    with pytest.raises(TimeoutError):
        async for _ in bounded_adk_events(
            source(),
            first_event_timeout_s=0.06,
            total_timeout_s=0.5,
            progress_timestamp=lambda: progress[0],
        ):
            pass
    assert loop.time() - progress[0] >= 0.055
    assert loop.time() - started < 0.4 and stopped.is_set()


@pytest.mark.asyncio
async def test_progress_cannot_extend_total_deadline():
    loop = asyncio.get_running_loop()
    progress = [None]
    stopped = asyncio.Event()

    async def source():
        try:
            while True:
                await asyncio.sleep(0.015)
                progress[0] = loop.time()
            yield "unreachable"
        finally:
            stopped.set()

    started = loop.time()
    with pytest.raises(TimeoutError):
        async for _ in bounded_adk_events(
            source(),
            first_event_timeout_s=0.05,
            total_timeout_s=0.12,
            progress_timestamp=lambda: progress[0],
        ):
            pass
    assert 0.11 <= loop.time() - started < 0.4
    assert stopped.is_set()


@pytest.mark.asyncio
async def test_outer_event_racing_progress_is_not_lost_or_prefetched():
    loop = asyncio.get_running_loop()
    progress = [None]
    visited = []

    async def source():
        for index in range(3):
            await asyncio.sleep(0.02)
            progress[0] = loop.time()
            visited.append(index)
            yield index

    events = bounded_adk_events(
        source(),
        first_event_timeout_s=0.05,
        between_event_timeout_s=0.05,
        total_timeout_s=0.5,
        progress_timestamp=lambda: progress[0],
    )
    for index in range(3):
        assert await anext(events) == index
        await asyncio.sleep(0.02)
        assert visited == list(range(index + 1))
    with pytest.raises(StopAsyncIteration):
        await anext(events)


@pytest.mark.asyncio
@pytest.mark.parametrize("track_progress", [True, False])
async def test_real_nested_agent_progress_prevents_false_idle_timeout(monkeypatch, track_progress):
    if not track_progress:

        def without_progress(source, **kwargs):
            kwargs["progress_timestamp"] = None
            return bounded_adk_events(source, **kwargs)

        monkeypatch.setattr("hushh_mcp.hushh_adk.turn.bounded_adk_events", without_progress)

    class SlowModel(ScriptedLlm):
        async def generate_content_async(self, llm_request, stream=False):
            await asyncio.sleep(0.25)
            async for item in super().generate_content_async(llm_request, stream):
                yield item

    async def read_value():
        await asyncio.sleep(0.25)
        return {"value": "fixture"}

    child = LlmAgent(
        name="child",
        model=SlowModel([response(call="read_value"), response(text="child answer")]),
        tools=[read_value],
    )
    built = agent(
        ScriptedLlm([response(call="child")]),
        tools=[AgentTool(agent=child, skip_summarization=True)],
    )
    pending = run(
        built,
        first_event_timeout_s=1.0,
        between_event_timeout_s=0.4,
        total_timeout_s=3.0,
    )
    if not track_progress:
        with pytest.raises(SpecialistAdkTurnError) as failure:
            await pending
        assert isinstance(failure.value.__cause__, TimeoutError)
        return
    result = await pending
    assert result.final_text == "child answer"
    assert result.llm_calls == 3
    assert [receipt.name for receipt in result.tool_results] == ["read_value", "child"]
