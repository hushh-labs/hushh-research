from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.agents.calendar import tools
from hushh_mcp.agents.calendar.read_offer import (
    STATE_CALENDAR_OFFER,
    STATE_EVENT_OFFER,
    current_calendar_read_offer,
    make_calendar_read_offer,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError


@pytest.fixture(autouse=True)
def admitted_review_scope(monkeypatch):
    # These leaf tests isolate target/grant/slot and rendering contracts.
    # The real invocation-bound assessment is exercised by test_calendar_request_scope.
    monkeypatch.setattr(
        "hushh_mcp.agents.calendar.request_scope.scope_receipt",
        lambda _: {"actions": ["create", "reschedule", "cancel", "respond"], "continuation": False},
    )
    monkeypatch.setattr(
        "hushh_mcp.agents.calendar.request_scope.request_scope",
        AsyncMock(return_value=("create", "reschedule", "cancel", "respond")),
    )


class _Calendar:
    def __init__(self) -> None:
        self.proposal_payload: dict[str, object] | None = None
        self.last_list: dict[str, object] | None = None
        self.last_detail: dict[str, object] | None = None
        self.connections = SimpleNamespace(read_grant_binding=self._read_grant_binding)

    async def _read_grant_binding(self, **_: object) -> tuple[str, ...]:
        return ("user-1", "calendar", "google-sub", "connected-at", "connection-rev", "grant-rev")

    async def list_events(self, **kwargs: object) -> dict[str, object]:
        self.last_list = kwargs
        return {"events": [{"id": "event-1", "title": "Planning"}], "time_zone": "Asia/Kolkata"}

    async def list_calendars(self, **kwargs: object) -> dict[str, object]:
        return {"calendars": [{"id": "team@example.com", "name": "Team"}], "truncated": False}

    async def get_event(self, **kwargs: object) -> dict[str, object]:
        self.last_detail = kwargs
        return {
            "calendar_id": kwargs["calendar_id"],
            "event": {"id": kwargs["event_id"], "title": "Planning"},
        }

    async def freebusy(self, **kwargs: object) -> dict[str, object]:
        return {"calendars": {"primary": {"busy": []}}}

    async def find_openings(self, **kwargs: object) -> dict[str, object]:
        return {
            "duration_minutes": kwargs["duration_minutes"],
            "openings": [
                {
                    "start_at": "2026-08-11T10:00:00Z",
                    "end_at": "2026-08-11T10:30:00Z",
                    "available_until": kwargs["end_at"],
                }
            ],
        }

    async def propose(self, **kwargs: object) -> dict[str, object]:
        self.proposal_payload = kwargs["payload"]  # type: ignore[assignment]
        return {
            "proposal_id": "gcal_example",
            "expires_at": "2026-08-11T12:00:00Z",
            "plan": {
                "title": "Planning",
                "start_at": "2026-08-11T10:00:00Z",
                "end_at": "2026-08-11T10:30:00Z",
                "attendees": ["person@example.com"],
                "send_updates": True,
            },
        }


class _UnavailableCalendar:
    async def list_events(self, **kwargs: object) -> dict[str, object]:
        raise GoogleConnectionError(
            "Connect Google Calendar first", status_code=403, reason_code="google_not_connected"
        )


class _RateLimitedCalendar:
    async def list_events(self, **kwargs: object) -> dict[str, object]:
        # Not 401/403 -- _handle_connection_error returns None for this, so
        # this exercises the "no connect directive applies" fallback rather
        # than the reauth path _UnavailableCalendar exercises above.
        raise GoogleConnectionError("Too many requests", status_code=429)


class _FlakyCalendar:
    async def list_events(self, **kwargs: object) -> dict[str, object]:
        # Unexpected provider failures must not expose their raw messages.
        raise RuntimeError("private provider detail")


def test_calendar_summary_fails_clean_on_a_non_reauth_provider_error(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _RateLimitedCalendar())

    result = asyncio.run(tools.calendar_summary(_context()))

    assert result == {
        "status": "rate_limited",
        "message": "Google Calendar is busy right now. Please try again shortly.",
    }


def test_calendar_summary_fails_clean_on_an_unexpected_exception(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _FlakyCalendar())

    result = asyncio.run(tools.calendar_summary(_context()))

    assert result == {"status": "failed", "message": tools._CALENDAR_UNAVAILABLE_MESSAGE}


def test_calendar_summary_reports_timeout_without_provider_details(monkeypatch) -> None:
    class SlowCalendar:
        async def list_events(self, **kwargs: object) -> dict[str, object]:
            raise TimeoutError("private provider detail")

    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: SlowCalendar())
    assert asyncio.run(tools.calendar_summary(_context())) == {
        "status": "timeout",
        "message": "Calendar took too long. Please try again.",
    }


def test_calendar_summary_fails_clean_when_signed_out(monkeypatch) -> None:  # noqa: ANN001
    # user_id resolution now happens INSIDE the same error boundary as the
    # service call -- previously it ran before the try, so a signed-out
    # state raised GoogleConnectionError straight out of the tool.
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _Calendar())
    context = SimpleNamespace(state={})

    result = asyncio.run(tools.calendar_summary(context))

    assert result["status"] == "connection_required"


def test_propose_fails_clean_when_the_provider_response_is_missing_fields(monkeypatch) -> None:  # noqa: ANN001
    class _MalformedCalendar:
        async def propose(self, **kwargs: object) -> dict[str, object]:
            return {"proposal_id": "gcal_example"}  # no plan, no expires_at

    context = _context()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _MalformedCalendar())

    result = asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Planning",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T10:30:00+05:30",
        )
    )

    assert result["status"] == "failed"
    assert f"{tools._STATE_PENDING_DIRECTIVE}:calendar" not in context.state


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        state={
            "hussh:user_id": "user-1",
            "hussh:timezone": "Asia/Kolkata",
            "hussh:conversation_id": "conversation-1",
        }
    )


def test_calendar_summary_uses_authenticated_state_and_never_uses_a_token(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _Calendar())

    result = asyncio.run(tools.calendar_summary(_context(), days=3))

    assert result["status"] == "ok"
    assert result["events"] == [{"id": "event-1", "title": "Planning"}]


def test_calendar_read_tools_resolve_selected_calendar_and_event_from_private_offer(
    monkeypatch,
) -> None:  # noqa: ANN001
    calendar = _Calendar()

    async def owner_cloud_grant(**_: object) -> tuple[str, ...]:
        return (
            "user-1",
            "calendar",
            "credential-id",
            "google-sub",
            "connected-at",
            "calendar.events",
            "calendar.freebusy",
            "openid",
        )

    calendar.connections.read_grant_binding = owner_cloud_grant
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    context = _context()
    calendars = asyncio.run(tools.calendar_calendars(context))
    events = asyncio.run(
        tools.calendar_events(
            context,
            start_at="2026-08-11T00:00:00+05:30",
            end_at="2026-08-12T00:00:00+05:30",
            calendar_ordinal=1,
        )
    )
    detail = asyncio.run(tools.calendar_event_detail(context, ordinal=1))
    assert calendars["status"] == "ok"
    assert calendars["calendars"][0]["name"] == "Team"
    assert context.state[STATE_CALENDAR_OFFER]["ids"] == ["team@example.com"]
    assert calendar.last_list["calendar_id"] == "team@example.com"
    assert events["status"] == "ok"
    assert context.state[STATE_EVENT_OFFER]["ids"] == ["event-1"]
    assert detail["status"] == "ok"
    assert detail["event"]["id"] == "event-1"
    assert calendar.last_detail["calendar_id"] == "team@example.com"
    assert calendar.last_detail["event_id"] == "event-1"


def test_calendar_detail_refuses_unoffered_ordinal_and_wrong_conversation(monkeypatch) -> None:  # noqa: ANN001
    calendar = _Calendar()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    context = _context()
    asyncio.run(tools.calendar_summary(context))
    assert (
        asyncio.run(tools.calendar_event_detail(context, ordinal=2))["status"] == "input_required"
    )
    assert calendar.last_detail is None

    context.state["hussh:conversation_id"] = "another-conversation"
    assert (
        asyncio.run(tools.calendar_event_detail(context, ordinal=1))["status"] == "input_required"
    )
    assert calendar.last_detail is None


def test_calendar_selected_list_refuses_guessed_id_and_changed_account(monkeypatch) -> None:  # noqa: ANN001
    calendar = _Calendar()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    context = _context()
    asyncio.run(tools.calendar_calendars(context))
    guessed = asyncio.run(
        tools.calendar_events(
            context,
            start_at="2026-08-11T00:00:00+05:30",
            end_at="2026-08-12T00:00:00+05:30",
            calendar_id="guessed@example.com",
        )
    )
    assert guessed["status"] == "input_required"
    assert calendar.last_list is None

    offer = context.state[STATE_CALENDAR_OFFER]
    binding = tuple(offer["grant_binding"])
    assert (
        current_calendar_read_offer(
            offer,
            kind="calendars",
            owner_id="user-1",
            conversation_id="conversation-1",
            grant_binding=(*binding[:2], "another-google-sub", *binding[3:]),
        )
        is None
    )
    assert (
        current_calendar_read_offer(
            offer,
            kind="calendars",
            owner_id="user-1",
            conversation_id="conversation-1",
            grant_binding=binding,
            now_ms=offer["created_at_ms"] + 300_001,
        )
        is None
    )


def test_calendar_list_missing_optional_permission_asks_for_specific_upgrade(monkeypatch) -> None:  # noqa: ANN001
    class _BaseGrantOnly:
        async def list_calendars(self, **_: object) -> dict[str, object]:
            raise GoogleConnectionError(
                "Calendar list permission is missing",
                status_code=403,
                reason_code="calendar_list_permission_required",
            )

    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _BaseGrantOnly())
    result = asyncio.run(tools.calendar_calendars(_context()))
    assert result["status"] == "connection_required"
    assert result["directive"]["payload"]["confirmLabel"] == "Allow calendar list access"
    assert "subscribed calendars" in result["directive"]["payload"]["summary"]
    assert result["directive"]["payload"]["includeCalendarList"] is True
    assert result["reason_code"] == "calendar_list_permission_required"


def test_calendar_connection_requirement_becomes_a_connect_directive(monkeypatch) -> None:  # noqa: ANN001
    context = _context()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _UnavailableCalendar())

    result = asyncio.run(tools.calendar_summary(context))

    assert result["status"] == "connection_required"
    assert result["directive"] == context.state["hussh:pending_directive:calendar"]
    directive = context.state["hussh:pending_directive:calendar"]
    assert directive["delegateAgentId"] == "agent_calendar"
    assert directive["payload"]["type"] == "calendar.connect"


def test_calendar_write_only_creates_a_confirmation_directive(monkeypatch) -> None:  # noqa: ANN001
    context = _context()
    calendar = _Calendar()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

    result = asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Planning",
            start_at="2026-08-11T10:00:00",
            end_at="2026-08-11T10:30:00",
            attendees=["person@example.com"],
        )
    )

    assert result["status"] == "confirmation_required"
    assert result["directive"] == context.state["hussh:pending_directive:calendar"]
    directive = context.state["hussh:pending_directive:calendar"]
    assert directive["payload"]["proposalId"] == "gcal_example"
    assert directive["payload"]["type"] == "calendar.execute_proposal"
    assert directive["payload"]["googleMeet"] is True
    assert directive["payload"]["confirmLabel"] == "Schedule meeting"
    assert calendar.proposal_payload is not None
    assert str(calendar.proposal_payload["start_at"]).endswith("+05:30")


def test_calendar_free_slots_uses_authenticated_owner_state(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _Calendar())

    result = asyncio.run(
        tools.calendar_free_slots(
            _context(),
            start_at="2026-08-11T09:00:00+05:30",
            end_at="2026-08-11T17:00:00+05:30",
            duration_minutes=30,
        )
    )

    assert result["status"] == "ok"
    assert result["openings"][0]["start_at"] == "2026-08-11T10:00:00Z"


def test_calendar_conflict_requires_an_explicit_schedule_anyway_choice(monkeypatch) -> None:  # noqa: ANN001
    context = _context()
    calendar = _Calendar()
    _seed_event_offer(context, calendar)

    async def propose(**kwargs: object) -> dict[str, object]:
        return {
            "proposal_id": "gcal_example",
            "expires_at": "2026-08-11T12:00:00Z",
            "plan": {
                "title": "Client call",
                "start_at": "2026-08-11T10:00:00+05:30",
                "end_at": "2026-08-11T10:30:00+05:30",
                "time_zone": "Asia/Kolkata",
                "attendees": [],
                "send_updates": True,
                "conflicts": [
                    {
                        "title": "Design review",
                        "start": {"dateTime": "2026-08-11T10:00:00+05:30"},
                    }
                ],
            },
        }

    calendar.propose = propose  # type: ignore[method-assign]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

    result = asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Client call",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T10:30:00+05:30",
        )
    )

    directive = context.state["hussh:pending_directive:calendar"]
    assert result["conflicts"][0]["title"] == "Design review"
    assert "Design review" in directive["payload"]["summary"]
    assert directive["payload"]["confirmLabel"] == "Schedule anyway"


def test_calendar_confirmation_uses_the_chat_users_timezone_not_plan_utc(monkeypatch) -> None:  # noqa: ANN001
    context = _context()
    calendar = _Calendar()

    async def propose(**kwargs: object) -> dict[str, object]:
        return {
            "proposal_id": "gcal_example",
            "expires_at": "2026-08-11T12:00:00Z",
            "plan": {
                "title": "Client call",
                "start_at": "2026-08-11T04:30:00Z",
                "end_at": "2026-08-11T05:00:00Z",
                # Google/provider plan data is allowed to be UTC. It must not
                # dictate the confirmation display timezone.
                "time_zone": "UTC",
                "attendees": [],
                "send_updates": True,
                "conflicts": [
                    {
                        "title": "Design review",
                        "start": {"dateTime": "2026-08-11T04:30:00Z"},
                    }
                ],
            },
        }

    calendar.propose = propose  # type: ignore[method-assign]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

    asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Client call",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T10:30:00+05:30",
        )
    )

    summary = context.state["hussh:pending_directive:calendar"]["payload"]["summary"]
    assert "10:00 AM IST" in summary
    assert "UTC" not in summary
    assert (
        context.state["hussh:pending_directive:calendar"]["payload"]["timeZone"] == "Asia/Kolkata"
    )


class _ReadOnlyCalendar:
    async def propose(self, **kwargs: object) -> dict[str, object]:
        raise GoogleConnectionError(
            "Additional Google Calendar permission is required",
            status_code=403,
            reason_code="google_permission_required",
        )


def test_calendar_all_day_confirmation_preserves_exclusive_end_date() -> None:
    assert tools._display_all_day("2026-10-02", "2026-10-03") == "Fri, Oct 2 (all day)"
    assert tools._display_all_day("2026-10-02", "2026-10-05") == (
        "Fri, Oct 2 to Sun, Oct 4 (all day)"
    )


def test_calendar_confirmation_formats_midnight_and_noon_in_local_timezone() -> None:
    assert tools._display_time("2026-10-01T18:30:00Z", "Asia/Kolkata") == (
        "Fri, Oct 2 at 12:00 AM IST"
    )
    assert tools._display_time("2026-10-02T06:30:00Z", "Asia/Kolkata") == (
        "Fri, Oct 2 at 12:00 PM IST"
    )


def test_timezone_falls_back_to_utc_on_a_path_shaped_value() -> None:
    # ZoneInfo raises ValueError (not ZoneInfoNotFoundError) for a key shaped
    # like an absolute or relative path -- "../etc", "/UTC" -- which the
    # narrower except clause this replaces did not catch.
    context = SimpleNamespace(state={"hussh:timezone": "../etc"})
    assert tools._timezone(context) == "UTC"


def test_calendar_propose_directive_carries_structured_event_fields(monkeypatch) -> None:  # noqa: ANN001
    # The client card needs title/time/attendees as distinct fields, not just
    # the flattened `summary` sentence -- this is the additive payload change.
    context = _context()
    calendar = _Calendar()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

    asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Planning",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T10:30:00+05:30",
            attendees=["person@example.com"],
            location="Room 4",
        )
    )

    payload = context.state["hussh:pending_directive:calendar"]["payload"]
    assert payload["title"] == "Planning"
    assert payload["startAt"] == "2026-08-11T10:00:00Z"
    assert payload["endAt"] == "2026-08-11T10:30:00Z"
    assert payload["attendees"] == ["person@example.com"]
    assert payload["sendUpdates"] is True
    # Byte-identical to the pre-existing assertions -- purely additive.
    assert payload["type"] == "calendar.execute_proposal"
    assert payload["proposalId"] == "gcal_example"


def test_calendar_cancel_directive_reads_structured_fields_from_the_fetched_event(
    monkeypatch,
) -> None:  # noqa: ANN001
    # A cancel proposal's input payload only ever has event_id + send_updates
    # -- the real title/time/attendees live under plan["current_event"], the
    # event GoogleCalendarService.propose() fetched from Google. The
    # directive's structured fields must come from there, not fall back to
    # the bare event_id the flat `summary` string uses.
    context = _context()
    calendar = _Calendar()

    async def propose(**kwargs: object) -> dict[str, object]:
        return {
            "proposal_id": "gcal_cancel",
            "expires_at": "2026-08-11T12:00:00Z",
            "plan": {
                "event_id": "evt-1",
                "send_updates": True,
                "current_event": {
                    "title": "Design review",
                    "start": {"dateTime": "2026-08-11T10:00:00+05:30"},
                    "end": {"dateTime": "2026-08-11T10:30:00+05:30"},
                    "location": "Room 4",
                    "attendees": [{"email": "person@example.com", "response_status": "accepted"}],
                },
            },
        }

    calendar.propose = propose  # type: ignore[method-assign]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

    _seed_event_offer(context, calendar)
    asyncio.run(tools.propose_calendar_cancellation(context, event_id="evt-1"))

    payload = context.state["hussh:pending_directive:calendar"]["payload"]
    assert payload["eventId"] == "evt-1"
    assert payload["title"] == "Design review"
    assert payload["startAt"] == "2026-08-11T10:00:00+05:30"
    assert payload["endAt"] == "2026-08-11T10:30:00+05:30"
    assert payload["location"] == "Room 4"
    assert payload["attendees"] == ["person@example.com"]


def test_calendar_propose_directive_carries_a_structured_conflicts_list(monkeypatch) -> None:  # noqa: ANN001
    context = _context()
    calendar = _Calendar()

    async def propose(**kwargs: object) -> dict[str, object]:
        return {
            "proposal_id": "gcal_example",
            "expires_at": "2026-08-11T12:00:00Z",
            "plan": {
                "title": "Client call",
                "start_at": "2026-08-11T10:00:00+05:30",
                "end_at": "2026-08-11T10:30:00+05:30",
                "attendees": [],
                "send_updates": True,
                "conflicts": [
                    {
                        "title": "Design review",
                        "start": {"dateTime": "2026-08-11T10:00:00+05:30"},
                    }
                ],
            },
        }

    calendar.propose = propose  # type: ignore[method-assign]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

    asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Client call",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T10:30:00+05:30",
        )
    )

    payload = context.state["hussh:pending_directive:calendar"]["payload"]
    assert payload["conflicts"] == [
        {"title": "Design review", "startAt": "2026-08-11T10:00:00+05:30"}
    ]


def test_calendar_write_permission_becomes_an_incremental_oauth_directive(monkeypatch) -> None:  # noqa: ANN001
    context = _context()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _ReadOnlyCalendar())

    result = asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Planning",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T10:30:00+05:30",
        )
    )

    assert result["status"] == "connection_required"
    directive = context.state["hussh:pending_directive:calendar"]
    assert directive["payload"]["type"] == "calendar.connect"
    assert directive["payload"]["accessLevel"] == "manage"
    assert directive["payload"]["confirmLabel"] == "Allow Calendar scheduling"
    assert result["reason_code"] == "google_permission_required"
    assert directive["payload"]["reasonCode"] == "google_permission_required"
    assert "scheduling" in directive["payload"]["summary"]
    assert "Connect Google Calendar" not in directive["payload"]["summary"]


def _current_event_with_guests() -> dict[str, object]:
    return {
        "title": "Standup",
        "start": {"dateTime": "2026-08-11T10:00:00+05:30"},
        "end": {"dateTime": "2026-08-11T10:30:00+05:30"},
        "attendees": [
            {"email": email, "response_status": "accepted"}
            for email in ("owner@example.com", "a@example.com", "b@example.com", "c@example.com")
        ],
    }


def _seed_event_offer(context, calendar, event_id="evt-1", calendar_id="primary"):
    context.state[STATE_EVENT_OFFER] = make_calendar_read_offer(
        kind="events",
        owner_id="user-1",
        conversation_id="conversation-1",
        grant_binding=asyncio.run(calendar._read_grant_binding()),
        ids=[event_id],
        calendar_id=calendar_id,
    )


def _review(monkeypatch, plan: dict[str, object]) -> tuple[str, dict[str, object]]:  # noqa: ANN001
    context = _context()
    calendar = _Calendar()
    _seed_event_offer(context, calendar)

    async def propose(**kwargs: object) -> dict[str, object]:
        calendar.proposal_payload = kwargs["payload"]  # type: ignore[assignment]
        return {"proposal_id": "gcal_review", "expires_at": "2026-08-11T12:00:00Z", "plan": plan}

    calendar.propose = propose  # type: ignore[method-assign]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    return context, calendar  # type: ignore[return-value]


def test_a_reschedule_review_counts_the_events_real_guests(monkeypatch) -> None:  # noqa: ANN001
    # Regression: the review said "notify 0 attendee(s)" for a meeting with
    # four guests, because it counted only attendees the model passed.
    # Negative control: the previous summary counted plan["attendees"] (absent
    # here) and fails this assertion.
    plan = {
        "event_id": "evt-1",
        "start_at": "2026-08-12T04:30:00Z",
        "end_at": "2026-08-12T05:00:00Z",
        "send_updates": True,
        "current_event": _current_event_with_guests(),
        "attendee_change": {"added": [], "removed": [], "result_count": 4},
    }
    context, calendar = _review(monkeypatch, plan)
    asyncio.run(
        tools.propose_calendar_reschedule(
            context,
            event_id="evt-1",
            start_at="2026-08-12T10:00:00",
            end_at="2026-08-12T10:30:00",
        )
    )
    payload = context.state["hussh:pending_directive:calendar"]["payload"]
    assert "notify 4 attendees" in payload["summary"]
    assert "0 attendee" not in payload["summary"]
    assert payload["title"] == "Standup"
    assert payload["attendees"] == [
        "owner@example.com",
        "a@example.com",
        "b@example.com",
        "c@example.com",
    ]
    # Omitted fields are never sent as empty values that would clear them.
    assert set(calendar.proposal_payload) == {  # type: ignore[arg-type]
        "account_id",
        "calendar_id",
        "event_id",
        "start_at",
        "end_at",
        "time_zone",
        "send_updates",
    }


def test_a_reschedule_review_names_every_attendee_it_removes(monkeypatch) -> None:  # noqa: ANN001
    plan = {
        "event_id": "evt-1",
        "start_at": "2026-08-12T04:30:00Z",
        "end_at": "2026-08-12T05:00:00Z",
        "attendees": ["new@example.com"],
        "send_updates": True,
        "current_event": _current_event_with_guests(),
        "attendee_change": {
            "added": ["new@example.com"],
            "removed": ["a@example.com", "b@example.com", "c@example.com"],
            "result_count": 2,
        },
    }
    context, _ = _review(monkeypatch, plan)
    asyncio.run(
        tools.propose_calendar_reschedule(
            context,
            event_id="evt-1",
            start_at="2026-08-12T10:00:00",
            end_at="2026-08-12T10:30:00",
            attendees=["new@example.com"],
        )
    )
    payload = context.state["hussh:pending_directive:calendar"]["payload"]
    assert "adds 1 attendee (new@example.com)" in payload["summary"]
    assert (
        "removes 3 attendees (a@example.com, b@example.com, c@example.com)" in (payload["summary"])
    )
    assert payload["attendeesRemoved"] == ["a@example.com", "b@example.com", "c@example.com"]
    assert payload["attendees"] == ["owner@example.com", "new@example.com"]


def test_a_cancel_review_counts_the_guests_it_will_notify(monkeypatch) -> None:  # noqa: ANN001
    plan = {
        "event_id": "evt-1",
        "send_updates": True,
        "current_event": _current_event_with_guests(),
    }
    context, _ = _review(monkeypatch, plan)
    asyncio.run(tools.propose_calendar_cancellation(context, event_id="evt-1"))
    summary = context.state["hussh:pending_directive:calendar"]["payload"]["summary"]
    assert summary == "Cancel “Standup” and notify 4 attendees?"


def test_calendar_events_searches_within_a_bound_and_reports_truncation(monkeypatch) -> None:  # noqa: ANN001
    seen: dict[str, object] = {}

    class _Listing(_Calendar):
        async def list_events(self, **kwargs: object) -> dict[str, object]:
            seen.update(kwargs)
            return {"events": [], "truncated": True, "more_events_exist": "more exist"}

    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _Listing())
    result = asyncio.run(
        tools.calendar_events(
            _context(),
            start_at="2026-08-11T00:00:00",
            end_at="2026-08-18T00:00:00",
            query="dentist",
            limit=9_999,
        )
    )
    assert seen["query"] == "dentist"
    assert seen["max_results"] == 250
    assert result["truncated"] is True


async def test_calendar_next_page_retains_exact_search_and_refuses_a_foreign_conversation(
    monkeypatch,
) -> None:
    calls = []

    class Listing(_Calendar):
        async def list_events(self, **kwargs):
            calls.append(kwargs)
            return (
                {"events": [{"id": "event-1"}], "next_page_token": "cursor-1"}
                if len(calls) == 1
                else {"events": []}
            )

    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: Listing())
    context = _context()
    context.state["temp:one_execution_surface"] = "typed_chat"
    first = await tools.calendar_events(
        context,
        start_at="2026-08-11T00:00:00Z",
        end_at="2026-08-18T00:00:00Z",
        query="dentist",
        limit=12,
    )
    assert first["status"] == "ok"
    assert first["next_page_available"] and "next_page_token" not in first
    foreign = SimpleNamespace(state={**context.state, "hussh:conversation_id": "elsewhere"})
    rejected = await tools.calendar_events(foreign, next_page=True)
    assert rejected["reason_code"] == "calendar_page_required"
    assert len(calls) == 1
    assert (await tools.calendar_events(context, next_page=True))["status"] == "ok"
    assert calls[1] == {**calls[0], "page_token": "cursor-1"}
    assert (await tools.calendar_events(context, next_page=True))[
        "reason_code"
    ] == "calendar_page_required"


@pytest.mark.parametrize("value", ["Friday", "2026-03-08", "2026-03-08T02:30:00"])
async def test_invalid_calendar_time_returns_input_required_without_provider_io(monkeypatch, value):
    context = _context()
    context.state["hussh:timezone"] = "America/Los_Angeles"
    service = _Calendar()
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: service)
    result = await tools.calendar_events(context, start_at=value, end_at="2026-03-09T00:00:00Z")
    proposal = await tools.propose_calendar_event(
        context, title="Meeting", start_at=value, end_at="2026-03-09T00:00:00Z"
    )
    assert result["status"] == proposal["status"] == "input_required"
    assert service.last_list is None and service.proposal_payload is None


def test_invitation_ordinal_review_is_client_only_and_owner_conversation_grant_bound(monkeypatch):
    from hushh_mcp.agents.calendar.read_offer import STATE_INVITATION_OFFER
    from hushh_mcp.services import calendar_schedule_service

    calendar = _Calendar()
    event = {
        "id": "instance-id",
        "calendar_id": "selected-calendar",
        "title": "Client Sync",
        "response_status": "needsAction",
        "conflicts": [],
    }

    class Schedule:
        async def invitations(self, **kwargs):
            return {
                "events": [event],
                "account_email": "owner@example.com",
                "pending_count": 1,
                "complete": True,
                "start_at": "2030-10-14T00:00:00Z",
                "end_at": "2030-10-15T00:00:00Z",
            }

    schedule = Schedule()
    schedule.calendar = calendar
    from types import MethodType

    from hushh_mcp.services.google_calendar_service import GoogleCalendarService

    def bound_schedule(*, calendar: object):
        assert calendar is schedule.calendar
        return schedule

    monkeypatch.setattr(calendar_schedule_service, "CalendarScheduleService", bound_schedule)
    calendar.invitations = MethodType(GoogleCalendarService.invitations, calendar)
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    ctx = _context()
    ctx.state["hussh:conversation_id"] = "same-conversation"
    result = asyncio.run(tools.calendar_invitations(ctx))
    assert result["events"][0]["ordinal"] == 1
    assert result["directive"]["payload"]["type"] == "calendar.invitations"
    opened = asyncio.run(tools.open_calendar_invitation(ctx, 1, "accepted"))
    assert opened["status"] == "review_required"
    assert opened["directive"]["payload"] == {
        "type": "calendar.invitations",
        "filter": "all",
        "calendarId": "selected-calendar",
        "eventId": "instance-id",
        "decision": "accepted",
        "accountId": "default",
        "accountEmail": "owner@example.com",
        "timeZone": "Asia/Kolkata",
        "startAt": "2030-10-14T00:00:00Z",
        "endAt": "2030-10-15T00:00:00Z",
    }
    assert calendar.proposal_payload is None
    ctx.state["hussh:conversation_id"] = "another-conversation"
    assert (
        asyncio.run(tools.open_calendar_invitation(ctx, 1, "declined"))["status"]
        == "input_required"
    )
    ctx.state["hussh:conversation_id"] = "same-conversation"
    terms = asyncio.run(
        tools.open_calendar_invitation(
            ctx,
            1,
            "offer_times",
            alternative_date="2030-10-18",
            alternative_start_time="15:00",
            alternative_end_time="18:00",
            alternative_duration_minutes=45,
            organizer_message="Could we meet Friday after 3 PM?",
        )
    )
    assert terms["directive"]["payload"]["terms"] == {
        "date": "2030-10-18",
        "startTime": "15:00",
        "endTime": "18:00",
        "durationMinutes": 45,
        "message": "Could we meet Friday after 3 PM?",
    }
    ctx.state[STATE_INVITATION_OFFER]["created_at_ms"] = 1
    assert asyncio.run(tools.open_calendar_invitation(ctx, 1))["status"] == "input_required"
    changed = asyncio.run(
        tools.calendar_invitations(ctx, expected_account_email="changed@example.com")
    )
    assert changed["status"] == "connection_changed"
    assert ctx.state[STATE_INVITATION_OFFER] is None


@pytest.mark.parametrize(
    "value", ["", "invalid", "2026-03-08T02:30:00", "2026-11-01T01:30:00", "2026-11-01"]
)
@pytest.mark.parametrize(
    "name",
    [
        "propose_calendar_event",
        "propose_calendar_reschedule",
        "calendar_events",
        "calendar_availability",
        "calendar_free_slots",
    ],
)
def test_calendar_invalid_times_need_clarification_without_provider_calls(monkeypatch, value, name):
    def unavailable():
        raise AssertionError("Invalid input must be rejected before resolving a provider")

    monkeypatch.setattr(tools, "get_google_calendar_service", unavailable)
    context = _context()
    context.state["hussh:timezone"] = "America/New_York"
    kwargs = {"start_at": value, "end_at": "2026-12-01T15:30:00Z"}
    if name == "calendar_free_slots":
        kwargs["duration_minutes"] = 30
    if name == "propose_calendar_event":
        kwargs["title"] = "Planning"
    if name == "propose_calendar_reschedule":
        kwargs["event_id"] = "evt-1"
    result = asyncio.run(getattr(tools, name)(context, **kwargs))
    assert result["status"] == "input_required"
    assert f"{tools._STATE_PENDING_DIRECTIVE}:calendar" not in context.state


def test_calendar_explicit_removals_survive_tool_and_review(monkeypatch):
    calendar = _Calendar()
    context = _context()
    plan = {
        "event_id": "evt-1",
        "account_id": "default",
        "calendar_id": "primary",
        "start_at": "2026-12-02T16:00:00Z",
        "end_at": "2026-12-02T16:30:00Z",
        "attendees": [],
        "description": "",
        "location": "",
        "send_updates": True,
        "current_event": {
            "title": "Planning",
            "description": "Old agenda",
            "location": "Room 4",
            "attendees": [{"email": "guest@example.com"}],
        },
        "attendee_change": {"added": [], "removed": ["guest@example.com"], "result_count": 0},
    }

    async def propose(**kwargs):
        calendar.proposal_payload = kwargs["payload"]
        return {"proposal_id": "gcal_review", "expires_at": "2099-12-02T16:00:00Z", "plan": plan}

    calendar.propose = propose
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    _seed_event_offer(context, calendar)
    result = asyncio.run(
        tools.propose_calendar_reschedule(
            context,
            event_id="evt-1",
            start_at=plan["start_at"],
            end_at=plan["end_at"],
            attendees=[],
            description="",
            location="",
        )
    )
    assert calendar.proposal_payload["attendees"] == []
    assert calendar.proposal_payload["description"] == calendar.proposal_payload["location"] == ""
    review = result["directive"]["payload"]
    assert review["description"] == review["location"] == ""
    assert review["attendees"] == []
    assert review["locationCleared"] is True and review["descriptionCleared"] is True
    assert review["attendeesRemoved"] == ["guest@example.com"]


@pytest.mark.parametrize("change", ["missing", "expired", "grant", "event"])
def test_chat_mutations_refuse_unverified_source_without_primary_fallback(monkeypatch, change):
    calendar = _Calendar()
    context = _context()
    _seed_event_offer(context, calendar, calendar_id="secondary@example.com")
    if change == "missing":
        context.state.pop(STATE_EVENT_OFFER)
    elif change == "expired":
        context.state[STATE_EVENT_OFFER]["created_at_ms"] = 1
    elif change == "grant":
        context.state[STATE_EVENT_OFFER]["grant_binding"][-1] = "stale"
    else:
        context.state[STATE_EVENT_OFFER]["ids"] = ["another-event"]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    result = asyncio.run(tools.propose_calendar_cancellation(context, event_id="evt-1"))
    assert result["status"] == "input_required"
    assert calendar.proposal_payload is None


def test_owner_cloud_additional_booking_never_resolves_shared_service(monkeypatch):
    from hushh_mcp.services import calendar_account_board_service, pod_google_connections

    monkeypatch.setattr(pod_google_connections, "calendar_runs_locally", lambda: True)
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _Calendar())

    def forbidden(*args, **kwargs):
        raise AssertionError("Shared account factory must not run on owner cloud")

    monkeypatch.setattr(calendar_account_board_service, "account_schedule", forbidden)
    result = asyncio.run(
        tools.propose_calendar_event(
            _context(),
            title="Planning",
            start_at="2026-12-02T16:00:00Z",
            end_at="2026-12-02T16:30:00Z",
            account_id="account-b",
        )
    )
    assert (
        result["status"] == "input_required"
        and result["reason_code"] == "calendar_account_unavailable"
    )


def test_invalid_declared_calendar_zone_does_not_fall_back_to_utc(monkeypatch):
    context = _context()
    context.state["hussh:timezone"] = "Invalid/Zone"

    def forbidden():
        raise AssertionError("Invalid zone must be rejected before provider resolution")

    monkeypatch.setattr(tools, "get_google_calendar_service", forbidden)
    result = asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Planning",
            start_at="2026-12-02T16:00:00Z",
            end_at="2026-12-02T16:30:00Z",
        )
    )
    assert result["status"] == "input_required"


@pytest.mark.parametrize(
    "binding",
    [
        ("owner", "calendar", "subject", "connected", "connection-rev", "grant-rev", "account-b"),
        (
            "owner",
            "calendar",
            "subject",
            "credential",
            "grant",
            "calendar.events",
            "calendar.freebusy",
        ),
    ],
)
def test_mutation_references_preserve_every_account_and_owner_cloud_grant_component(
    monkeypatch, binding
):
    calendar = _Calendar()

    async def read_binding(**kwargs):
        return binding

    calendar._read_grant_binding = read_binding
    calendar.connections.read_grant_binding = read_binding
    context = _context()
    _seed_event_offer(context, calendar)
    seen = []

    async def propose(**kwargs):
        seen.append(kwargs)
        return {"proposal_id": "gcal_example"}

    calendar.propose = propose
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)
    asyncio.run(tools.propose_calendar_cancellation(context, event_id="evt-1"))
    assert seen[0]["expected_binding"] == binding
    assert context.state[STATE_EVENT_OFFER]["grant_binding"] == list(binding)
    context.state[STATE_EVENT_OFFER]["grant_binding"][-1] = "replaced"
    seen.clear()
    result = asyncio.run(tools.propose_calendar_cancellation(context, event_id="evt-1"))
    assert result["status"] == "input_required"
    assert seen == []


class _AccountCalendar(_Calendar):
    def __init__(self, account_id):
        super().__init__()
        self.account_id = account_id
        self.revision = "generation-1"
        self.connections.account_id = account_id
        self.last_propose = None

    async def _read_grant_binding(self, **_):
        return (
            "user-1",
            "calendar",
            self.account_id,
            "subject",
            "connected",
            self.revision,
            "scopes",
        )

    async def propose(self, **kwargs):
        self.last_propose = kwargs
        self.proposal_payload = kwargs["payload"]
        return {
            "proposal_id": "gcal_account",
            "expires_at": "2099-11-04T12:00:00Z",
            "plan": {
                **kwargs["payload"],
                "account_email": self.account_id + "@example.test",
                "connection_binding": list(await self._read_grant_binding()),
                "conflicts": [],
            },
        }

    async def invitations(self, **kwargs):
        return {
            "account_email": self.account_id + "@example.test",
            "start_at": "2099-11-04T00:00:00Z",
            "end_at": "2099-11-05T00:00:00Z",
            "complete": True,
            "pending_count": 1,
            "events": [
                {"calendar_id": "primary", "id": "event-1", "response_status": "needsAction"}
            ],
        }

    async def find_openings(self, **kwargs):
        return {
            "duration_minutes": 30,
            "openings": [
                {
                    "start_at": "2099-11-04T10:00:00Z",
                    "end_at": "2099-11-04T10:30:00Z",
                    "available_until": "2099-11-04T11:00:00Z",
                },
                {
                    "start_at": "2099-11-04T12:00:00Z",
                    "end_at": "2099-11-04T12:30:00Z",
                    "available_until": "2099-11-04T13:00:00Z",
                },
            ],
        }


def _account_ports(monkeypatch):
    ports = {key: _AccountCalendar(key) for key in ("default", "account-b", "account-c")}
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: ports["default"])
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.account_schedule",
        lambda account_id, **_: SimpleNamespace(calendar=ports[account_id]),
    )
    return ports


async def test_calendar_reads_resolve_the_named_account_and_keep_its_event_reference(monkeypatch):
    ports = _account_ports(monkeypatch)
    inventory = AsyncMock(
        return_value={
            "accounts": [
                {
                    "account_id": "default",
                    "google_email": "work@example.test",
                    "status": "connected",
                },
                {
                    "account_id": "account-b",
                    "google_email": "home@example.test",
                    "status": "connected",
                },
            ]
        }
    )
    ports["default"].connections.calendar_accounts_status = inventory
    context = _context()

    listed = await tools.calendar_events(
        context,
        start_at="2026-11-16T00:00:00+05:30",
        end_at="2026-11-17T00:00:00+05:30",
        account_id="Home@example.test",
        time_zone="Asia/Kolkata",
    )
    detailed = await tools.calendar_event_detail(context, ordinal=1, account_id="home@example.test")
    mismatch = await tools.calendar_event_detail(context, ordinal=1, account_id="work@example.test")

    assert listed["status"] == detailed["status"] == "ok"
    assert listed["account_id"] == detailed["account_id"] == "account-b"
    assert detailed["event"]["id"] == "event-1"
    assert mismatch["reason_code"] == "calendar_account_mismatch"
    assert ports["default"].last_list is ports["default"].last_detail is None
    assert (
        ports["account-b"].last_detail["expected_binding"]
        == await ports["account-b"]._read_grant_binding()
    )
    assert all(
        call.kwargs == {"user_id": "user-1", "include_pictures": False}
        for call in inventory.await_args_list
    )


@pytest.mark.parametrize("reference", ["other@example.test", "ome@example.test", []])
async def test_unknown_or_malformed_calendar_reference_does_not_fall_back(monkeypatch, reference):
    ports = _account_ports(monkeypatch)
    ports["default"].connections.calendar_accounts_status = AsyncMock(
        return_value={
            "accounts": [
                {
                    "account_id": "default",
                    "google_email": "home@example.test",
                    "status": "connected",
                },
            ]
        }
    )

    result = await tools.calendar_summary(_context(), account_id=reference)

    assert result["status"] == "input_required"
    assert result["reason_code"] == "calendar_account_unavailable"
    assert "directive" not in result
    assert all(port.last_list is None for port in ports.values())


async def test_stale_calendar_handle_does_not_offer_reconnect(monkeypatch):
    from hushh_mcp.services.google_calendar_service import GoogleCalendarService
    from hushh_mcp.services.google_connection_service import GoogleConnectionService

    db = SimpleNamespace(execute_raw=lambda *_: SimpleNamespace(data=[]))
    owner = GoogleConnectionService(db=db)
    calendar = GoogleCalendarService(db=db, connections=owner.for_calendar_account("stale"))
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.account_schedule",
        lambda _: SimpleNamespace(calendar=calendar),
    )

    result = await tools.calendar_summary(_context(), account_id="stale")

    assert result["status"] == "input_required"
    assert result["reason_code"] == "calendar_account_unavailable"
    assert "directive" not in result


async def test_named_calendar_read_on_private_pod_never_resolves_shared_inventory(monkeypatch):
    from hushh_mcp.services import pod_owner_cloud

    monkeypatch.setattr(pod_owner_cloud, "private_pod_runtime", lambda: True)
    service = AsyncMock(side_effect=AssertionError("Shared Calendar access from a private pod"))
    monkeypatch.setattr(tools, "get_google_calendar_service", service)

    result = await tools.calendar_summary(_context(), account_id="home@example.test")

    assert result["reason_code"] == "calendar_account_unavailable"
    service.assert_not_called()


def test_calendar_account_references_keep_their_own_sources_across_other_reads(monkeypatch):
    ports = _account_ports(monkeypatch)
    context = _context()
    assert (
        asyncio.run(tools.calendar_summary(context, account_id="account-b"))["account_id"]
        == "account-b"
    )
    asyncio.run(tools.calendar_calendars(context, account_id="account-c"))
    assert asyncio.run(tools.calendar_event_detail(context, ordinal=1))["account_id"] == "account-b"
    assert ports["account-b"].last_detail["event_id"] == "event-1"
    assert ports["default"].last_detail is None
    changed = asyncio.run(tools.propose_calendar_cancellation(context, event_id="event-1"))
    assert changed["status"] == "confirmation_required"
    assert ports["account-b"].proposal_payload["account_id"] == "account-b"
    assert ports["account-b"].last_propose["expected_binding"] == asyncio.run(
        ports["account-b"]._read_grant_binding()
    )
    mismatch = asyncio.run(tools.calendar_event_detail(context, ordinal=1, account_id="account-c"))
    assert mismatch["status"] == "input_required"
    assert ports["account-c"].last_detail is None
    # A calendar ordinal separately retains C, even though the latest event read was B.
    result = asyncio.run(
        tools.calendar_events(
            context,
            start_at="2099-11-04T00:00:00Z",
            end_at="2099-11-05T00:00:00Z",
            calendar_ordinal=1,
        )
    )
    assert result["account_id"] == "account-c"
    assert ports["account-c"].last_list["calendar_id"] == "team@example.com"


def test_calendar_invitation_reference_survives_a_read_on_another_account(monkeypatch):
    ports = _account_ports(monkeypatch)
    context = _context()
    listed = asyncio.run(tools.calendar_invitations(context, account_id="account-b"))
    assert listed["directive"]["payload"]["accountId"] == "account-b"
    asyncio.run(tools.calendar_summary(context, account_id="account-c"))
    opened = asyncio.run(tools.open_calendar_invitation(context, ordinal=1, decision="accepted"))
    assert opened["directive"]["payload"]["accountId"] == "account-b"
    assert (
        asyncio.run(tools.open_calendar_invitation(context, ordinal=1, account_id="account-c"))[
            "status"
        ]
        == "input_required"
    )
    ports["account-b"].revision = "reconnected"
    assert (
        asyncio.run(tools.open_calendar_invitation(context, ordinal=1))["status"]
        == "input_required"
    )


def test_calendar_fresh_ambiguous_account_requires_selection_without_provider_read(monkeypatch):
    ports = _account_ports(monkeypatch)

    async def inventory(**_):
        return {
            "accounts": [
                {"account_id": key, "google_email": key + "@example.test", "status": "connected"}
                for key in ports
            ]
        }

    ports["default"].connections.calendar_accounts_status = inventory
    result = asyncio.run(tools.calendar_summary(_context()))
    assert result["reason_code"] == "calendar_account_required"
    assert [item["account_id"] for item in result["accounts"]] == list(ports)
    assert all(port.last_list is None for port in ports.values())


def test_calendar_additional_account_permission_control_preserves_its_target(monkeypatch):
    ports = _account_ports(monkeypatch)

    async def missing(**_):
        raise GoogleConnectionError(
            "Renew access", status_code=403, reason_code="calendar_permission_required"
        )

    ports["account-b"].list_events = missing
    result = asyncio.run(tools.calendar_summary(_context(), account_id="account-b"))
    assert result["status"] == "connection_required"
    assert result["directive"]["payload"]["accountId"] == "account-b"
    assert ports["default"].last_list is None


async def _offered_openings(monkeypatch, zone="America/New_York"):
    ports = _account_ports(monkeypatch)
    context = _context()
    context.state["hussh:timezone"] = zone
    result = await tools.calendar_free_slots(
        context,
        start_at="2099-11-04T09:00:00Z",
        end_at="2099-11-04T17:00:00Z",
        duration_minutes=30,
        account_id="account-b",
    )
    assert result["status"] == "ok"
    return ports, context


@pytest.mark.parametrize("zone", ["America/New_York", "Asia/Calcutta"])
def test_calendar_slot_reference_retains_exact_account_interval_and_zone_after_restore(
    monkeypatch, zone
):
    import copy

    from hushh_mcp.agents.calendar.read_offer import STATE_OPENING_OFFER

    ports, context = asyncio.run(_offered_openings(monkeypatch, zone))
    original = copy.deepcopy(context.state[STATE_OPENING_OFFER])
    restored = SimpleNamespace(state=copy.deepcopy(context.state))
    restored.state["hussh:timezone"] = "Pacific/Auckland"
    result = asyncio.run(tools.propose_calendar_event(restored, title="Planning", slot_ordinal=2))
    assert result["status"] == "confirmation_required"
    payload = ports["account-b"].proposal_payload
    assert payload["start_at"] == "2099-11-04T12:00:00+00:00"
    assert payload["end_at"] == "2099-11-04T12:30:00+00:00"
    assert payload["account_id"] == "account-b"
    assert payload["opening_selection"]["calendar_ids"] == ["primary"]
    assert (
        payload["time_zone"]
        == result["directive"]["payload"]["timeZone"]
        == ("Asia/Kolkata" if zone == "Asia/Calcutta" else zone)
    )
    assert restored.state[STATE_OPENING_OFFER] == original
    assert ports["default"].last_propose is None


@pytest.mark.parametrize(
    "change",
    [
        "expired",
        "future",
        "owner",
        "chat",
        "binding",
        "account",
        "calendar",
        "boolean",
        "range",
        "mixed",
    ],
)
def test_calendar_slot_reference_rejects_invalid_or_substituted_selection(monkeypatch, change):
    from hushh_mcp.agents.calendar.read_offer import STATE_OPENING_OFFER

    ports, context = asyncio.run(_offered_openings(monkeypatch))
    offer = context.state[STATE_OPENING_OFFER]
    kwargs = {"title": "Planning", "slot_ordinal": 1}
    if change == "expired":
        offer["created_at_ms"] -= 300_001
    elif change == "future":
        offer["created_at_ms"] += 60_000
    elif change == "owner":
        context.state["hussh:user_id"] = "another-owner"
    elif change == "chat":
        context.state["hussh:conversation_id"] = "another-chat"
    elif change == "binding":
        ports["account-b"].revision = "new-grant"
    elif change == "account":
        kwargs["account_id"] = "account-c"
    elif change == "calendar":
        kwargs["calendar_id"] = "other"
    elif change == "boolean":
        kwargs["slot_ordinal"] = True
    elif change == "range":
        kwargs["slot_ordinal"] = 3
    elif change == "mixed":
        kwargs["start_at"] = "2099-11-04T10:00:00Z"
    result = asyncio.run(tools.propose_calendar_event(context, **kwargs))
    assert result["status"] in {"input_required", "failed"}
    assert all(port.last_propose is None for port in ports.values())
    assert context.state.get("hussh:pending_directive:calendar") is None


@pytest.mark.parametrize("replacement", ["empty", "failure", "invalid", "grant_change"])
def test_calendar_failed_opening_replacement_never_leaves_old_slot_usable(monkeypatch, replacement):
    from hushh_mcp.agents.calendar.read_offer import STATE_OPENING_OFFER

    ports, context = asyncio.run(_offered_openings(monkeypatch))

    async def replaced(**_):
        if replacement == "failure":
            raise TimeoutError()
        if replacement == "grant_change":
            ports["account-b"].revision = "new-grant"
        return {"openings": []}

    ports["account-b"].find_openings = replaced
    asyncio.run(
        tools.calendar_free_slots(
            context,
            start_at="bad" if replacement == "invalid" else "2099-11-04T09:00:00Z",
            end_at="2099-11-04T17:00:00Z",
            duration_minutes=30,
            account_id="account-b",
        )
    )
    assert context.state[STATE_OPENING_OFFER] is None
    assert (
        asyncio.run(tools.propose_calendar_event(context, title="Planning", slot_ordinal=1))[
            "status"
        ]
        == "input_required"
    )
    assert ports["account-b"].last_propose is None
