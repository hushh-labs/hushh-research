from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace

import pytest

from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)


class _Db:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict | None]] = []

    def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
        self.calls.append((sql, params))
        return SimpleNamespace(data=[])


class _Connections:
    async def access_token(self, **_: object) -> str:
        return "access-token"


class _ReadOnlyConnections:
    async def access_token(self, **_: object) -> str:
        raise GoogleConnectionError(
            "Additional Google Calendar permission is required", status_code=403
        )


async def _no_conflicts(**_: object) -> list[dict[str, object]]:
    return []


def test_google_oauth_token_envelope_binds_aad(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GMAIL_OAUTH_TOKEN_KEY", base64.urlsafe_b64encode(b"a" * 32).decode())
    service = GoogleConnectionService(db=_Db())

    envelope = service._encrypt("refresh-token", aad="google-connection:user-a")

    assert service._decrypt(envelope, aad="google-connection:user-a") == "refresh-token"
    with pytest.raises(GoogleConnectionError):
        service._decrypt(envelope, aad="google-connection:user-b")


def test_calendar_manage_scope_keeps_availability_permission() -> None:
    scopes = GoogleConnectionService.scopes("calendar", "manage")

    assert "https://www.googleapis.com/auth/calendar.events" in scopes
    assert "https://www.googleapis.com/auth/calendar.freebusy" in scopes


def test_calendar_callback_derives_from_frontend_origin_without_reusing_gmail_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GOOGLE_OAUTH_REDIRECT_URI", raising=False)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://uat.one.hushh.ai/")
    monkeypatch.setenv(
        "GMAIL_OAUTH_REDIRECT_URI", "https://uat.one.hushh.ai/profile/gmail/oauth/return"
    )

    assert GoogleConnectionService(db=_Db())._configured_redirect() == (
        "https://uat.one.hushh.ai/one/profile/google/oauth/return"
    )


def test_calendar_proposal_requires_timezone_and_confirmation_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Db()
    service = GoogleCalendarService(db=db, connections=_Connections())
    monkeypatch.setattr(service, "_find_conflicts", _no_conflicts)

    result = asyncio.run(
        service.propose(
            user_id="user-1",
            action="create",
            payload={
                "title": "Planning session",
                "start_at": "2026-08-11T10:00:00+05:30",
                "end_at": "2026-08-11T10:30:00+05:30",
                "time_zone": "Asia/Kolkata",
                "attendees": ["person@example.com"],
            },
        )
    )

    assert result["confirmation_required"] is True
    assert result["proposal_id"].startswith("gcal_")
    assert any("INSERT INTO google_calendar_action_proposals" in sql for sql, _ in db.calls)


def test_calendar_proposal_requires_management_access_before_persisting() -> None:
    db = _Db()
    service = GoogleCalendarService(db=db, connections=_ReadOnlyConnections())

    with pytest.raises(GoogleConnectionError, match="Additional Google Calendar permission"):
        asyncio.run(
            service.propose(
                user_id="user-1",
                action="create",
                payload={
                    "title": "Planning session",
                    "start_at": "2026-08-11T10:00:00+05:30",
                    "end_at": "2026-08-11T10:30:00+05:30",
                },
            )
        )

    assert not any("INSERT INTO google_calendar_action_proposals" in sql for sql, _ in db.calls)


def test_calendar_proposal_rejects_naive_time() -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())

    with pytest.raises(GoogleConnectionError, match="time zone"):
        asyncio.run(
            service.propose(
                user_id="user-1",
                action="create",
                payload={
                    "title": "Planning session",
                    "start_at": "2026-08-11T10:00:00",
                    "end_at": "2026-08-11T10:30:00",
                },
            )
        )


def test_calendar_proposal_includes_live_conflicts(monkeypatch: pytest.MonkeyPatch) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    conflicts = [
        {
            "id": "event-1",
            "etag": "etag-1",
            "title": "Design review",
            "start": {"dateTime": "2026-08-11T10:00:00+05:30"},
            "end": {"dateTime": "2026-08-11T10:30:00+05:30"},
        }
    ]

    async def find_conflicts(**_: object) -> list[dict[str, object]]:
        return conflicts

    monkeypatch.setattr(service, "_find_conflicts", find_conflicts)
    result = asyncio.run(
        service.propose(
            user_id="user-1",
            action="create",
            payload={
                "title": "Client call",
                "start_at": "2026-08-11T10:00:00+05:30",
                "end_at": "2026-08-11T10:30:00+05:30",
            },
        )
    )

    assert result["plan"]["conflicts"] == conflicts


def test_find_openings_merges_overlapping_busy_intervals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())

    async def freebusy(**_: object) -> dict[str, object]:
        return {
            "time_min": "2026-08-11T04:30:00Z",
            "time_max": "2026-08-11T09:30:00Z",
            "time_zone": "Asia/Kolkata",
            "calendars": {
                "primary": {
                    "busy": [
                        {"start": "2026-08-11T05:30:00Z", "end": "2026-08-11T06:00:00Z"},
                        {"start": "2026-08-11T05:45:00Z", "end": "2026-08-11T06:30:00Z"},
                    ]
                }
            },
        }

    monkeypatch.setattr(service, "freebusy", freebusy)
    result = asyncio.run(
        service.find_openings(
            user_id="user-1",
            start_at="2026-08-11T10:00:00+05:30",
            end_at="2026-08-11T15:00:00+05:30",
            duration_minutes=30,
            limit=3,
        )
    )

    assert result["openings"] == [
        {
            "start_at": "2026-08-11T04:30:00Z",
            "end_at": "2026-08-11T05:00:00Z",
            "available_until": "2026-08-11T05:30:00Z",
        },
        {
            "start_at": "2026-08-11T06:30:00Z",
            "end_at": "2026-08-11T07:00:00Z",
            "available_until": "2026-08-11T09:30:00Z",
        },
    ]


def test_calendar_execute_rejects_conflicts_that_changed_after_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = {
        "title": "Client call",
        "start_at": "2026-08-11T04:30:00Z",
        "end_at": "2026-08-11T05:00:00Z",
        "time_zone": "Asia/Kolkata",
        "attendees": [],
        "description": "",
        "location": "",
        "send_updates": True,
        "conflicts": [],
    }

    class _ClaimDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "RETURNING action" in sql:
                return SimpleNamespace(
                    data=[{"action": "create", "payload_json": plan, "expected_event_etag": None}]
                )
            return SimpleNamespace(data=[])

    service = GoogleCalendarService(db=_ClaimDb(), connections=_Connections())

    async def changed_conflicts(**_: object) -> list[dict[str, object]]:
        return [
            {
                "id": "event-1",
                "etag": "etag-1",
                "title": "Design review",
                "start": {"dateTime": "2026-08-11T04:30:00Z"},
                "end": {"dateTime": "2026-08-11T05:00:00Z"},
            }
        ]

    monkeypatch.setattr(service, "_find_conflicts", changed_conflicts)
    with pytest.raises(GoogleConnectionError, match="availability changed"):
        asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))
