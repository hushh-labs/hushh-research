"""Chat reuses Board availability and its all-account confirmed booking fence."""

from __future__ import annotations

import copy
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.agents.calendar import opening_tools, tools
from hushh_mcp.agents.calendar.read_offer import STATE_OPENING_OFFER
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from tests.services.test_calendar_board_booking import Schedule, setup


class AvailabilitySchedule(Schedule):
    free_windows = CalendarScheduleService.free_windows
    _free_gaps = staticmethod(CalendarScheduleService._free_gaps)

    async def _busy_intervals(self, *, start, end, **kwargs):
        busy = await super()._busy_intervals(start=start, end=end, **kwargs)
        return [
            (max(start, left), min(end, right))
            for left, right in busy
            if left < end and right > start
        ]


def shared_setup(monkeypatch, count=3):
    owner, store, service, writes = setup(monkeypatch, count, "second")
    for item in owner.accounts:
        account_id = item["account_id"]
        owner.bindings[account_id] += ("scope-calendar-list", "scope-freebusy", "scope-manage")
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.account_schedule",
        lambda account_id, _owner: AvailabilitySchedule(owner, account_id),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.get_google_connection_service", lambda: owner
    )
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.get_google_connection_service",
        lambda: owner,
    )
    monkeypatch.setattr(tools, "_calendar_service", lambda account_id: service)
    context = SimpleNamespace(
        state={
            "hussh:user_id": "owner",
            "hussh:conversation_id": "chat",
            "hussh:timezone": "America/New_York",
        }
    )
    # Three maximal shared gaps; Board's exact durations become bounded slots.
    for account_id in owner.bindings:
        owner.busy[account_id] = [
            (datetime(2030, 10, 21, 12, tzinfo=UTC), datetime(2030, 10, 21, 13, tzinfo=UTC)),
            (datetime(2030, 10, 21, 15, tzinfo=UTC), datetime(2030, 10, 21, 16, tzinfo=UTC)),
        ]
    return owner, store, service, writes, context


async def offer_slots(context):
    result = await opening_tools.calendar_shared_free_slots(
        context, date="2030-10-21", duration_minutes=30
    )
    assert result["status"] == "ok", result
    assert result["complete"] is True
    return result


@pytest.mark.asyncio
async def test_shared_offer_restore_show_then_confirm_exact_destination_once(monkeypatch):
    owner, store, service, writes, context = shared_setup(monkeypatch)
    result = await offer_slots(context)
    assert result["openings"][1] == {
        "ordinal": 2,
        "start_at": "2030-10-21T13:00:00Z",
        "end_at": "2030-10-21T13:30:00Z",
        "available_until": "2030-10-21T15:00:00Z",
    }
    assert len(owner.reads) == 3  # One batched availability operation per account.
    assert "binding" not in str(result)
    original = copy.deepcopy(context.state[STATE_OPENING_OFFER])
    restored = SimpleNamespace(state=copy.deepcopy(context.state))
    restored.state["hussh:timezone"] = "Pacific/Auckland"
    detail = await opening_tools.calendar_opening_detail(restored, ordinal=2)
    assert detail["start_at"] == result["openings"][1]["start_at"]
    assert detail["time_zone"] == "America/New_York"
    assert store.plan is None and not writes
    ambiguous = await tools.propose_calendar_event(restored, title="Planning", slot_ordinal=2)
    assert ambiguous["reason_code"] == "calendar_account_required"
    assert store.plan is None and restored.state[STATE_OPENING_OFFER] == original
    review = await tools.propose_calendar_event(
        restored,
        title="Planning",
        slot_ordinal=2,
        account_id="second",
        attendees=["guest@example.test"],
    )
    assert review["status"] == "confirmation_required", review
    assert not writes and len(owner.reads) == 6
    assert "shared_opening_selection" not in review["plan"]
    assert "binding" not in str(review)
    assert review["directive"]["payload"]["timeZone"] == "America/New_York"
    assert (
        store.plan["shared_opening_selection"]["board_accounts"]
        == original["window"]["board_accounts"]
    )
    await service.execute(user_id="owner", proposal_id=review["proposal_id"], account_id="second")
    assert len(writes) == 1 and writes[0]["method"] == "POST"
    assert writes[0]["path"] == "/calendars/primary/events"
    assert len(owner.reads) == 9 and store.finished == [True]
    with pytest.raises(GoogleConnectionError, match="already used"):
        await service.execute(
            user_id="owner", proposal_id=review["proposal_id"], account_id="second"
        )
    assert len(writes) == 1


@pytest.mark.parametrize("phase", ["review", "execute"])
@pytest.mark.parametrize(
    "change", ["binding", "scope", "coverage", "accounts", "busy", "read_only"]
)
@pytest.mark.asyncio
async def test_shared_offer_changes_fail_before_provider_mutation(monkeypatch, phase, change):
    owner, store, service, writes, context = shared_setup(monkeypatch)
    await offer_slots(context)
    if phase == "execute":
        review = await tools.propose_calendar_event(
            context, title="Planning", slot_ordinal=2, account_id="second"
        )
        assert review["status"] == "confirmation_required", review
    if change in {"binding", "scope"}:
        owner.bindings["third"] += ("new-grant" if change == "binding" else "new-scope",)
    elif change == "coverage":
        original = AvailabilitySchedule._included_calendars

        async def expanded(self, *args, **kwargs):
            return [
                *await original(self, *args, **kwargs),
                {"id": "new-calendar", "access_role": "reader"},
            ]

        monkeypatch.setattr(AvailabilitySchedule, "_included_calendars", expanded)
    elif change == "accounts":
        owner.accounts.pop()
    elif change == "busy":
        owner.busy["third"] = [
            (datetime(2030, 10, 21, 13, tzinfo=UTC), datetime(2030, 10, 21, 14, tzinfo=UTC))
        ]
    elif change == "read_only":
        owner.roles["second"] = "reader"
    if phase == "review":
        result = await tools.propose_calendar_event(
            context, title="Planning", slot_ordinal=2, account_id="second"
        )
        assert result["status"] != "confirmation_required"
        assert store.plan is None and context.state.get("hussh:pending_directive:calendar") is None
    else:
        with pytest.raises(GoogleConnectionError):
            await service.execute(
                user_id="owner", proposal_id=review["proposal_id"], account_id="second"
            )
        assert store.finished == [False]
    assert not writes


@pytest.mark.parametrize(
    "failure",
    [
        "provider",
        "disconnected",
        "invalid_date",
        "invalid_zone",
        "invalid_state_zone",
        "invalid_duration",
        "invalid_limit",
        "empty",
    ],
)
@pytest.mark.asyncio
async def test_failed_or_empty_replacement_retires_shared_reference(monkeypatch, failure):
    owner, store, _service, writes, context = shared_setup(monkeypatch)
    await offer_slots(context)
    kwargs = {"date": "2030-10-21", "duration_minutes": 30}
    if failure == "provider":
        original = AvailabilitySchedule._busy_intervals

        async def unreadable(self, **kwargs):
            if self.account_id == "third":
                raise GoogleConnectionError(
                    "Unreadable", status_code=403, reason_code="calendar_unreadable"
                )
            return await original(self, **kwargs)

        monkeypatch.setattr(AvailabilitySchedule, "_busy_intervals", unreadable)
    elif failure == "disconnected":
        owner.accounts[2]["connected"] = False
    elif failure == "empty":
        for account_id in owner.bindings:
            owner.busy[account_id] = [
                (datetime(2030, 10, 21, 0, tzinfo=UTC), datetime(2030, 10, 23, 0, tzinfo=UTC))
            ]
    elif failure == "invalid_state_zone":
        context.state["hussh:timezone"] = "../UTC"
    else:
        kwargs.update(
            {
                "invalid_date": {"date": "tomorrow"},
                "invalid_zone": {"time_zone": "../UTC"},
                "invalid_duration": {"duration_minutes": True},
                "invalid_limit": {"limit": True},
            }[failure]
        )
    result = await opening_tools.calendar_shared_free_slots(context, **kwargs)
    assert not result.get("openings")
    assert context.state[STATE_OPENING_OFFER] is None
    rejected = await tools.propose_calendar_event(
        context, title="Planning", slot_ordinal=2, account_id="second"
    )
    assert rejected["status"] != "confirmation_required"
    assert store.plan is None and not writes


@pytest.mark.asyncio
async def test_earlier_account_reconnect_during_last_read_is_rejected(monkeypatch):
    owner, _store, _service, writes, context = shared_setup(monkeypatch)
    original = AvailabilitySchedule.free_windows

    async def reconnect(self, **kwargs):
        result = await original(self, **kwargs)
        if self.account_id == "third":
            owner.bindings["default"] += ("same-email-new-generation",)
        return result

    monkeypatch.setattr(AvailabilitySchedule, "free_windows", reconnect)
    result = await opening_tools.calendar_shared_free_slots(
        context, date="2030-10-21", duration_minutes=30
    )
    assert result["status"] != "ok" and not result.get("openings")
    assert context.state[STATE_OPENING_OFFER] is None and not writes


@pytest.mark.parametrize("runtime", ["door", "owner_cloud"])
@pytest.mark.asyncio
async def test_shared_read_never_reaches_hub_factory_in_private_runtime(monkeypatch, runtime):
    monkeypatch.setattr(
        "hushh_mcp.one_adk.pod_connector_tools.calendar_reads_via_door", lambda: runtime == "door"
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pod_google_connections.calendar_runs_locally",
        lambda: runtime == "owner_cloud",
    )

    def forbidden():
        pytest.fail("Private runtime reached shared account credentials")

    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.get_google_connection_service", forbidden
    )
    result = await opening_tools.calendar_shared_free_slots(
        SimpleNamespace(state={"hussh:user_id": "owner"}), date="2030-10-21", duration_minutes=30
    )
    assert result["status"] == "unavailable"


@pytest.mark.parametrize(
    "change",
    ["owner", "chat", "expired", "future", "boolean", "range", "times", "destination", "calendar"],
)
@pytest.mark.asyncio
async def test_shared_selection_rejects_unbound_or_substituted_reference(monkeypatch, change):
    _owner, store, _service, writes, context = shared_setup(monkeypatch)
    await offer_slots(context)
    kwargs = {"title": "Planning", "slot_ordinal": 2, "account_id": "second"}
    if change == "owner":
        context.state["hussh:user_id"] = "another-owner"
    elif change == "chat":
        context.state["hussh:conversation_id"] = "another-chat"
    elif change == "expired":
        context.state[STATE_OPENING_OFFER]["created_at_ms"] -= 300_001
    elif change == "future":
        context.state[STATE_OPENING_OFFER]["created_at_ms"] += 60_000
    elif change == "boolean":
        kwargs["slot_ordinal"] = True
    elif change == "range":
        kwargs["slot_ordinal"] = 4
    elif change == "times":
        kwargs["start_at"] = "2030-10-21T13:00:00Z"
    elif change == "destination":
        kwargs["account_id"] = "unverified-account"
    else:
        kwargs["calendar_id"] = "another-calendar"
    result = await tools.propose_calendar_event(context, **kwargs)
    assert result["status"] != "confirmation_required"
    assert store.plan is None and not writes


@pytest.mark.parametrize(
    "date,zone,hours",
    [
        ("2030-03-10", "America/New_York", 23),
        ("2030-11-03", "America/New_York", 25),
        ("2030-10-21", "Asia/Kolkata", 24),
    ],
)
@pytest.mark.asyncio
async def test_shared_civil_day_preserves_dst_boundaries(monkeypatch, date, zone, hours):
    owner, _store, _service, _writes, context = shared_setup(monkeypatch)
    owner.busy.clear()
    result = await opening_tools.calendar_shared_free_slots(
        context, date=date, time_zone=zone, duration_minutes=30
    )
    assert result["status"] == "ok"
    window = context.state[STATE_OPENING_OFFER]["window"]
    assert (
        datetime.fromisoformat(window["query_end"]) - datetime.fromisoformat(window["query_start"])
    ).total_seconds() == hours * 3600
    assert window["time_zone"] == zone
    assert result["openings"][0]["available_until"] == window["query_end"]


@pytest.mark.asyncio
async def test_owner_cloud_single_account_can_show_its_private_option(monkeypatch):
    from hushh_mcp.agents.calendar.read_offer import CalendarOpeningOffer

    binding = ("owner", "calendar", "native", "generation", "subject", "read-scope")
    port = SimpleNamespace(
        connections=SimpleNamespace(read_grant_binding=AsyncMock(return_value=binding))
    )
    offer = CalendarOpeningOffer.model_validate(
        {
            "owner_id": "owner",
            "conversation_id": "chat",
            "account_id": "default",
            "grant_binding": list(binding),
            "created_at_ms": int(time.time() * 1000),
            "window": {
                "calendar_id": "primary",
                "calendar_ids": ["primary"],
                "query_start": "2030-10-21T00:00:00Z",
                "query_end": "2030-10-22T00:00:00Z",
                "duration_minutes": 30,
                "time_zone": "UTC",
            },
            "slots": [
                {
                    "start_at": "2030-10-21T13:00:00Z",
                    "end_at": "2030-10-21T13:30:00Z",
                    "available_until": "2030-10-21T14:00:00Z",
                }
            ],
        }
    )
    context = SimpleNamespace(
        state={
            "hussh:user_id": "owner",
            "hussh:conversation_id": "chat",
            STATE_OPENING_OFFER: offer.model_dump(),
        }
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pod_google_connections.calendar_runs_locally", lambda: True
    )
    monkeypatch.setattr(
        "hushh_mcp.one_adk.pod_connector_tools.calendar_reads_via_door", lambda: False
    )
    # This models an already admitted owner-local turn, retaining the read port.
    monkeypatch.setattr(tools, "_serve_via_door", AsyncMock(return_value=None))
    monkeypatch.setattr(
        tools,
        "_calendar_service",
        lambda account_id: port if account_id == "default" else pytest.fail("Unexpected account"),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.get_google_connection_service",
        lambda: pytest.fail("Owner cloud reached hub"),
    )
    result = await opening_tools.calendar_opening_detail(context, ordinal=1)
    assert result["status"] == "ok" and result["start_at"] == offer.slots[0].start_at
    assert context.state.get("hussh:pending_directive:calendar") is None
