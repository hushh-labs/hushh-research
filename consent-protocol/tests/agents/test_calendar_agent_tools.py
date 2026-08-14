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
