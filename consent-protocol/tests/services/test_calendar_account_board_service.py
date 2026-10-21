"""The combined Calendar board must not invent complete cross-account time."""

from copy import deepcopy

import pytest

from hushh_mcp.services import calendar_account_board_service as board_module
from hushh_mcp.services.calendar_account_board_service import (
    CalendarAccountBoardService,
    _conflicts,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError


def _event(account, event_id, start, end, *, uid=None, response="accepted", source_zone="UTC"):
    return {
        "account_id": account,
        "calendar_id": "primary",
        "id": event_id,
        "ical_uid": uid,
        "original_start_time": None,
        "start": {"dateTime": start},
        "end": {"dateTime": end},
        "source_time_zone": source_zone,
        "status": "confirmed",
        "attendees": [{"email": f"{account}@example.com", "response_status": response}],
    }


def test_mirrored_invitation_is_not_a_cross_account_conflict():
    first = _event("a", "one", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z", uid="shared")
    mirror = _event(
        "b", "two", "2026-10-21T15:30:00+05:30", "2026-10-21T16:30:00+05:30", uid="shared"
    )
    actual = _event("c", "three", "2026-10-21T10:30:00Z", "2026-10-21T11:30:00Z", uid="other")
    accounts = [
        {"status": "complete", "google_email": f"{name}@example.com", "events": [event]}
        for name, event in (("a", first), ("b", mirror), ("c", actual))
    ]
    pairs = _conflicts(accounts, "UTC")
    assert len(pairs) == 2
    assert all(
        {pair["left"]["event_id"], pair["right"]["event_id"]} != {"one", "two"} for pair in pairs
    )


class _Connections:
    def __init__(self):
        self.accounts = [
            {
                "account_id": name,
                "google_email": f"{name}@example.com",
                "status": "connected",
                "connected": True,
            }
            for name in ("default", "second", "third")
        ]

    async def calendar_accounts_status(self, *, user_id):
        assert user_id == "owner"
        return {"accounts": deepcopy(self.accounts)}


class _Schedule:
    def __init__(self, account_id, *, fail=False, change_binding=False):
        self.account_id = account_id
        self.fail = fail
        self.change_binding = change_binding
        self.reads = 0

    async def _read_binding(self, user_id):
        self.reads += 1
        return (
            user_id,
            self.account_id,
            "new" if self.change_binding and self.reads > 1 else "old",
        )

    async def today(self, **kwargs):
        assert kwargs["include_hidden_invitations"] is True
        return {"events": [], "calendars": [{"id": "primary"}], "unreadable_calendars": []}

    async def free_windows(self, **kwargs):
        assert kwargs["max_windows"] is None
        if self.fail:
            raise GoogleConnectionError("Provider unavailable", status_code=503)
        bounds = {
            "default": ("2026-10-21T10:00:00+00:00", "2026-10-21T12:00:00+00:00"),
            "second": ("2026-10-21T10:30:00+00:00", "2026-10-21T11:30:00+00:00"),
            "third": ("2026-10-21T11:00:00+00:00", "2026-10-21T13:00:00+00:00"),
        }[self.account_id]
        return {
            "windows": [{"start_at": bounds[0], "end_at": bounds[1]}],
            "calendar_options": [{"id": "primary", "availability_included": True}],
        }


@pytest.mark.asyncio
async def test_three_account_shared_time_is_exact_intersection(monkeypatch):
    schedules = {name: _Schedule(name) for name in ("default", "second", "third")}
    monkeypatch.setattr(
        board_module, "account_schedule", lambda account_id, connections: schedules[account_id]
    )
    result = await CalendarAccountBoardService(_Connections()).day(
        user_id="owner",
        date="2026-10-21",
        time_zone="UTC",
        duration_minutes=30,
    )
    assert result["complete"] is True
    assert result["conflicts_complete"] is True
    assert result["shared_free_windows"] == [
        {
            "start_at": "2026-10-21T11:00:00+00:00",
            "end_at": "2026-10-21T11:30:00+00:00",
        }
    ]
    assert all(schedule.reads == 2 for schedule in schedules.values())


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["provider", "generation"])
async def test_incomplete_account_never_produces_shared_free_time(monkeypatch, failure):
    schedules = {
        name: _Schedule(
            name,
            fail=name == "third" and failure == "provider",
            change_binding=name == "third" and failure == "generation",
        )
        for name in ("default", "second", "third")
    }
    monkeypatch.setattr(
        board_module, "account_schedule", lambda account_id, connections: schedules[account_id]
    )
    result = await CalendarAccountBoardService(_Connections()).day(
        user_id="owner",
        date="2026-10-21",
        time_zone="UTC",
    )
    assert result["complete"] is False
    assert result["conflicts_complete"] is False
    assert result["shared_free_windows"] == []
    assert result["accounts"][2]["status"] == "incomplete"
