"""The calendar data door: a keyless pod reads UPCOMING EVENTS through the hub.

Calendar is the third specialist wired through the pod data door (location, then
email). Before it, a calendar question on a user-owned pod hit the keyless DB
wall: the calendar tools read the person's OAuth token from the hub's vault, a
pod has no vault credential, and the turn degraded (and, on an older image,
502'd). These tests pin what makes the door safe and useful:

  * the projection is FAIL-CLOSED -- no event id, no description (dial-ins and
    private notes live there), no location, no attendee address, no link crosses;
  * the reader answers the EXPECTED "no live read" cases (not connected / needs
    reauth, which is also what an insufficient scope means to the person) with a
    coded marker, and lets configuration faults propagate;
  * the scope, the broker, the relay and the pod's specialist map agree on one
    name ("calendar") and one scope ("cap.calendar.events.view");
  * the pod's summary is built from titles and times only, and says where a
    change is made, because the door is read-only by construction.
"""

from __future__ import annotations

import pytest

from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
from hushh_mcp.one_adk import pod_data_door_specialist as pod_side
from hushh_mcp.services import pod_data_door as door
from hushh_mcp.services.google_connection_service import GoogleConnectionError

# ruff: noqa: S105,S106 -- fixture strings, not credentials


def _event(**overrides):
    base = {
        "id": "evt_abc123",
        "etag": '"33445566"',
        "title": "Board prep",
        "description": "Dial-in 555-0100, PIN 4242. Discuss the Acme term sheet.",
        "location": "12 Private Lane, Kirkland",
        "start": {"dateTime": "2026-09-03T09:00:00-07:00", "timeZone": "America/Los_Angeles"},
        "end": {"dateTime": "2026-09-03T10:00:00-07:00", "timeZone": "America/Los_Angeles"},
        "status": "confirmed",
        "attendees": [{"email": "cfo@corp.example", "response_status": "accepted"}],
        "html_link": "https://calendar.google.com/event?eid=secret",
        "updated": "2026-09-01T12:00:00Z",
    }
    base.update(overrides)
    return base


def _raw(**overrides):
    base = {"connected": True, "time_zone": "America/Los_Angeles", "events": [_event()]}
    base.update(overrides)
    return base


# -- projection: fail-closed egress ---------------------------------------------


def test_projection_keeps_only_title_times_status_and_all_day() -> None:
    p = door.project_calendar_state(_raw())
    assert p["connected"] is True and p["time_zone"] == "America/Los_Angeles"
    e = p["events"][0]
    assert e["title"] == "Board prep"
    assert e["start"] == {"dateTime": "2026-09-03T09:00:00-07:00"}, "zone name dropped"
    assert e["end"] == {"dateTime": "2026-09-03T10:00:00-07:00"}
    assert e["status"] == "confirmed" and e["all_day"] is False
    for leaked in ("id", "etag", "description", "location", "attendees", "html_link", "updated"):
        assert leaked not in e, f"{leaked} must be dropped by omission"
    assert set(e) == {"title", "start", "end", "status", "all_day"}


def test_projection_never_carries_an_address_or_link_anywhere() -> None:
    flat = repr(door.project_calendar_state(_raw()))
    for secret in ("cfo@corp.example", "555-0100", "Private Lane", "eid=secret", "evt_abc123"):
        assert secret not in flat


def test_projection_marks_all_day_events_and_defaults_a_missing_title() -> None:
    p = door.project_calendar_state(
        _raw(events=[_event(title=None, start={"date": "2026-09-04"}, end={"date": "2026-09-05"})])
    )
    e = p["events"][0]
    assert e["title"] == "Untitled event"
    assert e["all_day"] is True and e["start"] == {"date": "2026-09-04"}


def test_projection_of_garbage_is_unavailable_not_a_crash() -> None:
    assert door.project_calendar_state(None) == {  # type: ignore[arg-type]
        "connected": False,
        "reason": "unavailable",
        "time_zone": None,
        "events": [],
    }
    p = door.project_calendar_state({"events": ["nope", 3, None]})
    assert p["events"] == [] and p["connected"] is True


def test_projection_carries_the_coded_reason_only_as_a_string() -> None:
    p = door.project_calendar_state({"connected": False, "reason": "needs_reauth", "events": []})
    assert p == {"connected": False, "reason": "needs_reauth", "time_zone": None, "events": []}
    assert door.project_calendar_state({"connected": False, "reason": {"x": 1}})["reason"] is None


# -- reader: the expected no-read cases are markers, faults propagate ---------------


class _FakeCalendar:
    def __init__(
        self,
        *,
        raise_status: int | None = None,
        listed: dict | None = None,
        raise_message: str = "nope",
    ):
        self.raise_status = raise_status
        self.raise_message = raise_message
        self.listed = listed if listed is not None else {"events": [_event()], "time_zone": "UTC"}
        self.calls: list[dict] = []

    async def list_events(self, *, user_id, start_at, end_at, max_results=50):
        self.calls.append(
            {"user_id": user_id, "start_at": start_at, "end_at": end_at, "max_results": max_results}
        )
        if self.raise_status is not None:
            raise GoogleConnectionError(self.raise_message, status_code=self.raise_status)
        return self.listed


@pytest.fixture
def fake_calendar(monkeypatch):
    holder: dict[str, _FakeCalendar] = {}

    def _install(fake: _FakeCalendar) -> _FakeCalendar:
        holder["fake"] = fake
        monkeypatch.setattr(
            "hushh_mcp.services.google_calendar_service.get_google_calendar_service",
            lambda: fake,
        )
        return fake

    return _install


@pytest.mark.asyncio
async def test_reader_lists_a_bounded_forward_window_for_the_owner(fake_calendar) -> None:
    fake = fake_calendar(_FakeCalendar())
    raw = await door._read_calendar("u-owner")
    assert raw["connected"] is True and raw["events"][0]["title"] == "Board prep"
    call = fake.calls[0]
    assert call["user_id"] == "u-owner" and call["max_results"] == 20
    assert call["start_at"] < call["end_at"]
    # A projection of what the reader returned still drops everything sensitive.
    assert "cfo@corp.example" not in repr(door.project_calendar_state(raw))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "message", "reason"),
    [
        (404, "nope", "not_connected"),
        # The connection service says 403 for both of these; the message decides.
        (403, "Connect Google Calendar first", "not_connected"),
        (403, "Additional Google Calendar permission is required", "needs_reauth"),
        (401, "Google Calendar connection needs reauthorization", "needs_reauth"),
    ],
)
async def test_reader_turns_expected_failures_into_coded_markers(
    fake_calendar, status, message, reason
):
    fake_calendar(_FakeCalendar(raise_status=status, raise_message=message))
    raw = await door._read_calendar("u-owner")
    assert raw == {"connected": False, "reason": reason, "events": []}


@pytest.mark.asyncio
async def test_reader_lets_configuration_faults_propagate(fake_calendar) -> None:
    fake_calendar(_FakeCalendar(raise_status=503))
    with pytest.raises(GoogleConnectionError):
        await door._read_calendar("u-owner")


@pytest.mark.asyncio
async def test_run_read_projects_the_calendar_door(fake_calendar) -> None:
    fake_calendar(_FakeCalendar())
    out = await door.run_pod_data_door_read("calendar", owner_id="u-owner")
    assert out["events"][0]["title"] == "Board prep"
    assert "attendees" not in out["events"][0]


# -- one name, one scope, across the hub, the relay and the pod ----------------------


def test_registry_broker_relay_and_pod_agree_on_the_calendar_door() -> None:
    from pathlib import Path

    from api.routes.one import pod_specialist

    assert door.POD_DATA_DOOR_READS["calendar"].project is door.project_calendar_state
    assert door._READERS["calendar"] is door._read_calendar
    assert pod_specialist._REQUIRED_SCOPE["calendar"] == "cap.calendar.events.view"
    assert resolve_scope_to_enum("cap.calendar.events.view").value == "cap.calendar.events.view"
    assert pod_side._SPECIALIST_DOOR_NAMES["agent_calendar"] == "calendar"
    assert pod_side._SUMMARIZERS["calendar"] is pod_side._format_calendar_summary
    relay = (Path(__file__).resolve().parents[1] / "api/routes/one/pod_relay.py").read_text()
    assert "CAP_CALENDAR_EVENTS_VIEW" in relay and 'data_door_grants["calendar"]' in relay


# -- the pod's summary: titles and times only, read-only by construction --------------


def test_summary_renders_titles_and_times_and_says_where_changes_are_made() -> None:
    text = pod_side._format_calendar_summary(door.project_calendar_state(_raw()))
    assert text.startswith("Coming up on your calendar: Board prep (Sep 03 at 09:00)")
    assert "Calendar screen" in text
    for secret in ("cfo@corp.example", "555-0100", "Private Lane", "eid=secret"):
        assert secret not in text


def test_summary_renders_all_day_events_and_caps_the_list() -> None:
    events = [_event(title=f"Event {i}") for i in range(10)]
    events.append(_event(title="Offsite", start={"date": "2026-09-04"}, end={"date": "2026-09-05"}))
    text = pod_side._format_calendar_summary(door.project_calendar_state(_raw(events=events)))
    assert "Event 0 (" in text and "Event 7 (" in text and "Event 8" not in text
    assert "and 3 more" in text


def test_summary_answers_connect_reconnect_and_empty_as_next_steps() -> None:
    f = pod_side._format_calendar_summary
    assert "isn't connected" in f({"connected": False, "reason": "not_connected", "events": []})
    assert "reconnecting" in f({"connected": False, "reason": "needs_reauth", "events": []})
    assert "couldn't reach" in f({"connected": False, "reason": "unavailable", "events": []})
    assert f({"connected": True, "events": []}) == (
        "Nothing is on your calendar for the next day and a half."
    )
    assert f("garbage") == "I could not read your calendar just now."  # type: ignore[arg-type]


def test_summary_survives_a_hostile_projection_without_leaking_it() -> None:
    hostile = {
        "connected": True,
        "events": [
            {"title": "Lunch", "start": {"dateTime": "not a time"}, "attendees": ["x@y.z"]},
            {"title": "Standup", "start": "2026-09-03"},
        ],
    }
    text = pod_side._format_calendar_summary(hostile)
    assert "Lunch (time unknown)" in text and "Standup (time unknown)" in text
    assert "x@y.z" not in text


# -- the bridge: an in-process tool that reaches the door in pod mode ----------------


class _Ctx:
    def __init__(self, state: dict | None = None) -> None:
        self.state = dict(state or {})


@pytest.fixture
def bridge(monkeypatch):
    """Control pod mode and the door from one place; record what the tool did."""
    state: dict = {
        "pod_mode": True,
        "payload": {"text": "Coming up: Board prep (Sep 03 at 09:00)."},
        "door_calls": [],
    }

    monkeypatch.setattr("hushh_mcp.runtime_settings.pod_mode", lambda: state["pod_mode"])

    async def _serve(agent_id, tool_context, *, broker=None):
        state["door_calls"].append(agent_id)
        return state["payload"]

    monkeypatch.setattr(
        "hushh_mcp.one_adk.pod_data_door_specialist.serve_specialist_via_data_door", _serve
    )
    return state


@pytest.mark.asyncio
async def test_calendar_summary_reads_through_the_door_in_pod_mode(bridge) -> None:
    from hushh_mcp.agents.calendar import tools

    db_calls: list[str] = []

    async def _db_call(user_id: str):
        db_calls.append(user_id)
        return {"status": "ok"}

    ctx = _Ctx({tools._STATE_USER_ID: "u-owner"})
    out = await tools._run_calendar_read(ctx, _db_call)

    assert bridge["door_calls"] == ["agent_calendar"]
    assert db_calls == [], "the keyless pod never touches the database"
    assert out["source"] == "data_door" and out["status"] == "ok"
    assert out["summary"].startswith("Coming up: Board prep")


@pytest.mark.asyncio
async def test_no_door_for_this_turn_reads_in_process_as_before(bridge) -> None:
    from hushh_mcp.agents.calendar import tools

    bridge["payload"] = None
    seen: list[str] = []

    async def _db_call(user_id: str):
        seen.append(user_id)
        return {"status": "ok", "events": []}

    out = await tools._run_calendar_read(_Ctx({tools._STATE_USER_ID: "u-owner"}), _db_call)
    assert bridge["door_calls"] == ["agent_calendar"] and seen == ["u-owner"]
    assert out == {"status": "ok", "events": []}


@pytest.mark.asyncio
async def test_the_hub_never_consults_the_door(bridge) -> None:
    from hushh_mcp.agents.calendar import tools

    bridge["pod_mode"] = False

    async def _db_call(user_id: str):
        return {"status": "ok", "events": ["hub read"]}

    out = await tools._run_calendar_read(_Ctx({tools._STATE_USER_ID: "u-owner"}), _db_call)
    assert bridge["door_calls"] == [] and out["events"] == ["hub read"]
