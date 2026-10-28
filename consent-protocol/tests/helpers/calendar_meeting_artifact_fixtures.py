"""Synthetic selected-account Calendar/Meet/Drive meeting fixtures."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from hushh_mcp.services import calendar_meeting_artifacts as artifacts_module
from hushh_mcp.services.calendar_insights_service import CalendarInsightsService
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import CalendarGrantIdentity

BINDING = ("owner", "calendar", "google-subject", "stamp", "generation", "revision")
GRANT = CalendarGrantIdentity("owner", "default", "google-subject", BINDING)
EVENT = {
    "id": "event",
    "summary": "Review",
    "iCalUID": "review-uid",
    "start": {"dateTime": "2026-10-14T10:00:00Z"},
    "end": {"dateTime": "2026-10-14T11:00:00Z"},
    "conferenceData": {
        "conferenceId": "abc-defg-hij",
        "conferenceSolution": {"key": {"type": "hangoutsMeet"}},
    },
}
RECORD = {
    "name": "conferenceRecords/a",
    "startTime": "2026-10-14T10:05:00Z",
    "endTime": "2026-10-14T10:55:00Z",
}


def setup(account_id="default"):
    grant = CalendarGrantIdentity("owner", account_id, "google-subject", BINDING)
    calendar = SimpleNamespace(
        connections=SimpleNamespace(
            read_calendar_grant_identity=AsyncMock(return_value=grant),
            access_token=AsyncMock(return_value="synthetic-token"),
            status=AsyncMock(return_value={"google_email": "selected@example.test"}),
        ),
        _check_read_binding=AsyncMock(),
        _event_summary=GoogleCalendarService._event_summary,
        _request=AsyncMock(return_value=EVENT),
        list_events=AsyncMock(return_value={"events": [], "next_page_token": None}),
    )
    schedule = SimpleNamespace(
        calendar=calendar,
        _read_binding=AsyncMock(return_value=BINDING),
        _included_calendars=AsyncMock(return_value=[{"id": "primary", "access_role": "owner"}]),
        _seal=CalendarScheduleService._seal,
        _open=CalendarScheduleService._open,
    )
    insights = CalendarInsightsService(schedule, account_id=account_id)
    insights.events = AsyncMock(
        return_value=(
            [{**GoogleCalendarService._event_summary(EVENT), "calendar_id": "primary"}],
            True,
        )
    )
    drive = SimpleNamespace(
        get_file_facts=AsyncMock(), get_metadata=AsyncMock(), read_live_bytes=AsyncMock()
    )
    return (
        insights,
        artifacts_module.CalendarMeetingArtifacts(insights=insights, drive=drive),
        drive,
    )


def run(coroutine):
    return asyncio.run(coroutine)
