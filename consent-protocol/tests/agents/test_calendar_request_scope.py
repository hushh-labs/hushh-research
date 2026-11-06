"""Calendar Set A through One's actual SDK tools; providers remain read-only fakes."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.agents.calendar import request_scope, tools
from hushh_mcp.agents.calendar.read_projection import local_read_result, turn_clock
from hushh_mcp.one_adk import agent_tree

A07 = (
    "For owner@example.test, show my meetings on 6 November 2026, "
    "using Asia/Kolkata. Include exact start/end times and identify the account "
    "and calendars checked. Read only; do not change anything."
)
A02 = (
    "For owner@example.test on 6 November 2026, find three "
    "non-overlapping 30-minute free slots between 09:00 and 18:00 Asia/Kolkata. "
    "State whether the availability check is complete. Do not book anything."
)


class CalendarModel(BaseLlm):
    _steps: list = PrivateAttr()
    _actions: list = PrivateAttr()
    _text: str = PrivateAttr()
    _assessments: int = PrivateAttr(default=0)

    def __init__(self, steps, text, actions=()):
        super().__init__(model="fixture")
        self._steps, self._actions, self._text = steps, list(actions), text

    async def generate_content_async(self, llm_request, stream=False):
        if llm_request.config.response_schema:
            self._assessments += 1
            assert not llm_request.tools_dict
            parts = [
                types.Part(
                    text=json.dumps(
                        {
                            "read_only": not self._actions,
                            "allowed_actions": self._actions,
                            "evidence": [{"message_index": 0, "quote": self._text}],
                        }
                    )
                )
            ]
        else:
            parts = self._steps.pop(0)
        yield LlmResponse(content=types.Content(role="model", parts=parts))


def call(name, **args):
    return types.Part(function_call=types.FunctionCall(name=name, args=args))


async def chat(monkeypatch, prompt, steps, service, actions=()):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: service)
    model = CalendarModel([*steps, [types.Part(text="Done reading.")]], prompt, actions)
    agent = agent_tree.build_one_text_agent(model=model)
    agent.tools = [tools.calendar_events, tools.calendar_free_slots, tools.propose_calendar_event]
    store = InMemorySessionService()
    await store.create_session(app_name="one", user_id="owner", session_id="set-a")
    runner = Runner(agent=agent, app_name="one", session_service=store)
    try:
        events = [
            event
            async for event in runner.run_async(
                user_id="owner",
                session_id="set-a",
                new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
                state_delta={
                    "hussh:user_id": "owner",
                    "hussh:conversation_id": "set-a",
                    "hussh:timezone": "Asia/Kolkata",
                    "temp:one_execution_surface": "typed_chat",
                },
            )
        ]
        session = await store.get_session(app_name="one", user_id="owner", session_id="set-a")
        responses = [response for event in events for response in event.get_function_responses()]
        return responses, session, model
    finally:
        await runner.close()


@pytest.mark.parametrize("read_first", [False, True])
async def test_exact_read_only_prompt_cannot_prepare_a_booking(monkeypatch, read_first):
    service = SimpleNamespace(
        list_events=AsyncMock(return_value={"events": [], "truncated": False}),
        propose=AsyncMock(),
        execute=AsyncMock(),
    )
    steps = (
        [
            [
                call(
                    "calendar_events",
                    start_at="2026-11-06T00:00:00+05:30",
                    end_at="2026-11-07T00:00:00+05:30",
                )
            ]
        ]
        if read_first
        else []
    )
    steps.append(
        [
            call(
                "propose_calendar_event",
                title="Meeting with Sharu Khan",
                start_at="2026-11-06T00:00:00+05:30",
                end_at="2026-11-07T00:00:00+05:30",
            )
        ]
    )
    responses, session, model = await chat(monkeypatch, A07, steps, service)
    refusal = next(r.response for r in responses if r.name == "propose_calendar_event")
    assert refusal["reason_code"] == "calendar_request_read_only"
    assert not session.state.get("hussh:pending_directive:calendar")
    service.propose.assert_not_awaited()
    service.execute.assert_not_awaited()
    assert model._assessments == 1
    from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection

    projected = durable_external_read_projection(session)
    # ADK's temp namespace is invocation-local even before durable projection.
    assert request_scope.STATE_REQUEST_SCOPE not in session.state
    assert request_scope.STATE_REQUEST_SCOPE not in projected.state
    assert request_scope.STATE_REQUEST_SCOPE not in projected.model_dump_json()


@pytest.mark.parametrize(
    "prompt",
    [
        "Prepare a 30-minute meeting tomorrow at 9 AM.",
        "Prepare a 30-minute meeting proposal tomorrow at 9 AM; do not book until I confirm.",
    ],
)
async def test_ordinary_booking_still_requires_explicit_confirmation(monkeypatch, prompt):
    service = SimpleNamespace(
        propose=AsyncMock(
            return_value={
                "proposal_id": "synthetic",
                "expires_at": "2099-11-06T00:00:00Z",
                "plan": {
                    "title": "Planning",
                    "start_at": "2099-11-06T03:30:00Z",
                    "end_at": "2099-11-06T04:00:00Z",
                    "attendees": [],
                },
            }
        ),
        execute=AsyncMock(),
    )
    responses, session, model = await chat(
        monkeypatch,
        prompt,
        [
            [
                call(
                    "propose_calendar_event",
                    title="Planning",
                    start_at="2099-11-06T09:00:00+05:30",
                    end_at="2099-11-06T09:30:00+05:30",
                )
            ]
        ],
        service,
        ["create"],
    )
    assert responses[-1].response["status"] == "confirmation_required"
    assert (
        session.state["hussh:pending_directive:calendar"]["payload"]["type"]
        == "calendar.execute_proposal"
    )
    service.propose.assert_awaited_once()
    service.execute.assert_not_awaited()
    assert model._assessments == 1


@pytest.mark.parametrize(
    "utc,today,tomorrow",
    [
        ("2026-11-05T18:29:59+00:00", "2026-11-05", "2026-11-06"),
        ("2026-11-05T18:30:00+00:00", "2026-11-06", "2026-11-07"),
    ],
)
def test_turn_clock_crosses_local_midnight_without_conversation_or_mail(utc, today, tomorrow):
    event = SimpleNamespace(
        invocation_id="current", author="user", timestamp=datetime.fromisoformat(utc).timestamp()
    )
    context = SimpleNamespace(
        state={"hussh:timezone": "Asia/Kolkata"},
        invocation_id="current",
        session=SimpleNamespace(events=[event]),
    )
    clock = turn_clock(context)
    assert f"Today={today}" in clock and f"tomorrow={tomorrow}" in clock
    assert turn_clock(context) == clock


def test_provider_utc_times_have_exact_local_projection_and_midnight_rollover():
    result = local_read_result(
        {
            "events": [
                {
                    "start": {"dateTime": "2026-11-06T17:30:00Z"},
                    "end": {"dateTime": "2026-11-06T18:30:00Z"},
                }
            ]
        },
        "Asia/Kolkata",
    )
    assert result["events"][0]["local_start_at"] == "2026-11-06T23:00:00+05:30"
    assert result["events"][0]["local_end_at"] == "2026-11-07T00:00:00+05:30"


def scope_context():
    return SimpleNamespace(
        state={"hussh:user_id": "owner", "hussh:conversation_id": "set-a"},
        invocation_id="current",
        session=SimpleNamespace(events=[]),
        user_content=types.Content(role="user", parts=[types.Part(text=A07)]),
    )


async def test_door_read_keeps_explicit_zone_and_local_midnight(monkeypatch):
    monkeypatch.setattr(request_scope, "request_scope", AsyncMock(return_value=()))
    monkeypatch.setattr(
        tools,
        "_serve_via_door",
        AsyncMock(
            return_value={
                "status": "ok",
                "events": [
                    {
                        "start": {"dateTime": "2026-11-06T01:00:00Z"},
                        "end": {"dateTime": "2026-11-06T02:00:00Z"},
                    }
                ],
            }
        ),
    )

    def no_hub_service():
        raise AssertionError("A served door read must not resolve a hub Calendar")

    monkeypatch.setattr(tools, "get_google_calendar_service", no_hub_service)
    context = scope_context()
    context.state["hussh:timezone"] = "Asia/Kolkata"
    result = await tools.calendar_events(
        context,
        start_at="2026-11-05T00:00:00-05:00",
        end_at="2026-11-07T00:00:00-05:00",
        time_zone="America/New_York",
    )
    assert result["display_time_zone"] == "America/New_York"
    assert result["events"][0]["local_start_at"] == "2026-11-05T20:00:00-05:00"
    assert result["events"][0]["start"]["dateTime"] == "2026-11-06T01:00:00Z"


async def test_expired_read_only_receipt_never_reassesses_into_booking(monkeypatch):
    from hushh_mcp.one_adk.request_secrets import consume_request_secret

    assessor = AsyncMock(
        return_value=request_scope.CalendarRequestScope(
            read_only=True, allowed_actions=[], evidence=[{"message_index": 0, "quote": A07}]
        )
    )
    monkeypatch.setattr(request_scope, "assess_scope", assessor)
    context = scope_context()
    assert await request_scope.request_scope(context) == ()
    consume_request_secret(context.state[request_scope.STATE_REQUEST_SCOPE])
    assessor.side_effect = AssertionError("Expired authority must not be reassessed")
    assert await request_scope.require_action(context, "create")
    assert assessor.await_count == 1


@pytest.mark.parametrize("failure", ["timeout", "wrong_evidence", "malformed"])
async def test_failed_scope_never_authorizes_a_review(monkeypatch, failure):
    scope = request_scope.CalendarRequestScope(
        read_only=False,
        allowed_actions=["create"],
        evidence=[{"message_index": 0, "quote": "UNTRUSTED PROVIDER TEXT"}],
    )
    assessor = AsyncMock(return_value=scope if failure == "wrong_evidence" else {})
    if failure == "timeout":
        assessor.side_effect = TimeoutError()
    monkeypatch.setattr(request_scope, "assess_scope", assessor)
    assert await request_scope.require_action(scope_context(), "create")


def test_request_start_clock_survives_later_sdk_retry():
    context = scope_context()
    context.state.update(
        {
            "hussh:timezone": "Asia/Kolkata",
            "temp:hussh:turn_started_at": datetime(2026, 11, 5, 18, 29, 59, tzinfo=UTC).timestamp(),
        }
    )
    context.session.events.append(
        SimpleNamespace(
            invocation_id="current",
            author="user",
            timestamp=datetime(2026, 11, 5, 18, 30, 1, tzinfo=UTC).timestamp(),
        )
    )
    assert "Today=2026-11-05; tomorrow=2026-11-06" in turn_clock(context)


async def test_parallel_calls_share_one_pending_deny_ceiling(monkeypatch):
    started, finish = asyncio.Event(), asyncio.Event()

    async def assess(context, messages):
        started.set()
        await finish.wait()
        return request_scope.CalendarRequestScope(
            read_only=True, allowed_actions=[], evidence=[{"message_index": 0, "quote": A07}]
        )

    assessor = AsyncMock(side_effect=assess)
    monkeypatch.setattr(request_scope, "assess_scope", assessor)
    context = scope_context()
    first = asyncio.create_task(request_scope.request_scope(context))
    await started.wait()
    assert await request_scope.require_action(context, "create")
    finish.set()
    assert await first == ()
    assert assessor.await_count == 1


async def test_explicit_read_zone_overrides_browser_zone(monkeypatch):
    port = SimpleNamespace(
        list_events=AsyncMock(
            return_value={
                "events": [
                    {
                        "start": {"dateTime": "2026-11-06T17:30:00Z"},
                        "end": {"dateTime": "2026-11-06T18:00:00Z"},
                    }
                ]
            }
        )
    )
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: port)
    context = scope_context()
    context.state["hussh:timezone"] = "UTC"
    # Scope is unrelated to read permission; prevent a model call in this leaf test.
    monkeypatch.setattr(request_scope, "assess_scope", AsyncMock(side_effect=TimeoutError()))
    result = await tools.calendar_events(
        context,
        start_at="2026-11-06T00:00:00",
        end_at="2026-11-07T00:00:00",
        time_zone="Asia/Kolkata",
    )
    assert result["display_time_zone"] == "Asia/Kolkata"
    assert result["events"][0]["local_start_at"] == "2026-11-06T23:00:00+05:30"
    assert port.list_events.await_args.kwargs["start_at"] == "2026-11-06T00:00:00+05:30"
