"""Real invitation service contracts with synthetic Google/DB/Mail boundaries."""

from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace

import pytest

from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from tests.services.test_calendar_attendance_service import _confirm, _service


def event(identifier="invite", response="needsAction", **changes):
    return {
        "id": identifier,
        "etag": '"v1"',
        "title": identifier,
        "status": "confirmed",
        "ical_uid": identifier,
        "organizer": {"email": "organizer@example.com"},
        "start": {"dateTime": "2030-10-14T10:00:00Z"},
        "end": {"dateTime": "2030-10-14T10:45:00Z"},
        "attendees": [{"email": "owner@example.com", "response_status": response, "self": True}],
        **changes,
    }


class Reader:
    def __init__(self):
        self.db = object()
        self.binding = ("owner", "calendar", "google", "connected", "revision", "grant")

        async def status(**_):
            return {"google_email": "owner@example.com"}

        async def binding(**_):
            return self.binding

        self.connections = SimpleNamespace(status=status, read_grant_binding=binding)
        self.calls = []
        self.pages = {
            ("primary", None): {
                "events": [
                    event(),
                    event("responded", "declined"),
                    event("organized", organizer={"email": "OWNER@example.com", "self": True}),
                    event("cancelled", status="cancelled"),
                ],
                "next_page_token": "page2",
            },
            ("primary", "page2"): {
                "events": [
                    event(
                        "recurring_20301014",
                        recurring_event_id="series",
                        original_start_time={"dateTime": "2030-10-14T10:00:00Z"},
                    )
                ]
            },
            ("work", None): {
                "events": [
                    event("copy", ical_uid="invite"),
                    event(
                        "shared-foreign", attendees=[{"email": "someone@example.com", "self": True}]
                    ),
                    event("conflict", attendees=[]),
                    event("transparent", attendees=[], transparency="transparent"),
                ]
            },
        }

    async def _check_read_binding(self, user_id, expected):
        assert user_id == "owner"
        if expected != self.binding:
            raise GoogleConnectionError("Connection changed", status_code=409)

    async def list_calendars(self, **kwargs):
        return {
            "calendars": [
                {
                    "id": "owner@example.com",
                    "primary": True,
                    "access_role": "owner",
                    "name": "Personal",
                },
                {"id": "work", "access_role": "reader", "name": "Work"},
            ]
        }

    async def list_events(self, **kwargs):
        self.calls.append(kwargs)
        return copy.deepcopy(self.pages[(kwargs["calendar_id"], kwargs.get("page_token"))])


def test_upcoming_received_invites_expand_pages_keep_instances_and_exclude_organized_and_foreign():
    calendar = Reader()
    result = asyncio.run(
        CalendarScheduleService(calendar=calendar).invitations(
            user_id="owner", start_at="2030-10-14T00:00:00Z", end_at="2030-10-15T00:00:00Z"
        )
    )
    assert {e["id"] for e in result["events"]} == {"invite", "responded", "recurring_20301014"}
    assert result["pending_count"] == 2
    assert all(call["include_hidden_invitations"] for call in calendar.calls)
    invitation = next(e for e in result["events"] if e["id"] == "invite")
    assert invitation["calendar_id"] == "primary"
    assert {c["id"] for c in invitation["conflicts"]} == {
        "organized",
        "recurring_20301014",
        "shared-foreign",
        "conflict",
    }
    assert result["complete"] is True


def test_repeated_provider_page_is_not_reported_as_complete():
    calendar = Reader()
    calendar.pages[("primary", "page2")]["next_page_token"] = "page2"
    with pytest.raises(GoogleConnectionError, match="fully check"):
        asyncio.run(
            CalendarScheduleService(calendar=calendar).invitations(
                user_id="owner", start_at="2030-10-14T00:00:00Z", end_at="2030-10-15T00:00:00Z"
            )
        )


def test_binding_change_during_inventory_closes_read():
    calendar = Reader()
    original = calendar.list_events

    async def changed(**kwargs):
        calendar.binding = (*calendar.binding[:-1], "changed")
        return await original(**kwargs)

    calendar.list_events = changed
    with pytest.raises(GoogleConnectionError, match="Connection changed"):
        asyncio.run(
            CalendarScheduleService(calendar=calendar).invitations(
                user_id="owner", start_at="2030-10-14T00:00:00Z", end_at="2030-10-15T00:00:00Z"
            )
        )


@pytest.mark.parametrize("calendar_id", ["primary", "work/id"])
@pytest.mark.parametrize("response", ["accepted", "declined", "tentative"])
def test_rsvp_updates_only_connected_owners_attendee_on_selected_calendar(
    monkeypatch, calendar_id, response
):
    service, calendar, db, mail = _service(monkeypatch)
    calendar.event["attendees"][1]["self"] = calendar_id == "primary"
    calendar.event["attendees"][1]["responseStatus"] = "needsAction"

    async def inventory(*args, **kwargs):
        return [{"id": calendar_id, "access_role": "owner"}]

    async def conflicts(**kwargs):
        return [], []

    service._included_calendars = inventory
    service._invitation_conflicts = conflicts
    calendar._reject_new_conflicts = GoogleCalendarService._reject_new_conflicts
    original = calendar._request

    async def provider(**kwargs):
        result = await original(**kwargs)
        if kwargs["method"] == "PATCH":
            calendar.event["attendees"][1]["responseStatus"] = kwargs["payload"]["attendees"][0][
                "responseStatus"
            ]
            result = copy.deepcopy(calendar.event)
        return result

    calendar._request = provider
    before = copy.deepcopy(calendar.event)
    review = asyncio.run(
        service.review(
            user_id="owner", event_id="event/id", calendar_id=calendar_id, response_status=response
        )
    )
    assert not [r for r in calendar.requests if r["method"] == "PATCH"]
    result = _confirm(service, review)
    assert result["calendar"] == response and result["email"] == "not_sent"
    assert _confirm(service, review) == result
    patches = [r for r in calendar.requests if r["method"] == "PATCH"]
    assert len(patches) == 1
    assert patches[0]["payload"] == {
        "attendeesOmitted": True,
        "attendees": [{"email": "owner@example.com", "responseStatus": response}],
    }
    assert patches[0]["path"] == f"/calendars/{calendar_id.replace('/', '%2F')}/events/event%2Fid"
    assert patches[0]["headers"] == {"If-Match": before["etag"]}
    assert calendar.event["attendees"][0] == before["attendees"][0]
    assert calendar.event["attendees"][2] == before["attendees"][2]
    assert calendar.event["start"] == before["start"]
    assert not mail.sends


def test_accept_rechecks_conflicts_and_never_replaces_overlapping_meeting(monkeypatch):
    service, calendar, _, mail = _service(monkeypatch)
    calendar._reject_new_conflicts = GoogleCalendarService._reject_new_conflicts
    conflicts = [
        {
            "id": "existing",
            "calendar_id": "work",
            "title": "Existing meeting",
            "start": {"dateTime": "2030-10-14T10:00:00Z"},
            "end": {"dateTime": "2030-10-14T11:00:00Z"},
        }
    ]

    async def overlaps(**_):
        return copy.deepcopy(conflicts), []

    service._invitation_conflicts = overlaps
    review = asyncio.run(
        service.review(user_id="owner", event_id="event/id", response_status="accepted")
    )
    assert review["conflicts"] == conflicts
    conflicts.append({**conflicts[0], "id": "new"})
    result = _confirm(service, review)
    assert result["calendar"] == "failed"
    assert not [r for r in calendar.requests if r["method"] != "GET"]
    assert not mail.sends


@pytest.mark.parametrize("change", ["recurrence", "organizer", "foreign", "omitted"])
def test_attendance_rejects_series_masters_organizer_and_shared_calendar_self(monkeypatch, change):
    service, calendar, _, _ = _service(monkeypatch)
    if change == "recurrence":
        calendar.event["recurrence"] = ["RRULE:FREQ=WEEKLY"]
    if change == "organizer":
        calendar.event["organizer"]["email"] = "owner@example.com"
    if change == "foreign":
        calendar.event["attendees"][1]["email"] = "other-owner@example.com"
    if change == "omitted":
        calendar.event["attendeesOmitted"] = True
    with pytest.raises(GoogleConnectionError):
        asyncio.run(service.review(user_id="owner", event_id="event/id"))
    assert not [r for r in calendar.requests if r["method"] == "PATCH"]


def test_copy_identity_normalizes_recurring_instants_and_single_event_uids():
    from hushh_mcp.services.calendar_invitations import occurrence_key

    original = event(
        "instance", ical_uid="series", original_start_time={"dateTime": "2030-10-14T10:00:00Z"}
    )
    copy_event = {
        **original,
        "id": "another-copy",
        "original_start_time": {"dateTime": "2030-10-14T15:30:00+05:30"},
    }
    assert occurrence_key(original) == occurrence_key(copy_event)
    assert occurrence_key(event()) == occurrence_key(
        event(start={"dateTime": "2030-10-14T15:30:00+05:30"})
    )


def test_all_day_conflicts_use_source_calendar_zone():
    from hushh_mcp.services.calendar_invitations import conflicts_for

    invitation = event(
        start={"dateTime": "2030-10-16T00:00:00Z"}, end={"dateTime": "2030-10-16T01:00:00Z"}
    )
    tokyo = event(
        "tokyo",
        attendees=[],
        source_time_zone="Asia/Tokyo",
        start={"date": "2030-10-16"},
        end={"date": "2030-10-17"},
    )
    assert [
        e["id"]
        for e in conflicts_for(invitation, [tokyo], "owner@example.com", "America/Los_Angeles")
    ] == ["tokyo"]


def test_explicit_selected_copy_survives_deduplication_without_promoting_calendar_access():
    result = asyncio.run(
        CalendarScheduleService(calendar=Reader()).invitations(
            user_id="owner",
            start_at="2030-10-14T00:00:00Z",
            end_at="2030-10-15T00:00:00Z",
            selected_calendar_id="work",
            selected_event_id="copy",
        )
    )
    selected = next(e for e in result["events"] if e["ical_uid"] == "invite")
    assert (selected["calendar_id"], selected["id"]) == ("work", "copy")
    assert selected["can_respond"] is False
    assert result["pending_count"] == 2
