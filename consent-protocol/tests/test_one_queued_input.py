"""Messages queued while One works join the live turn at a step boundary, or come back.

The production One text agent runs through the real AG-UI bridge against a
scripted model, so what reaches each model call is observed, not assumed.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Callable

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types

from hushh_mcp.one_adk import queued_input
from hushh_mcp.one_adk.agent_tree import _SPECIALIST_MODEL, build_one_text_agent
from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent
from hushh_mcp.one_adk.consent_continuation import STATE_CONSENT_CONTINUATION
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE, STATE_EXTERNAL_READ
from hushh_mcp.one_adk.turn_completion import newest_turn_pending, newest_turn_settled

OWNER = "owner-queue"
THREAD = "thread-queue"
QUEUED = "Also include the Friday review."
CLOCK = types.Part(function_call=types.FunctionCall(name="get_current_time", args={}))


class _ScriptedLlm(BaseLlm):
    """Answers each call from the script and records the text each call was sent."""

    script: list[list[types.Part]]
    on_call: dict[int, Callable[[], None]] = {}
    seen: list[list[str]] = []
    calls: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        del stream
        self.seen.append(
            [
                part.text
                for content in llm_request.contents
                if content.role == "user"
                for part in content.parts or []
                if isinstance(part.text, str)
            ]
        )
        hook = self.on_call.get(self.calls)
        parts = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        if hook is not None:
            hook()  # The person queues while this model step is running.
        yield LlmResponse(content=types.Content(role="model", parts=parts))


@pytest.fixture(autouse=True)
def _fresh_registry(monkeypatch):
    registry = queued_input.QueuedInputRegistry()
    monkeypatch.setattr(queued_input, "registry", registry)
    return registry


async def _run_turn(script, *, on_call=None, state=None, run_id="run-queue"):
    model = _ScriptedLlm(model=_SPECIALIST_MODEL, script=script, on_call=on_call or {}, seen=[])
    sessions = InMemorySessionService()
    agent = TimedADKAgent.from_app(
        App(
            name="one_queue",
            root_agent=build_one_text_agent(
                model=model, allow_workspace_tools=True, include_thought_summaries=True
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        head=HEAD_ONE,
        user_id_extractor=lambda _input: OWNER,
        session_service=sessions,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    run = RunAgentInput(
        thread_id=THREAD,
        run_id=run_id,
        state={STATE_EXECUTION_SURFACE: "typed_chat", "hussh:user_id": OWNER, **(state or {})},
        context=[],
        forwarded_props={},
        messages=[UserMessage(id="m-1", role="user", content="What is on this week?")],
        tools=[],
    )
    events = [event async for event in agent.run(run)]
    session = await sessions.get_session(app_name="one_queue", user_id=OWNER, session_id=THREAD)
    return model, events, session


def _notices(events) -> list[dict]:
    return [
        event.value
        for event in events
        if event.type == EventType.CUSTOM and event.name == queued_input.QUEUED_INPUT_EVENT
    ]


def _queue(client_id: str = "client-msg-0001", text: str = QUEUED) -> Callable[[], object]:
    return lambda: queued_input.registry.enqueue(OWNER, THREAD, client_id, text)


@pytest.mark.asyncio
async def test_queued_message_joins_the_next_step_after_a_tool():
    """Two tool steps: a message queued during step 1 is in the model input of step 2."""
    model, events, session = await _run_turn(
        [[CLOCK], [CLOCK], [types.Part(text="Done, with Friday.")]],
        on_call={0: _queue()},
    )

    assert model.calls == 3
    assert QUEUED not in model.seen[0]
    assert model.seen[1].count(QUEUED) == 1
    assert model.seen[2].count(QUEUED) == 1  # later steps keep it, once
    # It is the person's own event in the sealed conversation, tagged for history.
    joined = [event for event in session.events if (event.custom_metadata or {}).get("kind")]
    assert [(event.author, event.content.parts[0].text) for event in joined] == [("user", QUEUED)]
    assert joined[0].custom_metadata["clientMessageId"] == "client-msg-0001"
    assert newest_turn_settled(session.events)
    # The wire says where it landed, by id only; the text never crosses it.
    notices = _notices(events)
    assert notices[0] == {"phase": "joined", "joined": ["client-msg-0001"], "returned": []}
    assert notices[-1] == {"phase": "settled", "joined": ["client-msg-0001"], "returned": []}
    assert QUEUED not in json.dumps(notices)
    assert str(events[-1].type).endswith("RUN_FINISHED")


@pytest.mark.asyncio
async def test_negative_control_a_message_queued_during_the_final_answer_comes_back():
    """No step boundary is left, so it reaches no model call and returns for the next turn."""
    model, events, _ = await _run_turn(
        [[CLOCK], [types.Part(text="Here is your week.")]],
        on_call={1: _queue()},
    )

    assert model.calls == 2
    assert all(QUEUED not in seen for seen in model.seen)
    assert _notices(events) == [{"phase": "settled", "joined": [], "returned": ["client-msg-0001"]}]
    assert queued_input.registry.status(OWNER, THREAD, ["client-msg-0001"])[0].status == "returned"


@pytest.mark.asyncio
async def test_a_repeated_enqueue_is_delivered_exactly_once_and_in_order():
    def queue_twice_then_second() -> None:
        first = queued_input.registry.enqueue(OWNER, THREAD, "client-msg-0001", QUEUED)
        again = queued_input.registry.enqueue(OWNER, THREAD, "client-msg-0001", QUEUED)
        queued_input.registry.enqueue(OWNER, THREAD, "client-msg-0002", "And skip Monday.")
        assert (first.status, again.status) == ("queued", "queued")

    model, events, _ = await _run_turn(
        [[CLOCK], [types.Part(text="Done.")]], on_call={0: queue_twice_then_second}
    )

    assert model.seen[1].count(QUEUED) == 1
    assert model.seen[1].index(QUEUED) < model.seen[1].index("And skip Monday.")
    assert _notices(events)[-1]["joined"] == ["client-msg-0001", "client-msg-0002"]
    # A retry after delivery reports the outcome; it can never queue again.
    receipt = queued_input.registry.enqueue(OWNER, THREAD, "client-msg-0001", QUEUED)
    assert receipt.status == "delivered"


@pytest.mark.asyncio
async def test_a_consent_answer_turn_never_takes_queued_input():
    """Its admission covered one exact purpose, so the message waits for its own turn."""
    receipts = []
    model, events, _ = await _run_turn(
        [[CLOCK], [types.Part(text="Ok.")]],
        on_call={0: lambda: receipts.append(_queue()())},
        state={STATE_CONSENT_CONTINUATION: {"bundle_id": "b-1"}},
    )

    assert all(QUEUED not in seen for seen in model.seen)
    # Refused at the door: the receipt itself sends it back for the next turn.
    assert [receipt.status for receipt in receipts] == ["returned"]
    assert _notices(events) == []


@pytest.mark.asyncio
async def test_after_an_external_read_the_message_waits_for_a_fresh_turn(monkeypatch):
    """The post-read barrier narrows this turn; a new instruction must not inherit it."""
    import hushh_mcp.one_adk.agent_tree as agent_tree

    original = agent_tree.club_queued_input

    async def read_already_happened(callback_context, llm_request):
        callback_context.state[STATE_EXTERNAL_READ] = callback_context.invocation_id
        return await original(callback_context, llm_request)

    # The root agent binds this name when it is built.
    monkeypatch.setattr(agent_tree, "club_queued_input", read_already_happened)
    model, events, _ = await _run_turn([[CLOCK], [types.Part(text="Ok.")]], on_call={0: _queue()})

    assert all(QUEUED not in seen for seen in model.seen)
    assert _notices(events)[-1]["returned"] == ["client-msg-0001"]


@pytest.mark.asyncio
async def test_stop_ends_the_turn_at_the_next_step_and_returns_what_was_queued():
    def queue_then_stop() -> None:
        _queue()()
        settlement = queued_input.registry.request_stop(OWNER, THREAD)
        assert settlement is not None and settlement.returned == ("client-msg-0001",)

    model, events, session = await _run_turn(
        [[CLOCK], [types.Part(text="never asked")]], on_call={0: queue_then_stop}
    )

    assert model.calls == 1  # the step after the tool never reached the model
    assert queued_input.STOPPED_ANSWER in "".join(
        event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT
    )
    # Well formed: the tool call has its response and the turn has a final event,
    # so a returning client does not wait on a turn that will never settle.
    assert newest_turn_settled(session.events)
    assert not newest_turn_pending(session.events)
    assert _notices(events)[-1]["returned"] == ["client-msg-0001"]


def test_a_message_for_another_owner_or_no_live_run_is_returned_never_joined():
    registry = queued_input.registry
    registry.open_run(OWNER, THREAD, "run-a", accepting=True)

    other = registry.enqueue("someone-else", THREAD, "client-msg-0009", "hijack")
    assert other.status == "returned"
    assert registry.drain(OWNER, THREAD, "run-a") == []
    assert registry.status(OWNER, THREAD, ["client-msg-0009"])[0].status == "unknown"


def test_withdraw_only_removes_a_message_that_has_not_joined():
    registry = queued_input.registry
    registry.open_run(OWNER, THREAD, "run-a", accepting=True)
    registry.enqueue(OWNER, THREAD, "client-msg-0001", "first")
    registry.enqueue(OWNER, THREAD, "client-msg-0002", "second")

    assert registry.withdraw(OWNER, THREAD, "client-msg-0002").status == "withdrawn"
    assert [item.text for item in registry.drain(OWNER, THREAD, "run-a")] == ["first"]
    assert registry.withdraw(OWNER, THREAD, "client-msg-0001").status == "delivered"
    # A withdrawn id stays withdrawn: a late retry of its enqueue cannot revive it.
    assert registry.enqueue(OWNER, THREAD, "client-msg-0002", "second").status == "withdrawn"


def test_reconnect_reads_each_outcome_after_the_run_settled():
    """A client whose stream dropped asks by id; unknown ids were never received."""
    registry = queued_input.registry
    registry.open_run(OWNER, THREAD, "run-a", accepting=True)
    registry.enqueue(OWNER, THREAD, "client-msg-0001", "joins")
    registry.drain(OWNER, THREAD, "run-a")
    registry.enqueue(OWNER, THREAD, "client-msg-0002", "comes back")
    # The background run and the stream each close the run, in either order;
    # both see the same settlement, so the stream's notice is never empty.
    first = registry.close_run(OWNER, THREAD, "run-a")
    assert registry.close_run(OWNER, THREAD, "run-a") == first
    assert first.delivered == ("client-msg-0001",)
    assert first.returned == ("client-msg-0002",)
    assert registry.close_run(OWNER, THREAD, "run-a") == queued_input.Settlement()

    receipts = registry.status(
        OWNER, THREAD, ["client-msg-0001", "client-msg-0002", "client-msg-0003"]
    )
    assert [receipt.status for receipt in receipts] == ["delivered", "returned", "unknown"]


def test_routes_bind_every_queue_operation_to_the_token_owner(monkeypatch):
    from api.middleware import require_vault_owner_token
    from api.routes.one import agent_chat

    registry = queued_input.QueuedInputRegistry()
    monkeypatch.setattr(agent_chat, "queued_input_registry", registry)
    registry.open_run(OWNER, THREAD, "run-a", accepting=True)
    app = FastAPI()
    app.include_router(agent_chat.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "intruder"}
    client = TestClient(app)

    queued = client.post(
        f"/api/one/agent-chat/runs/{THREAD}/queue",
        json={"client_message_id": "client-msg-0001", "text": "hijack"},
    )
    stopped = client.post(f"/api/one/agent-chat/runs/{THREAD}/stop")

    assert queued.json() == {"clientMessageId": "client-msg-0001", "status": "returned"}
    assert stopped.json() == {"stopped": False, "returned": []}
    assert registry.drain(OWNER, THREAD, "run-a") == []
    assert not registry.stop_requested(OWNER, THREAD, "run-a")
    # Malformed ids are refused before anything is recorded.
    bad = client.delete(f"/api/one/agent-chat/runs/{THREAD}/queue/x")
    assert bad.status_code == 400
