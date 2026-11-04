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
from hushh_mcp.services.google_calendar_service import GoogleCalendarService

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


def calendar_port(monkeypatch, *, unreadable=False, secondary_busy=False):
    binding = ("owner", "calendar", "subject", "connected", "connection-rev", "grant-rev")
    port = GoogleCalendarService(
        db=SimpleNamespace(),
        connections=SimpleNamespace(read_grant_binding=AsyncMock(return_value=binding)),
    )
    monkeypatch.setattr(port, "_check_read_binding", AsyncMock())
    monkeypatch.setattr(
        port,
        "list_calendars",
        AsyncMock(
            return_value={
                "calendars": [
                    {"id": "owner@example.test", "primary": True},
                    {"id": "team"},
                    {"id": "en.indian#holiday@group.v.calendar.google.com"},
                ],
                "truncated": False,
            }
        ),
    )

    async def freebusy(**kwargs):
        calendars = {identifier: {"busy": []} for identifier in kwargs["calendar_ids"]}
        if unreadable:
            calendars["team"] = {"errors": [{"reason": "forbidden"}]}
        elif secondary_busy:
            calendars["team"]["busy"] = [
                {"start": "2026-11-06T03:30:00Z", "end": "2026-11-06T04:00:00Z"}
            ]
        return {"calendars": calendars}

    monkeypatch.setattr(port, "freebusy", AsyncMock(side_effect=freebusy))
    return port


@pytest.mark.parametrize(
    "unreadable,secondary_busy", [(False, False), (False, True), (True, False)]
)
async def test_exact_free_slot_prompt_uses_all_included_calendars(
    monkeypatch, unreadable, secondary_busy
):
    port = calendar_port(monkeypatch, unreadable=unreadable, secondary_busy=secondary_busy)
    responses, session, _ = await chat(
        monkeypatch,
        A02,
        [
            [
                call(
                    "calendar_free_slots",
                    start_at="2026-11-06T09:00:00+05:30",
                    end_at="2026-11-06T18:00:00+05:30",
                    duration_minutes=30,
                    limit=3,
                )
            ]
        ],
        port,
    )
    result = responses[-1].response
    assert port.freebusy.await_args.kwargs["calendar_ids"] == ["primary", "team"]
    assert not session.state.get("hussh:pending_directive:calendar")
    if unreadable:
        assert result["status"] != "ok" and not result.get("openings")
    else:
        assert result["coverage_complete"] is True and result["suggestions_limited"] is True
        starts = [slot["start_at"] for slot in result["openings"]]
        assert starts == (
            ["2026-11-06T04:00:00Z", "2026-11-06T04:30:00Z", "2026-11-06T05:00:00Z"]
            if secondary_busy
            else ["2026-11-06T03:30:00Z", "2026-11-06T04:00:00Z", "2026-11-06T04:30:00Z"]
        )
        assert session.state["hussh:calendar_opening_read_offer"]["window"]["calendar_ids"] == [
            "primary",
            "team",
        ]


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


@pytest.mark.parametrize("changed", [False, True])
async def test_new_slot_coverage_is_rechecked_before_booking(monkeypatch, changed):
    from hushh_mcp.services.google_calendar_booking import check_opening
    from hushh_mcp.services.google_connection_service import GoogleConnectionError

    port = calendar_port(monkeypatch)
    opening = {
        "start_at": "2099-11-06T03:30:00Z",
        "end_at": "2099-11-06T04:00:00Z",
        "available_until": "2099-11-06T12:30:00Z",
    }
    selection = {
        "calendar_id": "primary",
        "calendar_ids": ["primary", "team"],
        "coverage_policy": "board_default",
        "query_start": "2099-11-06T03:30:00Z",
        "query_end": "2099-11-06T12:30:00Z",
        "duration_minutes": 30,
        "time_zone": "Asia/Kolkata",
        "slot": opening,
    }
    plan = {
        "calendar_id": "primary",
        "start_at": opening["start_at"],
        "end_at": opening["end_at"],
        "time_zone": "Asia/Kolkata",
        "opening_selection": selection,
    }
    if changed:
        port.list_calendars.return_value["calendars"].append({"id": "new-calendar"})
        with pytest.raises(GoogleConnectionError) as error:
            await check_opening(port, user_id="owner", plan=plan, binding=("grant",))
        assert error.value.reason_code == "calendar_selection_changed"
        port.freebusy.assert_not_awaited()
    else:
        await check_opening(port, user_id="owner", plan=plan, binding=("grant",))
        assert port.freebusy.await_args.kwargs["calendar_ids"] == ["primary", "team"]


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


async def test_window_and_new_slot_recheck_batch_more_than_twenty_calendars(monkeypatch):
    from hushh_mcp.services.google_calendar_booking import check_opening

    port = calendar_port(monkeypatch)
    port.list_calendars.return_value["calendars"].extend(
        {"id": f"included-{index}"} for index in range(21)
    )
    result = await port.find_openings(
        user_id="owner",
        start_at="2099-11-06T03:30:00Z",
        end_at="2099-11-06T12:30:00Z",
        duration_minutes=30,
        limit=3,
        include_subscribed_calendars=True,
    )
    assert len(result["calendar_ids"]) == 23 and port.freebusy.await_count == 2
    port.freebusy.reset_mock()
    slot = result["openings"][0]
    plan = {
        "calendar_id": "primary",
        "start_at": slot["start_at"],
        "end_at": slot["end_at"],
        "time_zone": "Asia/Kolkata",
        "opening_selection": {
            "calendar_id": "primary",
            "calendar_ids": result["calendar_ids"],
            "coverage_policy": "board_default",
            "query_start": result["time_min"],
            "query_end": result["time_max"],
            "duration_minutes": 30,
            "time_zone": "Asia/Kolkata",
            "slot": slot,
        },
    }
    await check_opening(port, user_id="owner", plan=plan, binding=("grant",))
    assert port.freebusy.await_count == 2
