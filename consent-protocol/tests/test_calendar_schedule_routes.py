"""Calendar Schedule routes keep owner and connector authority server-side."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import (
    require_firebase_auth,
    require_firebase_auth_read_only,
    require_vault_owner_token,
)
from api.routes.one import calendar, calendar_workspace


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(calendar.router)
    app.include_router(calendar_workspace.router)
    return app


def test_disconnect_revokes_only_calendar_for_the_authenticated_owner(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    class _Connections:
        async def disconnect_service(self, **kwargs: object) -> dict[str, object]:
            calls.append(kwargs)
            return {"connected": False, "status": "disconnected"}

    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: _Connections())
    app = _app()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"

    result = TestClient(app).post("/api/one/calendar/disconnect", json={"user_id": "owner"})

    assert result.status_code == 200
    assert calls == [{"user_id": "owner", "service": "calendar"}]


def test_disconnect_cannot_revoke_another_owners_calendar(monkeypatch) -> None:
    class _Connections:
        async def disconnect_service(self, **_: object) -> object:
            raise AssertionError("Cross-owner disconnect reached the provider")

    monkeypatch.setattr(calendar, "get_google_connection_service", lambda: _Connections())
    app = _app()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"

    result = TestClient(app).post("/api/one/calendar/disconnect", json={"user_id": "other"})

    assert result.status_code == 403


_TODAY = {"date": "2026-10-14", "time_zone": "Asia/Kolkata"}
_WINDOW = {**_TODAY, "start_time": "09:00", "end_time": "17:00", "duration_minutes": 30}
_REVIEW = {**_WINDOW, "event_id": "invitation", "calendar_id": "primary", "offer_times": False}
_CONFIRM = {"review_id": "a-valid-review-identifier", "review_token": "a" * 40}


@pytest.mark.parametrize(("path", "payload"), [
    ("/schedule/today", _TODAY),
    ("/schedule/availability", _WINDOW),
    ("/attendance/review", _REVIEW),
    ("/attendance/confirm", _CONFIRM),
])
def test_protected_schedule_actions_require_authentication(path: str, payload: dict) -> None:
    response = TestClient(_app()).post("/api/one/calendar" + path, json=payload)

    assert response.status_code == 401


@pytest.mark.parametrize(("path", "payload", "method"), [
    ("/schedule/today", _TODAY, "today"),
    ("/schedule/availability", _WINDOW, "free_windows"),
    ("/attendance/review", _REVIEW, "review"),
    ("/attendance/confirm", _CONFIRM, "confirm"),
])
def test_authenticated_token_owns_schedule_calls_not_a_body_account(
    monkeypatch, path: str, payload: dict, method: str
) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    class _Schedule:
        def __getattr__(self, name: str):
            async def call(**kwargs: object) -> dict:
                calls.append((name, kwargs))
                return {}
            return call

    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: _Schedule())
    app = _app()
    if path.startswith("/schedule/"):
        app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner"

        def unexpected_vault_authority():
            raise AssertionError("Schedule reads requested broad vault authority")

        app.dependency_overrides[require_vault_owner_token] = unexpected_vault_authority
    else:
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
        app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    response = TestClient(app).post(
        "/api/one/calendar" + path, json={**payload, "user_id": "body-attacker"},
    )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0][0] == method
    assert calls[0][1]["user_id"] == "owner"
    if path.startswith("/schedule/"):
        assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(("path", "payload"), [
    ("/schedule/today", _TODAY),
    ("/schedule/availability", _WINDOW),
])
def test_schedule_reads_reject_vault_authority_without_verified_firebase_identity(
    monkeypatch, path: str, payload: dict
) -> None:
    def unexpected_service():
        raise AssertionError("Unverified Firebase owner reached Schedule service")

    monkeypatch.setattr(calendar_workspace, "_schedule", unexpected_service)
    app = _app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "vault-owner"}
    response = TestClient(app).post(
        "/api/one/calendar" + path,
        headers={"X-Hushh-Consent": "Bearer valid-vault-owner-capability"},
        json=payload,
    )

    assert response.status_code == 401


@pytest.mark.parametrize(("path", "payload"), [
    ("/attendance/review", _REVIEW),
    ("/attendance/confirm", _CONFIRM),
])
def test_firebase_schedule_authority_alone_cannot_change_attendance(
    monkeypatch, path: str, payload: dict
) -> None:
    def unexpected_service():
        raise AssertionError("Firebase-only attendance reached Calendar service")

    monkeypatch.setattr(calendar_workspace, "_schedule", unexpected_service)
    app = _app()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    response = TestClient(app).post("/api/one/calendar" + path, json=payload)

    assert response.status_code == 401


@pytest.mark.parametrize(("path", "payload"), [
    ("/attendance/review", _REVIEW),
    ("/attendance/confirm", _CONFIRM),
])
def test_mail_capable_attendance_rejects_mismatched_firebase_and_vault_owners(
    monkeypatch, path: str, payload: dict
) -> None:
    def unexpected_service():
        raise AssertionError("Mismatched Mail owner reached Calendar service")

    monkeypatch.setattr(calendar_workspace, "_schedule", unexpected_service)
    app = _app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "vault-owner"}
    app.dependency_overrides[require_firebase_auth] = lambda: "other-firebase-owner"

    result = TestClient(app).post("/api/one/calendar" + path, json=payload)

    assert result.status_code == 403


def test_public_rescheduling_options_use_capability_without_owner_login_and_disable_caching(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    class _Schedule:
        async def public_options(self, **kwargs: object) -> dict[str, object]:
            calls.append(kwargs)
            return {"openings": [], "time_zone": "UTC", "reply_to": "owner@example.com"}

    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: _Schedule())
    response = TestClient(_app()).post("/api/one/calendar/rescheduling/options", json={"token": "a" * 40})

    assert response.status_code == 200
    assert calls == [{"token": "a" * 40}]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_mail_permission_failure_stays_typed_and_does_not_look_like_calendar_failure(monkeypatch) -> None:
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    class _Schedule:
        async def review(self, **_: object) -> dict:
            raise GmailApiError(
                "Allow Mail sending before offering another time.",
                status_code=409,
                code="GMAIL_SEND_PERMISSION_REQUIRED",
            )

    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: _Schedule())
    app = _app()
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"

    result = TestClient(app).post("/api/one/calendar/attendance/review", json={**_REVIEW, "offer_times": True})

    assert result.status_code == 409
    assert result.json()["detail"]["reason_code"] == "GMAIL_SEND_PERMISSION_REQUIRED"
    assert result.json()["detail"]["message"] == "Allow Mail sending before offering another time."
