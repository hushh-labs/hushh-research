"""Real service/route/tool replay of sanitized Explorer captures, with local SQL."""

from __future__ import annotations

import asyncio
import copy
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.routes.one import calendar, calendar_workspace
from hushh_mcp.agents.calendar import tools
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError

FIXTURES = Path(__file__).parents[1] / "fixtures" / "calendar"
HOLIDAY = json.loads((FIXTURES / "freebusy_holiday_capture.json").read_text())
FULL_DAY = json.loads((FIXTURES / "freebusy_full_day_capture.json").read_text())


class ProposalStore:
    """Production claim SQL against disposable SQLite; only dialect is adapted."""

    def __init__(self, path):
        self.path = path
        with sqlite3.connect(path) as db:
            db.execute("""CREATE TABLE google_calendar_action_proposals (
                proposal_id TEXT PRIMARY KEY, user_id TEXT, action TEXT,
                payload_json TEXT, expected_event_etag TEXT, expires_at TEXT,
                status TEXT DEFAULT 'pending', executed_at TEXT)""")

    def execute_raw(self, sql, params=None):
        sql = sql.replace("CAST(:payload_json AS jsonb)", ":payload_json").replace(
            "NOW()", "CURRENT_TIMESTAMP"
        )
        with sqlite3.connect(self.path) as db:
            db.row_factory = sqlite3.Row
            cursor = db.execute(sql, params or {})
            rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        return SimpleNamespace(data=rows)


class Grant:
    binding = ("owner", "calendar", "subject", "connected", "connection-rev", "grant-rev")
    denied = False

    async def read_grant_binding(self, **kwargs):
        return self.binding

    async def access_token(self, **kwargs):
        if self.denied:
            raise GoogleConnectionError(
                "Permission required", status_code=403, reason_code="google_permission_required"
            )
        return "local-test-token"

    async def has_service_scope(self, **kwargs):
        return True


@pytest.fixture
def journey(monkeypatch, tmp_path):
    grant = Grant()
    inventory = copy.deepcopy(HOLIDAY["inventory"])
    state = {"error": None, "new_conflict": False, "requests": [], "mutations": []}
    real_client = httpx.AsyncClient

    def provider(request):
        path = request.url.path
        if path.endswith("/users/me/calendarList"):
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": item["id"],
                            "summary": item["name"],
                            "primary": item["primary"],
                            "accessRole": item["access_role"],
                            "timeZone": item["time_zone"],
                        }
                        for item in inventory
                    ]
                },
            )
        if path.endswith("/freeBusy"):
            payload = json.loads(request.content)
            state["requests"].append(payload)
            body = copy.deepcopy(FULL_DAY["response"])
            body["timeMin"], body["timeMax"] = payload["timeMin"], payload["timeMax"]
            for item in payload["items"]:
                identifier = item["id"]
                if identifier not in body["calendars"]:
                    body["calendars"][identifier] = copy.deepcopy(
                        HOLIDAY["before_response"]["calendars"].get(identifier, {"busy": []})
                    )
            body["calendars"] = {
                item["id"]: body["calendars"][item["id"]] for item in payload["items"]
            }
            if state["error"]:
                body["calendars"]["calendar-2"] = state["error"]
            if state["new_conflict"]:
                body["calendars"]["calendar-2"] = {
                    "busy": [{"start": "2030-01-17T08:35:00Z", "end": "2030-01-17T08:45:00Z"}]
                }
            return httpx.Response(200, json=body)
        if path.endswith("/calendars/primary/events"):
            if request.method == "GET":
                return httpx.Response(200, json={"items": []})
            state["mutations"].append(json.loads(request.content))
            return httpx.Response(
                200, json={"id": "local-event", "summary": "Call", "status": "confirmed"}
            )
        raise AssertionError(f"Unexpected provider route: {path}")

    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(provider), **kwargs),
    )
    service = GoogleCalendarService(
        db=ProposalStore(tmp_path / "proposals.sqlite"), connections=grant
    )
    schedule = CalendarScheduleService(calendar=service)
    monkeypatch.setattr(tools, "get_google_calendar_service", lambda: service)
    monkeypatch.setattr(calendar, "get_google_calendar_service", lambda: service)
    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: schedule)
    app = FastAPI()
    app.include_router(calendar.router)
    app.include_router(calendar_workspace.router)
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    return SimpleNamespace(
        service=service,
        schedule=schedule,
        grant=grant,
        state=state,
        inventory=inventory,
        client=TestClient(app),
    )


def propose():
    context = SimpleNamespace(
        state={
            "hussh:user_id": "owner",
            "hussh:timezone": "Asia/Kolkata",
            "hussh:conversation_id": "same-conversation",
        }
    )
    result = asyncio.run(
        tools.propose_calendar_event(
            context,
            title="Call",
            start_at="2030-01-17T14:00:00+05:30",
            end_at="2030-01-17T14:30:00+05:30",
            attendees=["guest@example.com"],
        )
    )
    return result, context


def confirm(journey, proposal_id):
    return journey.client.post(
        "/api/one/calendar/proposals/execute", json={"user_id": "owner", "proposal_id": proposal_id}
    )


@pytest.mark.parametrize("duration,count", [(15, 2), (30, 2), (60, 1)])
def test_free_time_route_queries_full_day_and_excludes_captured_late_busy(journey, duration, count):
    response = journey.client.post(
        "/api/one/calendar/schedule/availability",
        json={"date": "2030-01-17", "time_zone": "Asia/Kolkata", "duration_minutes": duration},
    )
    assert response.status_code == 200, response.json()
    result = response.json()
    assert journey.state["requests"] == [FULL_DAY["request"]]
    assert result["full_count"] == count
    assert result["windows"][0]["end_at"] == "2030-01-17T17:30:00Z"
    if count == 2:
        assert result["windows"][1]["start_at"] == "2030-01-17T18:00:00Z"
    assert len(result["calendar_options"]) == 5
    assert len(result["calendars"]) == 4


def test_chat_real_tool_preview_and_route_executor_once_with_pinned_meeting_window(journey):
    result, context = propose()
    assert result["status"] == "confirmation_required", result
    normalized = copy.deepcopy(result)
    normalized["proposal_id"] = "gcal_local_review"
    normalized["plan"]["conference_request_id"] = "meet_local_review"
    normalized["directive"]["payload"]["proposalId"] = "gcal_local_review"
    normalized["directive"]["payload"]["expiresAt"] = "2030-01-17T10:00:00Z"
    # The full-workspace SSE test consumes this exact service/tool result.
    assert normalized == json.loads((FIXTURES / "chat_proposal_result.json").read_text())
    payload = result["directive"]["payload"]
    assert payload["type"] == "calendar.execute_proposal"
    assert payload["attendees"] == ["guest@example.com"]
    assert payload["startAt"] == "2030-01-17T08:30:00Z"
    assert payload["endAt"] == "2030-01-17T09:00:00Z"
    assert payload["timeZone"] == "Asia/Kolkata"
    assert payload["conflicts"] == []
    assert context.state["hussh:pending_directive:calendar"] == result["directive"]
    assert journey.state["mutations"] == []
    journey.inventory.append(
        {
            "id": "en.usa#holiday@group.v.calendar.google.com",
            "name": "New",
            "primary": False,
            "access_role": "reader",
            "time_zone": "UTC",
        }
    )
    first = confirm(journey, payload["proposalId"])
    assert first.status_code == 200, first.json()
    assert confirm(journey, payload["proposalId"]).status_code == 409
    assert len(journey.state["mutations"]) == 1
    assert journey.state["mutations"][0]["attendees"] == [{"email": "guest@example.com"}]
    assert len(journey.state["requests"]) == 2
    assert journey.state["requests"][0] == journey.state["requests"][1]
    assert journey.state["requests"][0] == {
        "timeMin": "2030-01-17T08:30:00Z",
        "timeMax": "2030-01-17T09:00:00Z",
        "items": FULL_DAY["request"]["items"],
    }


@pytest.mark.parametrize("change", ["busy", "account", "removed", "added", "legacy"])
def test_confirmation_rechecks_conflicts_account_and_selected_inventory(journey, change):
    result, _ = propose()
    assert result["status"] == "confirmation_required", result
    if change == "busy":
        journey.state["new_conflict"] = True
    elif change == "account":
        journey.grant.binding = (*journey.grant.binding[:-1], "replacement-grant")
    elif change == "removed":
        journey.inventory.pop(0)
    elif change == "added":
        journey.inventory.append(
            {
                "id": "new-work",
                "name": "New work",
                "primary": False,
                "access_role": "reader",
                "time_zone": "UTC",
            }
        )
    else:
        plan = result["plan"]
        plan.pop("availability_calendar_ids")
        journey.service.db.execute_raw(
            "UPDATE google_calendar_action_proposals SET payload_json=:plan WHERE proposal_id=:id",
            {"plan": json.dumps(plan), "id": result["proposal_id"]},
        )
    response = confirm(journey, result["directive"]["payload"]["proposalId"])
    assert response.status_code == 409, response.json()
    assert not journey.state["mutations"]


@pytest.mark.parametrize(
    "error,reason",
    [
        ({"errors": [{"reason": "notFound"}]}, "calendar_unreadable"),
        ({"errors": [{"reason": "forbidden"}]}, "calendar_unreadable"),
        ({"errors": [{"reason": "internalError"}]}, "calendar_provider_unavailable"),
        ({"busy": None}, "calendar_invalid_response"),
    ],
)
def test_included_calendar_errors_block_both_callers_and_never_request_auth(journey, error, reason):
    journey.state["error"] = error
    result, context = propose()
    assert result["status"] == "failed"
    assert result["reason_code"] == reason
    assert "directive" not in result
    assert "hussh:pending_directive:calendar" not in context.state
    response = journey.client.post(
        "/api/one/calendar/schedule/availability",
        json={"date": "2030-01-17", "time_zone": "Asia/Kolkata"},
    )
    assert response.status_code >= 400
    assert response.json()["detail"]["reason_code"] == reason
    assert not journey.state["mutations"]


def test_included_calendar_failure_at_confirmation_blocks_execution(journey):
    result, _ = propose()
    journey.state["error"] = {"errors": [{"reason": "notFound"}]}
    response = confirm(journey, result["directive"]["payload"]["proposalId"])
    assert response.status_code == 502
    assert response.json()["detail"]["reason_code"] == "calendar_unreadable"
    assert not journey.state["mutations"]


def test_explicit_free_time_choice_is_preserved_and_denied_consent_cannot_execute(journey):
    holiday_id = HOLIDAY["inventory"][2]["id"]
    response = journey.client.post(
        "/api/one/calendar/schedule/availability",
        json={
            "date": "2030-01-17",
            "time_zone": "Asia/Kolkata",
            "calendar_overrides": {holiday_id: True},
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "calendar_unreadable"
    journey.grant.denied = True
    result, _ = propose()
    assert result["status"] == "connection_required"
    assert result["directive"]["payload"]["accessLevel"] == "manage"
    assert not journey.state["mutations"]


@pytest.mark.parametrize("invitation_duration", [False, True])
def test_invitation_availability_uses_same_holiday_selection_as_free_time(
    journey, invitation_duration
):
    result = asyncio.run(
        journey.schedule.availability(
            user_id="owner",
            date="2030-01-17",
            time_zone="Asia/Kolkata",
            start_time="00:00",
            end_time="24:00",
            duration_minutes=30,
            invitation_duration=invitation_duration,
        )
    )
    assert result["openings"]
    assert all("#holiday@" not in item["id"] for item in result["calendars"])
