from __future__ import annotations

import asyncio
import base64
import copy
import json
import threading
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    CALENDAR_LIST_READ_SCOPE,
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation
from tests.google_oauth_test_support import TransactionEngine


class _Db:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict | None]] = []
        self.engine = TransactionEngine(self)

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
    def __init__(self) -> None:
        self.binding = (
            "owner",
            "calendar",
            "google-sub",
            "connected-at",
            "connection-rev",
            "grant-rev",
        )
        self.list_scope = False

    async def access_token(self, **_: object) -> str:
        return "access-token"

    async def read_grant_binding(self, **_: object) -> tuple[str, ...]:
        return self.binding

    async def has_service_scope(self, **_: object) -> bool:
        return self.list_scope


class _ReadOnlyConnections:
    async def access_token(self, **_: object) -> str:
        raise GoogleConnectionError(
            "Additional Google Calendar permission is required", status_code=403
        )


def _record_calendar_provider(
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response,
    *,
    after_request: object = None,
) -> list[dict[str, object]]:
    requests: list[dict[str, object]] = []

    class _Client:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        @asynccontextmanager
        async def stream(self, method: str, url: str, **kwargs: object):
            yield await self.request(method, url, **kwargs)

        async def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
            requests.append({"method": method, "url": url, **kwargs})
            if callable(after_request):
                after_request()
            return response

    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.httpx.AsyncClient",
        lambda **_: _Client(),
    )
    return requests


def _provider_response(status: int, body: dict[str, object]) -> httpx.Response:
    return httpx.Response(
        status, json=body, request=httpx.Request("GET", "https://www.googleapis.com")
    )


def test_calendar_read_discards_result_when_owner_grant_changes_after_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connections = _Connections()
    service = GoogleCalendarService(db=_Db(), connections=connections)

    def revoke() -> None:
        connections.binding = (
            "owner",
            "calendar",
            "new-google-sub",
            "connected-at",
            "new-rev",
            "new-grant",
        )

    _record_calendar_provider(
        monkeypatch,
        _provider_response(200, {"items": [{"id": "private", "summary": "Private event"}]}),
        after_request=revoke,
    )
    with pytest.raises(GoogleConnectionError, match="connection changed") as exc_info:
        asyncio.run(
            service.list_events(
                user_id="user-1",
                start_at="2026-08-11T00:00:00Z",
                end_at="2026-08-12T00:00:00Z",
            )
        )
    assert exc_info.value.status_code == 409


@pytest.mark.parametrize(
    ("reason", "expected_status"),
    [
        ("rateLimitExceeded", 429),
        ("userRateLimitExceeded", 429),
        ("quotaExceeded", 429),
        ("forbidden", 403),
    ],
)
def test_calendar_provider_403_distinguishes_quota_from_permission(
    monkeypatch: pytest.MonkeyPatch, reason: str, expected_status: int
) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    _record_calendar_provider(
        monkeypatch,
        _provider_response(403, {"error": {"errors": [{"reason": reason}]}}),
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            service.list_events(
                user_id="user-1",
                start_at="2026-08-11T00:00:00Z",
                end_at="2026-08-12T00:00:00Z",
            )
        )
    assert exc_info.value.status_code == expected_status


def test_calendar_freebusy_rejects_embedded_provider_error_in_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    _record_calendar_provider(
        monkeypatch,
        _provider_response(200, {"calendars": {"primary": {"errors": [{"reason": "notFound"}]}}}),
    )
    with pytest.raises(GoogleConnectionError, match="could not be checked") as exc_info:
        asyncio.run(
            service.freebusy(
                user_id="user-1",
                start_at="2026-08-11T00:00:00Z",
                end_at="2026-08-12T00:00:00Z",
            )
        )
    assert exc_info.value.status_code == 502


def test_calendar_list_requires_its_incremental_scope_without_breaking_base_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connections = _Connections()
    service = GoogleCalendarService(db=_Db(), connections=connections)
    requests = _record_calendar_provider(
        monkeypatch,
        _provider_response(
            200,
            {
                "items": [
                    {"id": "secondary@example.com", "summary": "Team", "timeZone": "Asia/Kolkata"}
                ],
                "nextPageToken": "next-page",
            },
        ),
    )

    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(service.list_calendars(user_id="user-1"))
    assert exc_info.value.status_code == 403
    assert exc_info.value.reason_code == "calendar_list_permission_required"
    assert requests == []

    connections.list_scope = True
    result = asyncio.run(service.list_calendars(user_id="user-1", max_results=20))
    assert result["calendars"] == [
        {
            "id": "secondary@example.com",
            "name": "Team",
            "primary": False,
            "access_role": None,
            "time_zone": "Asia/Kolkata",
        }
    ]
    assert result["truncated"] is True
    assert result["next_page_token"] == "next-page"
    assert requests[0]["url"].endswith("/users/me/calendarList")
    assert requests[0]["params"] == {"maxResults": 20}
    assert CALENDAR_LIST_READ_SCOPE


def test_calendar_event_detail_encodes_selected_calendar_and_event_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    requests = _record_calendar_provider(
        monkeypatch,
        _provider_response(
            200,
            {
                "id": "event/one",
                "summary": "Planning",
                "description": "Notes",
                "start": {"dateTime": "2026-08-11T10:00:00Z"},
            },
        ),
    )
    result = asyncio.run(
        service.get_event(user_id="user-1", calendar_id="team@example.com", event_id="event/one")
    )
    assert result["calendar_id"] == "team@example.com"
    assert result["event"]["description"] == "Notes"
    assert requests[0]["url"].endswith("/calendars/team%40example.com/events/event%2Fone")


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


def test_calendar_web_oauth_requests_incremental_list_scope_without_changing_native(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "_signed_state", lambda _: "test-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_args, **_kwargs: {"ciphertext": "test", "iv": "test", "tag": "aad-gcm-v1"},
    )
    web = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="https://example.com/callback",
            transport="web",
        )
    )
    native = asyncio.run(
        service._create_oauth_attempt(
            user_id="user-1",
            service="calendar",
            access_level="read",
            redirect_uri="hushh://callback",
            transport="native",
        )
    )
    assert CALENDAR_LIST_READ_SCOPE in web["scopes"]
    assert CALENDAR_LIST_READ_SCOPE not in native["scopes"]
    assert set(GoogleConnectionService.scopes("calendar", "read")) <= set(native["scopes"])


def test_calendar_web_oauth_does_not_assume_optional_scope_was_granted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"sub": "google-sub"}),
    )
    monkeypatch.setattr(
        service, "_connection", lambda *_args, **_kwargs: asyncio.sleep(0, result=None)
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            service._store_authorized_connection(
                user_id="user-1",
                token={"access_token": "access", "refresh_token": "refresh", "expires_in": 3600},
                service="calendar",
                requested_scopes=(
                    *GoogleConnectionService.scopes("calendar", "read"),
                    CALENDAR_LIST_READ_SCOPE,
                ),
                oauth_started_at=datetime(2026, 1, 1, tzinfo=UTC),
                attempt_id="synthetic-attempt",
                expected_generation=connection_generation(None),
            )
        )
    assert exc_info.value.status_code == 403
    assert exc_info.value.reason_code == "calendar_list_permission_required"


def test_google_drive_authorization_is_read_only() -> None:
    assert GoogleConnectionService.scopes("drive", "read") == (
        "https://www.googleapis.com/auth/drive.readonly",
    )
    with pytest.raises(GoogleConnectionError, match="Unsupported Google service permission"):
        GoogleConnectionService.scopes("drive", "manage")


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
                            "service_status": "connected",
                            "service_access_level": "manage",
                            "service_scope_csv": "https://www.googleapis.com/auth/calendar.events",
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
                            "service_status": "connected",
                            "service_access_level": "read",
                            "service_scope_csv": "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.freebusy",
                        }
                    ]
                )
            if "google_service_grants" in sql and sql.lstrip().startswith("SELECT"):
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
    assert "refresh_token_ciphertext = :expected_refresh_ciphertext" in token_write
    assert "provider_subject IS NOT DISTINCT FROM :expected_subject" in token_write
    assert "scope_csv = :expected_scope_csv" in token_write


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
                return SimpleNamespace(
                    data=[{"status": "connected", "provider_subject": "subject-1"}]
                )
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
                attempt_id="synthetic-attempt",
                expected_generation=connection_generation(
                    {"status": "connected", "provider_subject": "subject-1"}
                ),
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
    request_id = result["plan"]["conference_request_id"]
    assert request_id.startswith("meet_")
    proposal_write = next(
        params for sql, params in db.calls if "INSERT INTO google_calendar_action_proposals" in sql
    )
    assert proposal_write is not None
    assert json.loads(str(proposal_write["payload_json"]))["conference_request_id"] == request_id


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


def test_calendar_create_requests_google_meet_and_emails_the_invite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = {
        "title": "Client call",
        "start_at": "2026-08-11T04:30:00Z",
        "end_at": "2026-08-11T05:00:00Z",
        "time_zone": "Asia/Kolkata",
        "attendees": ["person@example.com"],
        "description": "",
        "location": "",
        "send_updates": True,
        "conflicts": [],
        "conference_request_id": "meet_persisted_request",
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
    requests: list[dict[str, object]] = []

    async def created(**kwargs: object) -> dict[str, object]:
        requests.append(kwargs)
        return {
            "id": "google-event-id",
            "summary": "Client call",
            "conferenceData": {
                "entryPoints": [
                    {
                        "entryPointType": "video",
                        "uri": "https://meet.google.com/abc-defg-hij",
                    }
                ],
                "createRequest": {"status": {"statusCode": "success"}},
            },
        }

    monkeypatch.setattr(service, "_find_conflicts", _no_conflicts)
    monkeypatch.setattr(service, "_request", created)
    result = asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))

    assert requests == [
        {
            "user_id": "user-1",
            "method": "POST",
            "path": "/calendars/primary/events",
            "access": "manage",
            "params": {"sendUpdates": "all", "conferenceDataVersion": 1},
            "payload": {
                "summary": "Client call",
                "description": None,
                "location": None,
                "start": {"dateTime": "2026-08-11T04:30:00Z", "timeZone": "Asia/Kolkata"},
                "end": {"dateTime": "2026-08-11T05:00:00Z", "timeZone": "Asia/Kolkata"},
                "attendees": [{"email": "person@example.com"}],
                "conferenceData": {
                    "createRequest": {
                        "requestId": "meet_persisted_request",
                        "conferenceSolutionKey": {"type": "hangoutsMeet"},
                    }
                },
            },
        }
    ]
    assert result["event"]["conference_url"] == "https://meet.google.com/abc-defg-hij"
    assert result["event"]["conference_status"] == "success"


def test_calendar_create_legacy_proposal_generates_a_meet_request_id(
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
    requests: list[dict[str, object]] = []

    async def created(**kwargs: object) -> dict[str, object]:
        requests.append(kwargs)
        return {"id": "google-event-id", "summary": "Client call"}

    monkeypatch.setattr(service, "_find_conflicts", _no_conflicts)
    monkeypatch.setattr(service, "_request", created)
    asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_legacy"))

    request_id = requests[0]["payload"]["conferenceData"]["createRequest"]["requestId"]
    assert request_id == "meet_legacy_legacy"


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_calendar_execute_records_confirmed_outcome_for_feed(
    monkeypatch: pytest.MonkeyPatch,
    cleanup_fails: bool,
) -> None:
    class _ClaimDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if (
                cleanup_fails
                and "DELETE FROM google_calendar_action_proposals" in sql
                and "status = 'executed'" in sql
            ):
                raise RuntimeError("cleanup unavailable")
            if "RETURNING action" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "action": "create",
                            "payload_json": {
                                "title": "Private event title",
                                "start_at": "2026-10-01T10:00:00Z",
                                "end_at": "2026-10-01T11:00:00Z",
                                "time_zone": "UTC",
                                "attendees": [],
                                "description": "",
                                "location": "",
                                "send_updates": False,
                                "conflicts": [],
                                "conference_request_id": "meet_feed_event",
                            },
                            "expected_event_etag": None,
                        }
                    ]
                )
            return SimpleNamespace(data=[])

    db = _ClaimDb()
    service = GoogleCalendarService(db=db, connections=_Connections())

    async def created(**_: object) -> dict[str, object]:
        return {"id": "google-event-id", "summary": "Private event title"}

    monkeypatch.setattr(service, "_find_conflicts", _no_conflicts)
    monkeypatch.setattr(service, "_request", created)
    result = asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))

    assert result["action"] == "create"
    completed = next(
        index
        for index, (sql, params) in enumerate(db.calls)
        if "SET status = 'executed', executed_at = NOW()" in sql
        and params == {"proposal_id": "gcal_example", "user_id": "user-1"}
    )
    cleaned = next(
        index
        for index, (sql, _) in enumerate(db.calls)
        if "DELETE FROM google_calendar_action_proposals" in sql and "status = 'executed'" in sql
    )
    assert completed < cleaned
    assert not any("SET status = 'failed'" in sql for sql, _ in db.calls)


# --- reschedule: events.patch with only what changed ------------------------

_OWNER = {
    "email": "owner@example.com",
    "self": True,
    "organizer": True,
    "responseStatus": "accepted",
}
_ROOM = {
    "email": "room-4@resource.calendar.google.com",
    "resource": True,
    "responseStatus": "accepted",
}
_GUESTS = [
    {"email": "a@example.com", "responseStatus": "accepted", "optional": True},
    {"email": "b@example.com", "responseStatus": "tentative"},
    {"email": "c@example.com", "responseStatus": "needsAction"},
]


def _event(**changes: object) -> dict[str, object]:
    return {
        "id": "evt-1",
        "etag": '"etag-1"',
        "summary": "Standup",
        "description": "Agenda: https://example.com/agenda",
        "location": "Room 4",
        "start": {"dateTime": "2026-10-01T16:00:00Z", "timeZone": "America/Los_Angeles"},
        "end": {"dateTime": "2026-10-01T16:30:00Z", "timeZone": "America/Los_Angeles"},
        "attendees": [_OWNER, *_GUESTS, _ROOM],
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 10}]},
        "conferenceData": {"conferenceId": "abc-defg-hij"},
        **changes,
    }


def _reschedule_harness(event: dict[str, object]):
    """The real propose -> execute path over a recorded Calendar API."""
    stored: dict[str, object] = {}

    class _ProposalDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
            self.calls.append((sql, params))
            if "INSERT INTO google_calendar_action_proposals" in sql and params:
                stored.update(
                    action=params["action"],
                    payload_json=params["payload_json"],
                    expected_event_etag=params["etag"],
                )
            if "RETURNING action" in sql:
                return SimpleNamespace(data=[dict(stored)])
            return SimpleNamespace(data=[])

    service = GoogleCalendarService(db=_ProposalDb(), connections=_Connections())
    requests: list[dict[str, object]] = []

    async def request(**kwargs: object) -> dict[str, object]:
        requests.append(kwargs)
        return copy.deepcopy(event) if kwargs["method"] in {"GET", "PATCH"} else {}

    service._request = request  # type: ignore[method-assign]
    service._find_conflicts = _no_conflicts  # type: ignore[method-assign]
    return service, requests, stored


def _reschedule(service: GoogleCalendarService, **payload: object) -> dict[str, object]:
    return asyncio.run(
        service.propose(
            user_id="user-1",
            action="reschedule",
            payload={
                "event_id": "evt-1",
                "start_at": "2026-10-02T09:00:00-07:00",
                "end_at": "2026-10-02T09:30:00-07:00",
                "time_zone": "America/Los_Angeles",
                **payload,
            },
        )
    )


def test_reschedule_patches_only_the_time_and_keeps_every_other_field() -> None:
    # Regression: events.update (PUT) is a full replacement, and its body was
    # built only from the model's arguments, so moving a meeting erased its
    # attendees, description, location, reminders and conference link.
    # Negative control: the previous code sent method PUT with a body that
    # carried "attendees": [] and "description": None; this test fails on it.
    service, requests, _ = _reschedule_harness(_event())
    _reschedule(service, title="Standup")
    asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))

    writes = [call for call in requests if call["method"] != "GET"]
    assert [call["method"] for call in writes] == ["PATCH"]
    assert writes[0]["headers"] == {"If-Match": '"etag-1"'}
    assert writes[0]["payload"] == {
        "start": {"dateTime": "2026-10-02T16:00:00Z", "timeZone": "America/Los_Angeles"},
        "end": {"dateTime": "2026-10-02T16:30:00Z", "timeZone": "America/Los_Angeles"},
    }


def test_rescheduling_an_all_day_event_keeps_it_all_day() -> None:
    service, requests, _ = _reschedule_harness(
        _event(start={"date": "2026-10-01"}, end={"date": "2026-10-02"})
    )
    result = _reschedule(
        service,
        start_at="2026-10-05T00:00:00-07:00",
        end_at="2026-10-06T00:00:00-07:00",
    )
    assert result["plan"]["all_day"] is True
    asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))
    patch = next(call for call in requests if call["method"] == "PATCH")
    assert patch["payload"] == {"start": {"date": "2026-10-05"}, "end": {"date": "2026-10-06"}}


def test_a_new_guest_list_is_reviewed_as_exact_adds_and_removes() -> None:
    service, requests, _ = _reschedule_harness(_event())
    result = _reschedule(service, attendees=["new@example.com"])
    # The owner, the organizer and the booked room are never dropped by a
    # list that leaves them out; everyone else not named is a removal.
    assert result["plan"]["attendee_change"] == {
        "added": ["new@example.com"],
        "removed": ["a@example.com", "b@example.com", "c@example.com"],
        "result_count": 3,
    }
    asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))
    patch = next(call for call in requests if call["method"] == "PATCH")
    assert patch["payload"]["attendees"] == [
        {"email": "owner@example.com", "responseStatus": "accepted"},
        {
            "email": "room-4@resource.calendar.google.com",
            "resource": True,
            "responseStatus": "accepted",
        },
        {"email": "new@example.com"},
    ]


def test_an_attendee_change_that_differs_from_the_review_is_refused() -> None:
    service, requests, stored = _reschedule_harness(_event())
    _reschedule(service, attendees=["a@example.com"])
    plan = json.loads(str(stored["payload_json"]))
    plan["attendee_change"]["removed"] = []
    stored["payload_json"] = json.dumps(plan)
    with pytest.raises(GoogleConnectionError, match="review it again"):
        asyncio.run(service.execute(user_id="user-1", proposal_id="gcal_example"))
    assert all(call["method"] == "GET" for call in requests)


def test_event_listing_is_bounded_searchable_and_honest_about_truncation() -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    seen: list[dict[str, object]] = []

    async def request(**kwargs: object) -> dict[str, object]:
        seen.append(kwargs)
        return {"items": [_event()], "nextPageToken": "more", "timeZone": "UTC"}

    service._request = request  # type: ignore[method-assign]
    result = asyncio.run(
        service.list_events(
            user_id="user-1",
            start_at="2026-10-01T00:00:00Z",
            end_at="2026-11-01T00:00:00Z",
            max_results=10_000,
            query="  quarterly   review ",
        )
    )
    params = seen[0]["params"]
    assert isinstance(params, dict)
    assert params["maxResults"] == 250
    assert params["q"] == "quarterly review"
    assert result["truncated"] is True
    assert "more exist" in str(result["more_events_exist"])


@pytest.mark.parametrize(
    "calendars,groups",
    [
        ({"primary": {}}, {}),
        ({"primary": {"busy": None}}, {}),
        ({"primary": {"busy": {}}}, {}),
        ({"primary": {"busy": [None]}}, {}),
        ({"primary": {"busy": [{"start": "invalid", "end": "invalid"}]}}, {}),
        ({"primary": {"busy": [{"start": "2026-08-11T09:00:00Z"}]}}, {}),
        (
            {"primary": {"busy": [{"start": "2026-08-11T09:00:00", "end": "2026-08-11T10:00:00"}]}},
            {},
        ),
        (
            {
                "primary": {
                    "busy": [{"start": "2026-08-11T10:00:00Z", "end": "2026-08-11T09:00:00Z"}]
                }
            },
            {},
        ),
        ({"primary": {"busy": []}}, {"team": {"calendars": ["missing"]}}),
        ({"primary": {"busy": []}}, {"team": {"calendars": None}}),
    ],
)
def test_calendar_openings_fail_closed_on_incomplete_provider_availability(
    monkeypatch: pytest.MonkeyPatch, calendars: object, groups: object
) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    _record_calendar_provider(
        monkeypatch, _provider_response(200, {"calendars": calendars, "groups": groups})
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            service.find_openings(
                user_id="owner",
                start_at="2026-08-11T08:00:00Z",
                end_at="2026-08-11T12:00:00Z",
                duration_minutes=30,
            )
        )
    assert exc_info.value.reason_code == "calendar_invalid_response"


def test_calendar_empty_busy_list_is_known_availability(monkeypatch: pytest.MonkeyPatch) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    _record_calendar_provider(
        monkeypatch, _provider_response(200, {"calendars": {"primary": {"busy": []}}})
    )
    result = asyncio.run(
        service.find_openings(
            user_id="owner",
            start_at="2026-08-11T08:00:00Z",
            end_at="2026-08-11T12:00:00Z",
            duration_minutes=30,
        )
    )
    assert result["openings"][0]["start_at"] == "2026-08-11T08:00:00Z"


@pytest.mark.parametrize("method", ["list_events", "freebusy"])
def test_calendar_range_compares_instants_not_iso_strings(method: str) -> None:
    service = GoogleCalendarService(db=_Db(), connections=_Connections())
    # Lexical ordering places '.' before 'Z', even though .5 is later.
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            getattr(service, method)(
                user_id="owner",
                start_at="2026-08-11T08:00:00.5Z",
                end_at="2026-08-11T08:00:00Z",
            )
        )
    assert exc_info.value.status_code == 422


def _calendar_provider_sequence(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[httpx.Response | Exception]
) -> list[str]:
    calls: list[str] = []

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        @asynccontextmanager
        async def stream(self, method: str, url: str, **kwargs: object):
            yield await self.request(method, url, **kwargs)

        async def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
            calls.append(method)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.httpx.AsyncClient", lambda **_: Client()
    )
    monkeypatch.setattr(GoogleCalendarService, "_read_retry_delay", staticmethod(lambda _: 0.0))
    return calls


@pytest.mark.parametrize(
    "first",
    [
        httpx.ConnectError("synthetic transport error"),
        _provider_response(503, {}),
        _provider_response(429, {}),
        _provider_response(403, {"error": {"errors": [{"reason": "rateLimitExceeded"}]}}),
    ],
)
def test_calendar_read_retries_one_transient_failure(
    monkeypatch: pytest.MonkeyPatch, first: httpx.Response | Exception
) -> None:
    calls = _calendar_provider_sequence(
        monkeypatch, [first, _provider_response(200, {"items": []})]
    )
    result = asyncio.run(
        GoogleCalendarService(db=_Db(), connections=_Connections()).list_events(
            user_id="owner",
            start_at="2026-08-11T08:00:00Z",
            end_at="2026-08-11T09:00:00Z",
        )
    )
    assert result["events"] == []
    assert calls == ["GET", "GET"]


@pytest.mark.parametrize(
    "access,status,expected_calls,reason",
    [
        ("manage", 503, 1, "calendar_unavailable"),
        ("read", 503, 2, "calendar_unavailable"),
        ("read", 401, 1, "calendar_reauthorization_required"),
        ("read", 403, 1, "calendar_permission_required"),
    ],
)
def test_calendar_retry_boundary_and_auth_reasons(
    monkeypatch: pytest.MonkeyPatch, access: str, status: int, expected_calls: int, reason: str
) -> None:
    calls = _calendar_provider_sequence(
        monkeypatch, [_provider_response(status, {}) for _ in range(2)]
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            GoogleCalendarService(db=_Db(), connections=_Connections())._request(
                user_id="owner",
                method="GET" if access == "read" else "POST",
                path="/calendars/primary/events",
                access=access,
            )
        )
    assert len(calls) == expected_calls
    assert exc_info.value.reason_code == reason


def test_calendar_read_deadline_includes_oauth_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    class StalledConnections(_Connections):
        async def access_token(self, **_: object) -> str:
            await asyncio.Event().wait()
            return "unreachable"

    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.CALENDAR_READ_DEADLINE_SECONDS", 0.01
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            GoogleCalendarService(db=_Db(), connections=StalledConnections()).list_events(
                user_id="owner",
                start_at="2026-08-11T08:00:00Z",
                end_at="2026-08-11T09:00:00Z",
            )
        )
    assert exc_info.value.status_code == 504
    assert exc_info.value.reason_code == "calendar_timeout"


def test_calendar_retry_cannot_cross_revocation(monkeypatch: pytest.MonkeyPatch) -> None:
    connections = _Connections()
    calls = _calendar_provider_sequence(monkeypatch, [_provider_response(503, {})])

    async def revoke(_: float) -> None:
        connections.binding = None

    monkeypatch.setattr("hushh_mcp.services.google_calendar_service.asyncio.sleep", revoke)
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            GoogleCalendarService(db=_Db(), connections=connections).list_events(
                user_id="owner",
                start_at="2026-08-11T08:00:00Z",
                end_at="2026-08-11T09:00:00Z",
            )
        )
    assert calls == ["GET"]
    assert exc_info.value.reason_code == "calendar_connection_changed"


def test_calendar_long_retry_after_is_not_retried_early() -> None:
    response = _provider_response(429, {})
    response.headers["Retry-After"] = "30"
    assert GoogleCalendarService._read_retry_delay(response) is None


def test_calendar_read_accepts_manage_scope_without_requesting_extra_consent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ScopeDb(_Db):
        def execute_raw(self, sql: str, params: dict | None = None):
            return SimpleNamespace(
                data=[
                    {
                        "status": "connected",
                        "service_status": "connected",
                        "service_access_level": "manage",
                        "service_scope_csv": " ".join(
                            GoogleConnectionService.scopes("calendar", "manage")
                        ),
                        "access_token_expires_at": "2999-01-01T00:00:00+00:00",
                    }
                ]
            )

    service = GoogleConnectionService(db=ScopeDb())
    monkeypatch.setattr(service, "_decrypt", lambda *_args, **_kwargs: "synthetic-access")
    assert (
        asyncio.run(service.access_token(user_id="owner", service="calendar", access_level="read"))
        == "synthetic-access"
    )


@pytest.mark.parametrize("body", [b"[]", b"not-json", b"x" * 200])
def test_calendar_read_rejects_invalid_or_oversized_response(
    monkeypatch: pytest.MonkeyPatch,
    body: bytes,
) -> None:
    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service._CALENDAR_READ_MAX_RESPONSE_BYTES", 100
    )
    _record_calendar_provider(
        monkeypatch,
        httpx.Response(
            200,
            content=body,
            request=httpx.Request("GET", "https://www.googleapis.com"),
        ),
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            GoogleCalendarService(db=_Db(), connections=_Connections()).list_events(
                user_id="owner",
                start_at="2026-08-11T08:00:00Z",
                end_at="2026-08-11T09:00:00Z",
            )
        )
    assert exc_info.value.reason_code == "calendar_invalid_response"


def test_calendar_stream_cap_applies_without_content_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Body(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield b"x" * 65536
            yield b"x" * 65536
            raise AssertionError("The oversized body must stop streaming")

        async def aclose(self):
            self.closed = True

    body = Body()
    transport = httpx.MockTransport(lambda _: httpx.Response(200, stream=body))
    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service._CALENDAR_READ_MAX_RESPONSE_BYTES", 65536
    )
    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.httpx.AsyncClient",
        lambda **kwargs: client_type(transport=transport, **kwargs),
    )
    with pytest.raises(GoogleConnectionError) as exc_info:
        asyncio.run(
            GoogleCalendarService(db=_Db(), connections=_Connections()).list_events(
                user_id="owner",
                start_at="2026-08-11T08:00:00Z",
                end_at="2026-08-11T09:00:00Z",
            )
        )
    assert exc_info.value.reason_code == "calendar_invalid_response"
    assert body.closed
