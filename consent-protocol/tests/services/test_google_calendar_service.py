from __future__ import annotations

import asyncio
import base64
import threading
from datetime import UTC, datetime
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


class _ConnectionStatusDb(_Db):
    def __init__(self) -> None:
        super().__init__()
        self.thread_ids: list[int] = []

    def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
        self.thread_ids.append(threading.get_ident())
        self.calls.append((sql, params))
        if "google_provider_connections" in sql:
            return SimpleNamespace(
                data=[{"provider_email": "owner@example.com", "status": "connected"}]
            )
        return SimpleNamespace(
            data=[
                {
                    "status": "connected",
                    "access_level": "read",
                    "scope_csv": "calendar.events.readonly calendar.freebusy",
                }
            ]
        )


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


def test_google_drive_is_not_an_authorizable_service() -> None:
    with pytest.raises(GoogleConnectionError, match="Unsupported Google service permission"):
        GoogleConnectionService.scopes("drive", "read")  # type: ignore[arg-type]


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


def test_google_connection_status_keeps_database_work_off_the_event_loop() -> None:
    db = _ConnectionStatusDb()
    service = GoogleConnectionService(db=db)
    event_loop_thread = threading.get_ident()

    status = asyncio.run(service.status(user_id="user-1", service="calendar"))

    assert status["connected"] is True
    assert db.thread_ids
    assert all(thread_id != event_loop_thread for thread_id in db.thread_ids)


def test_calendar_status_requires_an_active_provider_connection() -> None:
    class _InactiveProviderDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "google_provider_connections" in sql:
                return SimpleNamespace(
                    data=[{"provider_email": "owner@example.com", "status": "disconnected"}]
                )
            return SimpleNamespace(
                data=[
                    {
                        "status": "connected",
                        "access_level": "read",
                        "scope_csv": "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.freebusy",
                    }
                ]
            )

    status = asyncio.run(
        GoogleConnectionService(db=_InactiveProviderDb()).status(
            user_id="user-1", service="calendar"
        )
    )

    assert status["connected"] is False
    assert status["google_email"] is None
    assert status["status"] == "disconnected"
    assert status["access_level"] is None
    assert status["scope_csv"] == ""


def test_calendar_access_token_rejects_partial_granted_scopes() -> None:
    class _PartialScopeDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "google_provider_connections" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "status": "connected",
                            "access_token_expires_at": "2999-01-01T00:00:00+00:00",
                            "access_token_ciphertext": "not-used",
                            "access_token_iv": "not-used",
                        }
                    ]
                )
            return SimpleNamespace(
                data=[
                    {
                        "status": "connected",
                        "access_level": "manage",
                        "scope_csv": "https://www.googleapis.com/auth/calendar.events",
                    }
                ]
            )

    with pytest.raises(GoogleConnectionError, match="Additional Google Calendar permission"):
        asyncio.run(
            GoogleConnectionService(db=_PartialScopeDb()).access_token(
                user_id="user-1", service="calendar", access_level="manage"
            )
        )


def test_calendar_refresh_does_not_restore_a_token_after_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _RefreshRaceDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "google_provider_connections" in sql and sql.lstrip().startswith("SELECT"):
                return SimpleNamespace(
                    data=[
                        {
                            "status": "connected",
                            "refresh_token_ciphertext": "old-refresh-envelope",
                            "refresh_token_iv": "not-used",
                            "access_token_expires_at": "2000-01-01T00:00:00+00:00",
                        }
                    ]
                )
            if "google_service_grants" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "status": "connected",
                            "access_level": "read",
                            "scope_csv": "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.freebusy",
                        }
                    ]
                )
            if "RETURNING user_id" in sql:
                # The disconnect won the race before this refresh write.
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=[])

    db = _RefreshRaceDb()
    service = GoogleConnectionService(db=db)
    monkeypatch.setattr(service, "_decrypt", lambda *_args, **_kwargs: "refresh-token")
    monkeypatch.setattr(
        service,
        "_post_form",
        lambda *_args, **_kwargs: asyncio.sleep(
            0,
            result={"access_token": "fresh-access-token", "expires_in": 3600},
        ),
    )
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "new", "iv": "new", "tag": "aad-gcm-v1"},
    )

    with pytest.raises(GoogleConnectionError, match="no longer active") as exc_info:
        asyncio.run(service.access_token(user_id="user-1", service="calendar", access_level="read"))

    assert exc_info.value.status_code == 409
    token_write = next(sql for sql, _ in db.calls if "access_token_ciphertext" in sql)
    assert "status = 'connected'" in token_write


def test_calendar_disconnect_invalidates_pending_oauth_attempts() -> None:
    class _DisconnectDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "SELECT 1 FROM google_service_grants" in sql:
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=[])

    db = _DisconnectDb()
    result = asyncio.run(
        GoogleConnectionService(db=db).disconnect_service(user_id="user-1", service="calendar")
    )

    assert result["connected"] is False
    assert any("UPDATE google_oauth_attempts" in sql for sql, _ in db.calls)


def test_calendar_stale_callback_cannot_reenable_a_disconnected_service_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _StaleCallbackDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "SELECT * FROM google_provider_connections" in sql:
                return SimpleNamespace(data=[{"status": "connected"}])
            if "INSERT INTO google_provider_connections" in sql:
                return SimpleNamespace(data=[{"user_id": "user-1"}])
            if "INSERT INTO google_service_grants" in sql:
                # A disconnect after OAuth started wins over the old callback.
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=[])

    db = _StaleCallbackDb()
    service = GoogleConnectionService(db=db)
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_args, **_kwargs: asyncio.sleep(
            0,
            result={"sub": "subject-1", "email": "owner@example.com"},
        ),
    )
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "new", "iv": "new", "tag": "aad-gcm-v1"},
    )

    with pytest.raises(GoogleConnectionError, match="authorization was cancelled") as exc_info:
        asyncio.run(
            service._store_authorized_connection(
                user_id="user-1",
                token={"access_token": "access", "refresh_token": "refresh", "expires_in": 3600},
                service="calendar",
                requested_scopes=GoogleConnectionService.scopes("calendar", "read"),
                oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )

    assert exc_info.value.status_code == 409
    grant_write = next(sql for sql, _ in db.calls if "INSERT INTO google_service_grants" in sql)
    assert "disconnected_at <= :oauth_started_at" in grant_write


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
