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
        "https://uat.one.hushh.ai/profile/google/oauth/return"
    )


def test_calendar_proposal_requires_timezone_and_confirmation_record() -> None:
    db = _Db()
    service = GoogleCalendarService(db=db, connections=_Connections())

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
