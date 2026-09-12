from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import calendar


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
        },
    )

    assert start.status_code == 200
    assert complete.status_code == 200
    assert calls == [
        ("start", {"service": "calendar", "access_level": "read"}),
        (
            "complete",
            {
                "user_id": "calendar-user",
                "service": "calendar",
                "access_level": "read",
                "server_auth_code": "one-time-code",
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
        },
    )

    assert response.status_code == 403
