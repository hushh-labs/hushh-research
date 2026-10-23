"""Google Calendar event types survive the provider summary boundary."""

from hushh_mcp.services.google_calendar_service import GoogleCalendarService


def test_calendar_event_summary_preserves_google_event_type():
    summary = GoogleCalendarService._event_summary(
        {
            "id": "birthday-1",
            "summary": "Birthday",
            "eventType": "birthday",
            "start": {"date": "2026-10-23"},
            "end": {"date": "2026-10-24"},
        }
    )
    assert summary["event_type"] == "birthday"
