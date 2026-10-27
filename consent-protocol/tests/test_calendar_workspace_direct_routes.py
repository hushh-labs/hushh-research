"""Direct Calendar workspace mutations use Firebase and scoped Google grants."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import calendar, calendar_workspace

pytestmark = pytest.mark.usefixtures("shared_hub_owner")


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(calendar.router)
    app.include_router(calendar_workspace.router)
    return app


_TODAY = {"date": "2026-10-14", "time_zone": "Asia/Kolkata"}
_REVIEW = {
    **_TODAY,
    "start_time": "09:00",
    "end_time": "17:00",
    "duration_minutes": 30,
    "event_id": "invitation",
    "calendar_id": "primary",
    "offer_times": False,
}
_CONFIRM = {"review_id": "a-valid-review-identifier", "review_token": "a" * 40}
_RSVP = {
    "event_id": "invitation",
    "calendar_id": "primary",
    "response_status": "accepted",
    "time_zone": "Asia/Kolkata",
}
_CONFLICT_REVIEW = {
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
}


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/attendance/rsvp/review", _RSVP),
        ("/attendance/rsvp/confirm", _CONFIRM),
        ("/attendance/workspace/review", _REVIEW),
        ("/attendance/workspace/confirm", _CONFIRM),
        ("/conflicts/workspace/review", _CONFLICT_REVIEW),
        ("/conflicts/workspace/confirm", _CONFIRM),
    ],
)
def test_direct_workspace_actions_require_authentication(path: str, payload: dict) -> None:
    response = TestClient(_app()).post("/api/one/calendar" + path, json=payload)
    assert response.status_code in {401, 403}


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
        assert calls[0][1]["review_kind"] == "rsvp"
        assert calls[0][1]["send_message"] is False
        assert calls[0][1]["offer_times"] is False
        assert calls[0][1]["message"] == ""
    elif path.startswith("/attendance/workspace/"):
        assert calls[0][1]["review_kind"] == "workspace"


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
