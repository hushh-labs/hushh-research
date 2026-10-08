from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import calendar
from api.routes.one import calendar_reminders as reminders


def test_reminder_scheduler_requires_its_own_pinned_identity(monkeypatch):
    monkeypatch.setenv("CALENDAR_REMINDERS_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    app = _app()
    app.include_router(reminders.router)
    client = TestClient(app)
    assert client.post("/api/one/calendar/reminders/drain").status_code == 401
    claims = {
        "email": "calendar-meeting-reminders@hushh-pda-uat.iam.gserviceaccount.com",
        "email_verified": True,
        "aud": "https://api.uat.hushh.ai",
        "iss": "https://accounts.google.com",
    }
    monkeypatch.setattr(reminders, "_verify_oidc", lambda *_: claims)
    worker = SimpleNamespace(drain=AsyncMock(return_value={"accepted": 1}))
    monkeypatch.setattr(reminders, "CalendarReminderService", lambda: worker)
    accepted = client.post(
        "/api/one/calendar/reminders/drain", headers={"Authorization": "Bearer synthetic-oidc"}
    )
    assert accepted.status_code == 200 and accepted.headers["cache-control"] == "private, no-store"
    claims["email"] = "mail-scheduled-send@hushh-pda-uat.iam.gserviceaccount.com"
    assert (
        client.post(
            "/api/one/calendar/reminders/drain", headers={"Authorization": "Bearer synthetic-oidc"}
        ).status_code
        == 401
    )
    assert worker.drain.await_count == 1
    monkeypatch.setenv("CALENDAR_REMINDERS_ENABLED", "false")
    assert (
        client.post(
            "/api/one/calendar/reminders/drain", headers={"Authorization": "Bearer synthetic-oidc"}
        ).status_code
        == 404
    )


def test_reminder_preferences_bind_authenticated_owner_and_cannot_enable_without_worker(
    monkeypatch,
):
    app = _app()
    app.include_router(reminders.router)
    store = SimpleNamespace(
        preferences=AsyncMock(
            return_value={"enabled": False, "show_title": True, "time_zone": "UTC"}
        ),
        set_preferences=AsyncMock(),
    )
    monkeypatch.setattr(reminders, "CalendarReminderStore", lambda: store)
    monkeypatch.setenv("CALENDAR_REMINDERS_ENABLED", "false")
    client = TestClient(app)
    response = client.get("/api/one/calendar/reminders/preferences")
    assert response.status_code == 200 and response.json()["available"] is False
    store.preferences.assert_awaited_once_with("calendar-user")
    assert (
        client.put(
            "/api/one/calendar/reminders/preferences",
            json={"enabled": True, "show_title": True, "time_zone": "UTC"},
        ).status_code
        == 503
    )
    store.set_preferences.assert_not_awaited()


def test_existing_owner_can_hide_titles_while_rollout_is_suspended(monkeypatch):
    app = _app()
    app.include_router(reminders.router)
    prefs = {"enabled": True, "show_title": False, "time_zone": "UTC"}
    store = SimpleNamespace(
        preferences=AsyncMock(return_value={**prefs, "show_title": True}),
        set_preferences=AsyncMock(return_value=prefs),
    )
    monkeypatch.setattr(reminders, "CalendarReminderStore", lambda: store)
    monkeypatch.setenv("CALENDAR_REMINDERS_ENABLED", "false")
    response = TestClient(app).put("/api/one/calendar/reminders/preferences", json=prefs)
    assert response.status_code == 200 and response.json()["show_title"] is False
    store.set_preferences.assert_awaited_once_with("calendar-user", **prefs)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(calendar.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "calendar-user"
    return app


def test_calendar_native_connect_uses_the_authenticated_owner(monkeypatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    class _Connections:
        async def start_native(self, **kwargs):
            calls.append(("start", kwargs))
            return {
                "configured": True,
                "server_client_id": "calendar-client-id",
                "state": "synthetic-attempt-state",
                "service": "calendar",
                "access_level": "read",
            }

        async def complete_native(self, **kwargs):
            calls.append(("complete", kwargs))
            return {
                "configured": True,
                "connected": True,
                "status": "connected",
                "access_level": "read",
                "scope_csv": "calendar.events.readonly calendar.freebusy",
            }

    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: _Connections())
    client = TestClient(_app())

    start = client.post("/api/one/calendar/connect/native/start", json={"access_level": "read"})
    complete = client.post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "calendar-user",
            "access_level": "read",
            "server_auth_code": "one-time-code",
            "state": "synthetic-attempt-state",
        },
    )

    assert start.status_code == 200
    assert complete.status_code == 200
    assert calls == [
        ("start", {"user_id": "calendar-user", "service": "calendar", "access_level": "read"}),
        (
            "complete",
            {
                "user_id": "calendar-user",
                "service": "calendar",
                "access_level": "read",
                "server_auth_code": "one-time-code",
                "state": "synthetic-attempt-state",
            },
        ),
    ]


def test_calendar_native_complete_rejects_another_users_code(monkeypatch) -> None:
    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: object())

    response = TestClient(_app()).post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "different-user",
            "access_level": "read",
            "server_auth_code": "one-time-code",
            "state": "synthetic-attempt-state",
        },
    )

    assert response.status_code == 403


def test_legacy_native_completion_without_bound_state_is_rejected(monkeypatch) -> None:
    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: object())
    response = TestClient(_app()).post(
        "/api/one/calendar/connect/native/complete",
        json={
            "user_id": "calendar-user",
            "access_level": "read",
            "server_auth_code": "one-time-code",
        },
    )
    assert response.status_code == 422
