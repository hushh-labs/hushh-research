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

pytestmark = pytest.mark.usefixtures("shared_hub_owner")


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
_FULL_DAY = {**_WINDOW, "start_time": "00:00", "end_time": "24:00"}
_REVIEW = {**_WINDOW, "event_id": "invitation", "calendar_id": "primary", "offer_times": False}
_CONFIRM = {"review_id": "a-valid-review-identifier", "review_token": "a" * 40}
_RSVP = {
    "event_id": "invitation",
    "calendar_id": "primary",
    "response_status": "accepted",
    "time_zone": "Asia/Kolkata",
}


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/invitations", {"time_zone": "Asia/Kolkata"}),
        ("/schedule/today", _TODAY),
        ("/schedule/availability", _FULL_DAY),
        ("/attendance/review", _REVIEW),
        ("/attendance/confirm", _CONFIRM),
        ("/attendance/rsvp/review", _RSVP),
        ("/attendance/rsvp/confirm", _CONFIRM),
        ("/attendance/workspace/review", _REVIEW),
        ("/attendance/workspace/confirm", _CONFIRM),
        (
            "/conflicts/workspace/review",
            {
                **_TODAY,
                "keep": {"account_id": "default", "calendar_id": "primary", "event_id": "keep"},
                "decline": [
                    {
                        "account_id": "default",
                        "calendar_id": "primary",
                        "event_id": "decline",
                        "message": "I cannot attend",
                    }
                ],
            },
        ),
        ("/conflicts/workspace/confirm", _CONFIRM),
    ],
)
def test_protected_schedule_actions_require_authentication(path: str, payload: dict) -> None:
    response = TestClient(_app()).post("/api/one/calendar" + path, json=payload)

    assert response.status_code == 401


@pytest.mark.parametrize(
    ("path", "payload", "method"),
    [
        ("/invitations", {"time_zone": "Asia/Kolkata"}, "invitations"),
        ("/schedule/today", _TODAY, "today"),
        ("/schedule/availability", _FULL_DAY, "free_windows"),
        ("/attendance/review", _REVIEW, "review"),
        ("/attendance/confirm", _CONFIRM, "confirm"),
    ],
)
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
    if path.startswith("/schedule/") or path == "/invitations":
        app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner"

        def unexpected_vault_authority():
            raise AssertionError("Schedule reads requested broad vault authority")

        app.dependency_overrides[require_vault_owner_token] = unexpected_vault_authority
    else:
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
        app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    response = TestClient(app).post(
        "/api/one/calendar" + path,
        json={**payload, "user_id": "body-attacker"},
    )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0][0] == method
    assert calls[0][1]["user_id"] == "owner"
    if path.startswith("/schedule/") or path == "/invitations":
        assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/schedule/today", _TODAY),
        ("/schedule/availability", _FULL_DAY),
    ],
)
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


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/attendance/review", _REVIEW),
        ("/attendance/confirm", _CONFIRM),
    ],
)
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


@pytest.mark.parametrize(
    ("path", "payload", "method"),
    [
        ("/attendance/rsvp/review", _RSVP, "review"),
        ("/attendance/rsvp/confirm", _CONFIRM, "confirm_rsvp"),
        ("/attendance/workspace/review", _REVIEW, "review"),
        ("/attendance/workspace/confirm", _CONFIRM, "confirm"),
    ],
)
def test_direct_calendar_workspace_mutations_use_firebase_owner_without_vault(
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
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: (_ for _ in ()).throw(
        AssertionError("Direct Calendar workspace requested vault authority")
    )

    response = TestClient(app).post("/api/one/calendar" + path, json=payload)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert len(calls) == 1
    assert calls[0][0] == method
    assert calls[0][1]["user_id"] == "owner"
    if path == "/attendance/rsvp/review":
        assert calls[0][1]["send_message"] is False
        assert calls[0][1]["offer_times"] is False
        assert calls[0][1]["message"] == ""


@pytest.mark.parametrize(
    "field", ["send_message", "offer_times", "message", "mail_only_retry", "exact_time", "date"]
)
def test_calendar_only_rsvp_rejects_mail_and_alternative_fields(monkeypatch, field: str) -> None:
    monkeypatch.setattr(
        calendar_workspace,
        "_schedule",
        lambda: (_ for _ in ()).throw(
            AssertionError("Forbidden RSVP payload reached Calendar service")
        ),
    )
    app = _app()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    result = TestClient(app).post(
        "/api/one/calendar/attendance/rsvp/review",
        json={**_RSVP, field: "unexpected"},
    )
    assert result.status_code == 422


@pytest.mark.parametrize(
    ("path", "payload", "method"),
    [
        (
            "/conflicts/workspace/review",
            {
                **_TODAY,
                "keep": {"account_id": "default", "calendar_id": "primary", "event_id": "keep"},
                "decline": [
                    {
                        "account_id": "default",
                        "calendar_id": "primary",
                        "event_id": "decline",
                        "message": "I cannot attend",
                    }
                ],
            },
            "review",
        ),
        ("/conflicts/workspace/confirm", _CONFIRM, "confirm"),
    ],
)
def test_direct_conflict_workspace_uses_firebase_owner_without_vault(
    monkeypatch, path: str, payload: dict, method: str
) -> None:
    from hushh_mcp.services import calendar_conflict_service

    calls: list[tuple[str, dict[str, object]]] = []

    class _Conflict:
        async def review(self, **kwargs: object) -> dict:
            calls.append(("review", kwargs))
            return {}

        async def confirm(self, **kwargs: object) -> dict:
            calls.append(("confirm", kwargs))
            return {}

    monkeypatch.setattr(calendar_conflict_service, "CalendarConflictService", _Conflict)
    app = _app()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: (_ for _ in ()).throw(
        AssertionError("Direct Calendar conflict requested vault authority")
    )

    response = TestClient(app).post("/api/one/calendar" + path, json=payload)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert len(calls) == 1
    assert calls[0][0] == method
    assert calls[0][1]["user_id"] == "owner"


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/attendance/review", _REVIEW),
        ("/attendance/confirm", _CONFIRM),
    ],
)
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


def test_public_rescheduling_options_use_capability_without_owner_login_and_disable_caching(
    monkeypatch,
) -> None:
    from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService

    calls: list[dict[str, object]] = []

    class _Schedule:
        async def public_options(self, **kwargs: object) -> dict[str, object]:
            calls.append(kwargs)
            return {"openings": [], "time_zone": "UTC", "reply_to": "owner@example.com"}

    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: _Schedule())
    monkeypatch.setattr(
        CalendarScheduleService, "_open", lambda token, purpose: {"account_id": "default"}
    )
    response = TestClient(_app()).post(
        "/api/one/calendar/rescheduling/options", json={"token": "a" * 40}
    )

    assert response.status_code == 200
    assert calls == [{"token": "a" * 40}]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_mail_permission_failure_stays_typed_and_does_not_look_like_calendar_failure(
    monkeypatch,
) -> None:
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

    result = TestClient(app).post(
        "/api/one/calendar/attendance/review", json={**_REVIEW, "offer_times": True}
    )

    assert result.status_code == 409
    assert result.json()["detail"]["reason_code"] == "GMAIL_SEND_PERMISSION_REQUIRED"
    assert result.json()["detail"]["message"] == "Allow Mail sending before offering another time."


def test_schedule_selection_overrides_are_strict_and_do_not_enter_attendance(monkeypatch):
    calls = []

    class Schedule:
        async def free_windows(self, **kwargs):
            calls.append(kwargs)
            return {}

    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: Schedule())
    app = _app()
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner"
    client = TestClient(app)
    payload = {**_FULL_DAY, "calendar_overrides": {"shared": False, "holiday": True}}
    assert client.post("/api/one/calendar/schedule/availability", json=payload).status_code == 200
    assert calls == [{"user_id": "owner", **payload}]
    for invalid in ["false", 0, None]:
        assert (
            client.post(
                "/api/one/calendar/schedule/availability",
                json={**_FULL_DAY, "calendar_overrides": {"shared": invalid}},
            ).status_code
            == 422
        )
    assert (
        "calendar_overrides"
        not in calendar_workspace.CalendarAttendanceReview(
            **_REVIEW, calendar_overrides={"shared": False}
        ).model_dump()
    )


def test_availability_failure_preserves_owner_selection_catalog_without_windows(monkeypatch):
    from hushh_mcp.services.google_connection_service import GoogleConnectionError

    options = [{"id": "work", "availability_included": True, "availability_default_included": True}]

    class Schedule:
        async def free_windows(self, **kwargs):
            error = GoogleConnectionError(
                "Cannot read calendar", status_code=409, reason_code="calendar_unreadable"
            )
            error.calendar_options = options
            raise error

    monkeypatch.setattr(calendar_workspace, "_schedule", lambda: Schedule())
    app = _app()
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "owner"
    result = TestClient(app).post("/api/one/calendar/schedule/availability", json=_FULL_DAY)
    assert result.status_code == 409
    assert result.headers["cache-control"] == "private, no-store"
    assert result.json()["detail"]["calendar_options"] == options
    assert "windows" not in result.json()


def test_full_day_contract_defaults_and_rejects_stale_office_window():
    from pydantic import ValidationError

    full = calendar_workspace.CalendarAvailabilityWindow(**_TODAY).model_dump()
    assert (full["start_time"], full["end_time"]) == ("00:00", "24:00")
    booking = calendar_workspace.CalendarAttendanceReview(
        **_TODAY, event_id="invitation"
    ).model_dump()
    assert (booking["start_time"], booking["end_time"]) == ("09:00", "17:00")
    with pytest.raises(ValidationError):
        calendar_workspace.CalendarAvailabilityWindow(**_WINDOW)


@pytest.mark.parametrize(
    "path,payload",
    [
        ("insights", _TODAY),
        ("meetings", _TODAY),
        (
            "meetings/detail",
            {
                "calendar_id": "primary",
                "event_id": "event",
                "expected_account_email": "owner@example.test",
            },
        ),
        (
            "meetings/context",
            {
                "calendar_id": "primary",
                "event_id": "event",
                "expected_account_email": "owner@example.test",
            },
        ),
    ],
)
def test_insights_and_artifacts_require_identity(path, payload):
    assert TestClient(_app()).post("/api/one/calendar/" + path, json=payload).status_code == 401


def test_meeting_context_rejects_different_vault_owner(monkeypatch):
    from unittest.mock import AsyncMock

    artifacts = AsyncMock()
    monkeypatch.setattr(calendar_workspace, "_artifacts", lambda: artifacts)
    app = _app()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other"}
    response = TestClient(app).post(
        "/api/one/calendar/meetings/context",
        json={
            "calendar_id": "primary",
            "event_id": "event",
            "expected_account_email": "owner@example.test",
        },
    )
    assert response.status_code == 403
    artifacts.detail.assert_not_called()
