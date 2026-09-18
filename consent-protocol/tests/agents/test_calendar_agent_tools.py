from __future__ import annotations

import asyncio
from types import SimpleNamespace

from hushh_mcp.agents.calendar import tools
from hushh_mcp.services.google_connection_service import GoogleConnectionError


class _Calendar:
    def __init__(self) -> None:
        self.proposal_payload: dict[str, object] | None = None

    async def list_events(self, **kwargs: object) -> dict[str, object]:
        return {"events": [{"id": "event-1", "title": "Planning"}], "time_zone": "Asia/Kolkata"}

    async def freebusy(self, **kwargs: object) -> dict[str, object]:
        return {"calendars": {"primary": {"busy": []}}}

    async def find_openings(self, **kwargs: object) -> dict[str, object]:
        return {
            "duration_minutes": kwargs["duration_minutes"],
            "openings": [{"start_at": "2026-08-11T10:00:00Z", "end_at": "2026-08-11T10:30:00Z"}],
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
        raise GoogleConnectionError("Connect Google Calendar first", status_code=403)


class _RateLimitedCalendar:
    async def list_events(self, **kwargs: object) -> dict[str, object]:
        # Not 401/403 -- _handle_connection_error returns None for this, so
        # this exercises the "no connect directive applies" fallback rather
        # than the reauth path _UnavailableCalendar exercises above.
        raise GoogleConnectionError("Too many requests", status_code=429)


class _FlakyCalendar:
    async def list_events(self, **kwargs: object) -> dict[str, object]:
        # Not a GoogleConnectionError at all -- what the underlying HTTP
        # client itself raises on a timeout or connection failure.
        raise TimeoutError("connect timed out")


def test_calendar_summary_fails_clean_on_a_non_reauth_provider_error(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _RateLimitedCalendar())

    result = asyncio.run(tools.calendar_summary(_context()))

    assert result == {"status": "failed", "message": tools._CALENDAR_UNAVAILABLE_MESSAGE}


def test_calendar_summary_fails_clean_on_an_unexpected_exception(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _FlakyCalendar())

    result = asyncio.run(tools.calendar_summary(_context()))

    assert result == {"status": "failed", "message": tools._CALENDAR_UNAVAILABLE_MESSAGE}


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
    return SimpleNamespace(state={"hussh:user_id": "user-1", "hussh:timezone": "Asia/Kolkata"})


def test_calendar_summary_uses_authenticated_state_and_never_uses_a_token(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: _Calendar())

    result = asyncio.run(tools.calendar_summary(_context(), days=3))

    assert result["status"] == "ok"
    assert result["events"] == [{"id": "event-1", "title": "Planning"}]


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


class _ReadOnlyCalendar:
    async def propose(self, **kwargs: object) -> dict[str, object]:
        raise GoogleConnectionError(
            "Additional Google Calendar permission is required", status_code=403
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


def test_calendar_cancel_directive_reads_structured_fields_from_the_fetched_event(monkeypatch) -> None:  # noqa: ANN001
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
                    "attendees": [
                        {"email": "person@example.com", "response_status": "accepted"}
                    ],
                },
            },
        }

    calendar.propose = propose  # type: ignore[method-assign]
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: calendar)

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


def test_display_time_does_not_use_platform_specific_strftime_directives() -> None:
    """Regression: %-d/%-I are glibc/BSD strftime extensions Windows' C
    runtime raises ValueError on, which crashed every Calendar confirmation
    message on a Windows-hosted server."""

    rendered = tools._display_time("2026-08-11T09:05:00+05:30", "Asia/Kolkata")

    assert rendered == "Tue, Aug 11 at 9:05 AM IST"


def test_display_time_strips_leading_zero_from_single_digit_hour_and_day() -> None:
    rendered = tools._display_time("2026-01-02T14:30:00+00:00", "UTC")

    assert rendered == "Fri, Jan 2 at 2:30 PM UTC"
