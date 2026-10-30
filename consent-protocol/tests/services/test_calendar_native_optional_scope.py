"""Native availability scope upgrades are bound to the original consent attempt."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from hushh_mcp.services.google_calendar_meeting_grant import CALENDAR_SHARED_DRIVE_METADATA_SCOPE
from hushh_mcp.services.google_connection_service import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    CALENDAR_LIST_READ_SCOPE,
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_MEET_READ_SCOPE,
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation
from tests.google_oauth_test_support import TransactionEngine


class _Db:
    def __init__(self) -> None:
        self.engine = TransactionEngine(self)

    def execute_raw(self, *_: object) -> SimpleNamespace:
        return SimpleNamespace(data=[])


def test_optional_native_calendar_list_access_leaves_initial_base_consent_unchanged(
    monkeypatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "_signed_state", lambda _: "synthetic-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_, **__: {"ciphertext": "synthetic", "iv": "synthetic", "tag": "aad-gcm-v1"},
    )

    async def attempt(include: bool):
        return await service._create_oauth_attempt(
            user_id="owner",
            service="calendar",
            access_level="read",
            redirect_uri="",
            transport="native",
            include_calendar_list=include,
        )

    base = asyncio.run(attempt(False))
    upgraded = asyncio.run(attempt(True))

    assert CALENDAR_LIST_READ_SCOPE not in base["scopes"]
    assert set(upgraded["scopes"]) == set(base["scopes"]) | {CALENDAR_LIST_READ_SCOPE}
    assert set(GoogleConnectionService.scopes("calendar", "read")) <= set(base["scopes"])


def test_meeting_file_scopes_are_explicit_and_native_start_echoes_request(monkeypatch) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_client_id", lambda: "synthetic-client")
    monkeypatch.setattr(service, "_signed_state", lambda _: "synthetic-state")
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_, **__: {"ciphertext": "synthetic", "iv": "synthetic", "tag": "aad-gcm-v1"},
    )
    result = asyncio.run(
        service.start_native(
            user_id="owner", service="calendar", access_level="read", include_meeting_files=True
        )
    )
    assert result["include_meeting_files"] is True
    assert result["include_calendar_list"] is True
    assert CALENDAR_MEET_READ_SCOPE not in service.scopes("calendar", "read")
    assert CALENDAR_MEET_DRIVE_READ_SCOPE not in service.scopes("calendar", "read")
    assert CALENDAR_SHARED_DRIVE_METADATA_SCOPE not in service.scopes("calendar", "read")


@pytest.mark.parametrize("optional_list", [False, True])
@pytest.mark.parametrize("meeting_files", [False, True])
@pytest.mark.parametrize("guest_photos", [False, True])
def test_native_completion_accepts_only_the_exact_trusted_scope_set(
    monkeypatch, optional_list: bool, meeting_files: bool, guest_photos: bool
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(service, "_client_id", lambda: "synthetic-client")
    monkeypatch.setattr(service, "_client_secret", lambda: "synthetic-test-secret")
    requested = {"openid", "email", "profile", *service.scopes("calendar", "read")}
    if optional_list or meeting_files:
        requested.add(CALENDAR_LIST_READ_SCOPE)
    if meeting_files:
        requested.update(
            {
                CALENDAR_MEET_READ_SCOPE,
                CALENDAR_MEET_DRIVE_READ_SCOPE,
                CALENDAR_SHARED_DRIVE_METADATA_SCOPE,
            }
        )
    if guest_photos:
        requested.add(CALENDAR_GUEST_PHOTO_SCOPE)
    calls: list[dict[str, object]] = []

    async def consume(**_: object):
        return "attempt-id", {
            "service": "calendar",
            "requested_scope_csv": " ".join(sorted(requested)),
            "created_at": datetime.now(UTC),
        }

    async def exchange(*_: object):
        calls.append({"exchange": True})
        return {"access_token": "synthetic-access", "scope": " ".join(sorted(requested))}

    async def store(**kwargs: object):
        calls.append(kwargs)
        return {"connected": True}

    monkeypatch.setattr(service, "_consume_oauth_attempt", consume)
    monkeypatch.setattr(
        service, "_attempt_context", lambda *_, **__: {"generation": connection_generation(None)}
    )
    monkeypatch.setattr(service, "_post_form", exchange)
    monkeypatch.setattr(service, "_store_authorized_connection", store)

    result = asyncio.run(
        service.complete_native(
            user_id="owner",
            service="calendar",
            access_level="read",
            server_auth_code="synthetic-one-time-code",
            state="synthetic-state",
        )
    )

    assert result["connected"] is True
    assert len(calls) == 2
    assert set(calls[1]["requested_scopes"]) == requested
    assert calls[1]["user_id"] == "owner"
    assert calls[1]["service"] == "calendar"


@pytest.mark.parametrize(
    "boundary", ["extra_scope", "wrong_service", "manage_as_read", "partial_meeting_scope"]
)
def test_native_attempt_cannot_change_service_or_access_at_completion(
    monkeypatch, boundary: str
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(service, "is_configured", lambda: True)
    level = "manage" if boundary == "manage_as_read" else "read"
    scopes = {"openid", "email", "profile", *service.scopes("calendar", level)}
    if boundary == "extra_scope":
        scopes.add("https://www.googleapis.com/auth/drive")
    if boundary == "partial_meeting_scope":
        scopes.add(CALENDAR_MEET_READ_SCOPE)

    async def consume(**_: object):
        return "attempt-id", {
            "service": "drive" if boundary == "wrong_service" else "calendar",
            "requested_scope_csv": " ".join(scopes),
        }

    async def forbidden_exchange(*_: object):
        raise AssertionError("Untrusted native scope set reached provider exchange")

    monkeypatch.setattr(service, "_consume_oauth_attempt", consume)
    monkeypatch.setattr(service, "_post_form", forbidden_exchange)

    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(
            service.complete_native(
                user_id="owner",
                service="calendar",
                access_level="read",
                server_auth_code="synthetic-one-time-code",
                state="synthetic-state",
            )
        )

    assert caught.value.status_code == 400


def test_new_calendar_connection_preserves_base_when_optional_list_scope_is_declined(
    monkeypatch,
) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_, **__: asyncio.sleep(0, result={"sub": "synthetic-provider"}),
    )
    monkeypatch.setattr(service, "_connection", lambda *_, **__: asyncio.sleep(0, result=None))
    monkeypatch.setattr(
        service,
        "_encrypt",
        lambda *_, **__: {"ciphertext": "sealed", "iv": "iv", "tag": "aad-gcm-v1"},
    )
    published: dict = {}
    monkeypatch.setattr(
        service, "_publish_authorization", lambda **kwargs: published.update(kwargs)
    )
    monkeypatch.setattr(
        service,
        "_primary_completion_status",
        lambda *_: asyncio.sleep(0, result={"connected": True}),
    )
    result = asyncio.run(
        service._store_authorized_connection(
            user_id="owner",
            service="calendar",
            token={
                "access_token": "synthetic-access",
                "refresh_token": "synthetic-refresh",
                "expires_in": 3600,
                "scope": " ".join(service.scopes("calendar", "read")),
            },
            requested_scopes=(*service.scopes("calendar", "read"), CALENDAR_LIST_READ_SCOPE),
            oauth_started_at=datetime.now(UTC),
            attempt_id="attempt-id",
            expected_generation=connection_generation(None),
        )
    )
    assert result["connected"] is True
    assert CALENDAR_LIST_READ_SCOPE not in published["grant_params"]["scope_csv"]


def test_missing_provider_scope_claim_cannot_publish_meeting_permission(monkeypatch) -> None:
    service = GoogleConnectionService(db=_Db())
    monkeypatch.setattr(
        service,
        "_userinfo",
        lambda *_, **__: asyncio.sleep(0, result={"sub": "synthetic-provider"}),
    )
    monkeypatch.setattr(service, "_connection", lambda *_, **__: asyncio.sleep(0, result=None))
    requested = (
        *service.scopes("calendar", "read"),
        CALENDAR_MEET_READ_SCOPE,
        CALENDAR_MEET_DRIVE_READ_SCOPE,
    )
    token = {
        "access_token": "synthetic-access",
        "refresh_token": "synthetic-refresh",
        "expires_in": 3600,
    }
    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(
            service._store_authorized_connection(
                user_id="owner",
                service="calendar",
                token=token,
                requested_scopes=requested,
                oauth_started_at=datetime.now(UTC),
                attempt_id="attempt-id",
                expected_generation=connection_generation(None),
            )
        )

    assert caught.value.status_code == 403
    assert caught.value.reason_code == "google_permission_required"
