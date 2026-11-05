"""Option generation, coverage and account selection through One's real SDK tools."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.agents.calendar import request_scope, tools
from hushh_mcp.services.calendar_opening_selection import instant
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from tests.agents.test_calendar_contract_matrix import sdk_turn
from tests.agents.test_calendar_request_scope import calendar_port, call
from tests.agents.test_calendar_shared_opening_tools import shared_setup

REAL_SCOPE = request_scope.request_scope


@pytest.mark.parametrize("limit,duration", [(1, 15), (3, 30), (20, 45), (3, 60)])
@pytest.mark.parametrize("account", ["default", "second"])
@pytest.mark.parametrize("coverage", ["complete", "forbidden", "missing"])
async def test_selected_account_options_use_verified_coverage(
    monkeypatch, limit, duration, account, coverage
):
    selected, other = calendar_port(monkeypatch), calendar_port(monkeypatch)

    async def busy(**kwargs):
        result = {key: {"busy": []} for key in kwargs["calendar_ids"]}
        result["team"]["busy"] = [{"start": "2030-11-06T05:30:00Z", "end": "2030-11-06T06:00:00Z"}]
        if coverage == "forbidden":
            result["team"] = {"errors": [{"reason": "forbidden"}]}
        elif coverage == "missing":
            result.pop("team")
        return {"calendars": result}

    selected.freebusy = AsyncMock(side_effect=busy)
    monkeypatch.setattr(
        tools, "_calendar_service", lambda key: selected if key == account else other
    )
    prompt = f"Show {limit} {duration}-minute options for the selected account; check its included calendars and do not prepare a booking."
    result, state, _ = await sdk_turn(
        monkeypatch,
        prompt,
        [
            [
                call(
                    "calendar_free_slots",
                    start_at="2030-11-06T09:00:00+05:30",
                    end_at="2030-11-06T18:00:00+05:30",
                    duration_minutes=duration,
                    limit=limit,
                    account_id=account,
                )
            ]
        ],
        selected,
    )
    response = result[-1].response
    other.freebusy.assert_not_awaited()
    assert not state.get("hussh:pending_directive:calendar")
    if coverage != "complete":
        assert response["status"] != "ok" and not response.get("openings")
        return
    assert response["account_id"] == account and response["calendar_ids"] == ["primary", "team"]
    capacity = 120 // duration + 390 // duration
    assert response["available_slot_count"] == capacity
    assert len(response["openings"]) == min(capacity, limit)
    assert response["coverage_complete"] is True
    assert response["suggestions_limited"] == (capacity > limit)
    private = state["hussh:calendar_opening_read_offer"]
    assert private["account_id"] == account and private["window"]["calendar_ids"] == [
        "primary",
        "team",
    ]
    for slot in response["openings"]:
        start, end = instant(slot["start_at"]), instant(slot["end_at"])
        assert (end - start).total_seconds() == duration * 60
        assert end <= instant("2030-11-06T05:30:00Z") or start >= instant("2030-11-06T06:00:00Z")


@pytest.mark.parametrize("accounts", [2, 3])
@pytest.mark.parametrize("limit,duration", [(1, 15), (3, 30), (20, 60)])
@pytest.mark.parametrize("complete", [True, False])
async def test_shared_account_sdk_options_separate_coverage_and_limits(
    monkeypatch, accounts, limit, duration, complete
):
    owner, _, service, writes, _ = shared_setup(monkeypatch, accounts)
    # The leaf fixture starts after assessment; this runner exercises the actual assessor.
    monkeypatch.setattr(request_scope, "request_scope", REAL_SCOPE)
    if not complete:
        owner.accounts[-1].update(status="reauthorization_required", connected=False)
    prompt = f"Across all connected accounts, show {limit} {duration}-minute choices. Reading only; no invitation or booking review."
    responses, state, _ = await sdk_turn(
        monkeypatch,
        prompt,
        [
            [
                call(
                    "calendar_shared_free_slots",
                    date="2030-10-21",
                    duration_minutes=duration,
                    limit=limit,
                    time_zone="America/New_York",
                )
            ]
        ],
        service,
    )
    response = responses[-1].response
    assert not writes and not state.get("hussh:pending_directive:calendar")
    assert response["coverage_complete"] is complete
    if not complete:
        assert not response["openings"] and "available_slot_count" not in response
        return
    capacity = 22 * 60 // duration
    assert response["available_slot_count"] == capacity
    assert len(response["openings"]) == min(limit, capacity)
    assert response["suggestions_limited"] == (capacity > limit)
    assert response["future_only"] is True
    assert len(response["accounts"]) == accounts
    assert response["openings"][0]["start_at"] == "2030-10-21T04:00:00Z"
    previous_end = None
    for slot in response["openings"]:
        start, end = instant(slot["start_at"]), instant(slot["end_at"])
        assert end - start == timedelta(minutes=duration)
        assert previous_end is None or previous_end <= start
        assert any(
            datetime(2030, 10, 21, left, tzinfo=UTC) <= start < end <= right
            for left, right in [
                (4, instant("2030-10-21T12:00:00Z")),
                (13, instant("2030-10-21T15:00:00Z")),
                (16, instant("2030-10-22T04:00:00Z")),
            ]
        )
        previous_end = end


@pytest.mark.parametrize("duration", [30, 1440])
async def test_batched_and_invitation_availability_use_the_same_expansion(monkeypatch, duration):
    port = calendar_port(monkeypatch)
    port.list_calendars.return_value["calendars"].extend({"id": f"extra-{i}"} for i in range(21))
    result = await CalendarScheduleService(calendar=port).availability(
        user_id="owner",
        date="2030-11-06",
        time_zone="UTC",
        start_time="00:00",
        end_time="24:00",
        duration_minutes=duration,
        invitation_duration=duration == 1440,
    )
    capacity = 1440 // duration
    assert len(result["openings"]) == min(capacity, 20)
    assert result["available_slot_count"] == capacity
    assert result["coverage_complete"] is True
    assert port.freebusy.await_count == 2


@pytest.mark.parametrize("date,hours", [("2030-03-10", 23), ("2030-11-03", 25)])
def test_full_civil_day_uses_dst_boundaries(date, hours):
    from hushh_mcp.services.calendar_opening_selection import opening_options
    from hushh_mcp.services.calendar_schedule_service import local_day_window

    start, end = local_day_window(date, "America/New_York")
    result = opening_options([(start, end)], 60, 20)
    assert (end - start).total_seconds() == hours * 3600
    assert result["available_slot_count"] == hours


@pytest.mark.parametrize("local", ["2030-03-10T02:30:00", "2030-11-03T01:30:00"])
def test_unqualified_dst_gap_or_fold_is_refused(local):
    from types import SimpleNamespace

    from hushh_mcp.services.google_connection_contract import GoogleConnectionError

    with pytest.raises(GoogleConnectionError):
        tools._calendar_iso(
            local, SimpleNamespace(state={"hussh:timezone": "UTC"}), "America/New_York"
        )


@pytest.mark.parametrize("value", ["2030-11-03T01:30:00-04:00", "2030-11-03T01:30:00-05:00"])
def test_explicit_fold_offset_is_preserved(value):
    from types import SimpleNamespace

    assert (
        tools._calendar_iso(
            value, SimpleNamespace(state={"hussh:timezone": "UTC"}), "America/New_York"
        )
        == value
    )
