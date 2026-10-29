"""Board booking is still the one-time Calendar proposal, now account-bound."""

from __future__ import annotations

import copy
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError


class Owner:
    def __init__(self, count: int) -> None:
        self.accounts = [
            {
                "account_id": name,
                "google_email": f"{name}@example.com",
                "status": "connected",
                "connected": True,
            }
            for name in ("default", "second", "third")[:count]
        ]
        self.bindings = {
            item["account_id"]: ("owner", item["account_id"], "grant-1") for item in self.accounts
        }
        self.busy: dict[str, list[tuple[datetime, datetime]]] = {}
        self.manage_denied: set[str] = set()
        self.roles: dict[str, str] = {}
        self.reads: list[tuple[str, list[str]]] = []

    async def calendar_accounts_status(self, *, user_id: str):
        assert user_id == "owner"
        return {"accounts": copy.deepcopy(self.accounts)}


class BoundConnections:
    def __init__(self, owner: Owner, account_id: str) -> None:
        self.owner, self.account_id = owner, account_id

    async def read_grant_binding(self, **_):
        return self.owner.bindings.get(self.account_id)

    async def access_token(self, *, access_level: str, **_):
        if access_level == "manage" and self.account_id in self.owner.manage_denied:
            raise GoogleConnectionError("Allow Calendar scheduling", status_code=403)
        return f"token-{self.account_id}"

    async def has_service_scope(self, **_):
        return True


class Schedule:
    _availability_options = staticmethod(CalendarScheduleService._availability_options)

    def __init__(self, owner: Owner, account_id: str) -> None:
        self.owner, self.account_id = owner, account_id
        self.calendar = SimpleNamespace(
            connections=BoundConnections(owner, account_id), _check_read_binding=self._check
        )

    async def _check(self, user_id: str, binding):
        if self.owner.bindings.get(self.account_id) != binding:
            raise GoogleConnectionError("Calendar connection changed", status_code=409)

    async def _read_binding(self, user_id: str):
        assert user_id == "owner"
        return self.owner.bindings.get(self.account_id)

    async def _included_calendars(self, user_id: str, *, binding):
        await self._check(user_id, binding)
        return [
            {
                "id": "primary",
                "primary": True,
                "access_role": self.owner.roles.get(self.account_id, "owner"),
            },
            {"id": "work", "access_role": "reader"},
        ]

    def _availability_selection(self, calendars, overrides=None):
        return CalendarScheduleService._availability_selection(self, calendars, overrides)

    async def _busy_intervals(self, *, user_id, start, end, calendar_ids, binding):
        await self._check(user_id, binding)
        self.owner.reads.append((self.account_id, calendar_ids))
        return self.owner.busy.get(self.account_id, [])


class Store:
    def __init__(self) -> None:
        self.plan = None
        self.claimed = False
        self.finished: list[bool] = []

    async def purge(self, **_):
        return None

    async def issue(self, *, plan, action, **_):
        assert action == "create"
        self.plan = copy.deepcopy(plan)
        return "gcal_board_review", datetime(2031, 1, 1, tzinfo=UTC)

    async def claim(self, **_):
        if self.claimed:
            return None
        self.claimed = True
        return {"action": "create", "plan": copy.deepcopy(self.plan)}

    async def finish(self, *, executed, **_):
        self.finished.append(executed)

    async def forget_executed(self, **_):
        return None


def setup(monkeypatch, count: int, target: str):
    owner, store = Owner(count), Store()
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.account_schedule",
        lambda account_id, _owner: Schedule(owner, account_id),
    )

    async def epoch(_):
        return 1

    async def effect(**_):
        return None

    monkeypatch.setattr("hushh_mcp.services.google_calendar_service.capture_value_epoch", epoch)
    monkeypatch.setattr("hushh_mcp.services.google_calendar_service.record_calendar_effect", effect)
    service = GoogleCalendarService(
        db=object(), connections=BoundConnections(owner, target), proposals=store
    )
    writes = []

    async def provider(**kwargs):
        writes.append(kwargs)
        return {"id": "created-on-selected-account", "summary": "Bug Bash"}

    monkeypatch.setattr(service, "_request", provider)
    return owner, store, service, writes


def payload(
    owner: Owner, target: str, *, meeting_type="google_meet", meeting_link="", attendees=None
):
    return {
        "account_id": target,
        "booking_source": "board",
        "checked_account_ids": [item["account_id"] for item in owner.accounts],
        "selected_date": "2030-10-21",
        "title": "Bug Bash",
        "start_at": "2030-10-21T12:00:00Z",
        "end_at": "2030-10-21T13:00:00Z",
        "time_zone": "UTC",
        "attendees": attendees or [],
        "description": "",
        "location": "",
        "meeting_type": meeting_type,
        "meeting_link": meeting_link,
        "send_updates": bool(attendees),
    }


@pytest.mark.parametrize("count,target", [(1, "default"), (2, "second"), (3, "third")])
@pytest.mark.asyncio
async def test_review_rechecks_every_account_and_writes_once_to_selected_account(
    monkeypatch, count, target
):
    owner, store, service, writes = setup(monkeypatch, count, target)
    review = await service.propose(user_id="owner", action="create", payload=payload(owner, target))
    assert review["plan"]["account_id"] == target
    assert {item["account_id"] for item in review["plan"]["board_accounts"]} == {
        item["account_id"] for item in owner.accounts
    }
    assert len(owner.reads) == count
    await service.execute(user_id="owner", proposal_id=review["proposal_id"], account_id=target)
    assert len(owner.reads) == 2 * count
    assert len(writes) == 1
    assert writes[0]["method"] == "POST" and writes[0]["path"] == "/calendars/primary/events"
    assert service.connections.account_id == target
    assert store.finished == [True]
    with pytest.raises(GoogleConnectionError, match="already used"):
        await service.execute(user_id="owner", proposal_id=review["proposal_id"], account_id=target)
    assert len(writes) == 1


@pytest.mark.asyncio
async def test_lone_additional_account_can_be_destination(monkeypatch):
    owner, _store, service, writes = setup(monkeypatch, 2, "second")
    owner.accounts = [item for item in owner.accounts if item["account_id"] == "second"]
    review = await service.propose(
        user_id="owner", action="create", payload=payload(owner, "second")
    )
    assert [item["account_id"] for item in review["plan"]["board_accounts"]] == ["second"]
    await service.execute(user_id="owner", proposal_id=review["proposal_id"], account_id="second")
    assert len(writes) == 1


@pytest.mark.asyncio
async def test_other_account_conflict_or_changed_grant_refuses_confirmation(monkeypatch):
    owner, store, service, writes = setup(monkeypatch, 3, "third")
    review = await service.propose(
        user_id="owner", action="create", payload=payload(owner, "third")
    )
    owner.busy["second"] = [
        (datetime(2030, 10, 21, 12, tzinfo=UTC), datetime(2030, 10, 21, 13, tzinfo=UTC))
    ]
    with pytest.raises(GoogleConnectionError, match="no longer free"):
        await service.execute(
            user_id="owner", proposal_id=review["proposal_id"], account_id="third"
        )
    assert not writes and store.finished == [False]

    owner, store, service, writes = setup(monkeypatch, 2, "second")
    review = await service.propose(
        user_id="owner", action="create", payload=payload(owner, "second")
    )
    owner.bindings["default"] = ("owner", "default", "revoked-grant")
    with pytest.raises(GoogleConnectionError, match="changed"):
        await service.execute(
            user_id="owner", proposal_id=review["proposal_id"], account_id="second"
        )
    assert not writes


@pytest.mark.asyncio
async def test_changed_account_set_and_read_only_destination_fail_closed(monkeypatch):
    owner, store, service, writes = setup(monkeypatch, 2, "second")
    review = await service.propose(
        user_id="owner", action="create", payload=payload(owner, "second")
    )
    owner.accounts.pop()
    with pytest.raises(GoogleConnectionError, match="accounts changed"):
        await service.execute(
            user_id="owner", proposal_id=review["proposal_id"], account_id="second"
        )
    assert not writes

    owner, _store, service, writes = setup(monkeypatch, 2, "second")
    owner.roles["second"] = "reader"
    with pytest.raises(GoogleConnectionError, match="writable"):
        await service.propose(user_id="owner", action="create", payload=payload(owner, "second"))
    assert not writes

    owner, _store, service, writes = setup(monkeypatch, 2, "second")
    owner.manage_denied.add("second")
    with pytest.raises(GoogleConnectionError, match="Allow Calendar scheduling"):
        await service.propose(user_id="owner", action="create", payload=payload(owner, "second"))
    assert not writes


@pytest.mark.asyncio
async def test_wrong_execute_account_cannot_use_review(monkeypatch):
    owner, store, service, writes = setup(monkeypatch, 2, "second")
    review = await service.propose(
        user_id="owner", action="create", payload=payload(owner, "second")
    )
    with pytest.raises(GoogleConnectionError, match="account changed"):
        await service.execute(
            user_id="owner", proposal_id=review["proposal_id"], account_id="default"
        )
    assert not writes and store.finished == [False]


@pytest.mark.parametrize("target", ["second", "third"])
@pytest.mark.asyncio
async def test_routes_dispatch_review_and_execute_to_selected_account(monkeypatch, target):
    from api.routes.one import calendar as route

    calls = []

    class Selected:
        async def propose(self, **kwargs):
            calls.append(("review", target, kwargs))
            return {"proposal_id": "gcal_selected_review"}

        async def execute(self, **kwargs):
            calls.append(("execute", target, kwargs))
            return {"action": "create", "event": {"id": "created"}}

    monkeypatch.setattr(route, "calendar_reads_via_door", lambda: False)
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.account_schedule",
        lambda account_id: SimpleNamespace(calendar=Selected()) if account_id == target else None,
    )
    source = payload(Owner(3), target)
    await route.proposal(
        route.CalendarProposal(user_id="owner", action="create", **source),
        token={"user_id": "owner"},
    )
    await route.execute(
        route.CalendarExecute(
            user_id="owner", proposal_id="gcal_selected_review", account_id=target
        ),
        token={"user_id": "owner"},
    )
    assert [item[:2] for item in calls] == [("review", target), ("execute", target)]
    assert calls[1][2]["account_id"] == target


def test_discord_and_personal_block_do_not_request_google_meet():
    service = GoogleCalendarService(
        db=object(), connections=BoundConnections(Owner(1), "default"), proposals=Store()
    )
    discord = service._validate_plan(
        action="create",
        payload=payload(
            Owner(1),
            "default",
            meeting_type="external_link",
            meeting_link="https://discord.com/channels/123456/987654",
        ),
    )
    event = service._event_payload(discord)
    assert event["location"] == "https://discord.com/channels/123456/987654"
    assert event["attendees"] == []
    assert "conferenceData" not in event
    in_person = payload(Owner(1), "default", meeting_type="in_person")
    in_person["location"] = "Office"
    assert "conferenceData" not in service._event_payload(
        service._validate_plan(action="create", payload=in_person)
    )


def test_board_review_uses_current_iana_zone_name():
    service = GoogleCalendarService(
        db=object(), connections=BoundConnections(Owner(1), "default"), proposals=Store()
    )
    source = payload(Owner(1), "default")
    source["time_zone"] = "Asia/Calcutta"
    plan = service._validate_plan(action="create", payload=source)
    assert plan["time_zone"] == "Asia/Kolkata"


@pytest.mark.asyncio
async def test_primary_conflicts_paginate_and_reject_incomplete_coverage(monkeypatch):
    service = GoogleCalendarService(
        db=object(), connections=BoundConnections(Owner(1), "default"), proposals=Store()
    )
    pages = []

    async def provider(**kwargs):
        pages.append(kwargs["params"].get("pageToken"))
        if len(pages) == 1:
            return {"items": [{"id": "first", "summary": "First"}], "nextPageToken": "next"}
        return {"items": [{"id": "second", "summary": "Second"}]}

    monkeypatch.setattr(service, "_request", provider)
    conflicts = await service._find_conflicts(
        user_id="owner", start_at="2030-10-21T12:00:00Z", end_at="2030-10-21T13:00:00Z"
    )
    assert [item["id"] for item in conflicts] == ["first", "second"]
    assert pages == [None, "next"]

    async def repeated(**_):
        return {"items": [], "nextPageToken": "same"}

    monkeypatch.setattr(service, "_request", repeated)
    with pytest.raises(GoogleConnectionError):
        await service._find_conflicts(
            user_id="owner", start_at="2030-10-21T12:00:00Z", end_at="2030-10-21T13:00:00Z"
        )

    async def empty(**_):
        return {}

    monkeypatch.setattr(service, "_request", empty)
    assert (
        await service._find_conflicts(
            user_id="owner", start_at="2030-10-21T12:00:00Z", end_at="2030-10-21T13:00:00Z"
        )
        == []
    )
