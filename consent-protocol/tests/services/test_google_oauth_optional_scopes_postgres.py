"""Optional meeting-file grants use the current disposable PostgreSQL schema."""

import pytest
from sqlalchemy import text

from hushh_mcp.services.google_calendar_meeting_grant import CALENDAR_SHARED_DRIVE_METADATA_SCOPE
from hushh_mcp.services.google_connection_service import (
    CALENDAR_LIST_READ_SCOPE,
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_MEET_READ_SCOPE,
)
from tests.google_oauth_postgres_support import OWNER, finish, start

pytest_plugins = ("tests.google_oauth_postgres_support",)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "meeting_scopes",
    [
        (),
        (CALENDAR_MEET_READ_SCOPE, CALENDAR_MEET_DRIVE_READ_SCOPE),
        (
            CALENDAR_MEET_READ_SCOPE,
            CALENDAR_MEET_DRIVE_READ_SCOPE,
            CALENDAR_SHARED_DRIVE_METADATA_SCOPE,
        ),
    ],
)
async def test_new_calendar_grant_persists_actual_optional_meeting_scopes(
    pg_service, meeting_scopes
):
    service, engine = pg_service
    granted = (*service.scopes("calendar", "read"), CALENDAR_LIST_READ_SCOPE, *meeting_scopes)
    service._post_form.side_effect = None
    service._post_form.return_value = {
        "access_token": "synthetic-access",
        "refresh_token": "synthetic-refresh",
        "scope": " ".join(granted),
        "expires_in": 3600,
    }
    attempt = await service.start_native(
        user_id=OWNER, service="calendar", access_level="read", include_meeting_files=True
    )
    result = await finish(service, attempt)
    assert result["connected"] is True
    with engine.connect() as connection:
        stored = connection.execute(
            text(
                "SELECT scope_csv FROM google_service_grants WHERE user_id = :owner AND service = 'calendar'"
            ),
            {"owner": OWNER},
        ).scalar_one()
    assert set(stored.split()) == set(granted)


@pytest.mark.asyncio
async def test_first_calendar_after_mail_persists_partial_optional_consent(pg_service):
    service, engine = pg_service
    mail_scopes = service.scopes("gmail", "read")
    service._post_form.side_effect = None
    service._post_form.return_value = {
        "access_token": "synthetic-mail-access",
        "refresh_token": "synthetic-mail-refresh",
        "scope": " ".join(mail_scopes),
        "expires_in": 3600,
    }
    mail_attempt = await service.start_native(user_id=OWNER, service="gmail", access_level="read")
    assert (await finish(service, mail_attempt, "mail", service="gmail"))["connected"] is True

    calendar_scopes = (*service.scopes("calendar", "read"), CALENDAR_LIST_READ_SCOPE)
    service._post_form.return_value = {
        "access_token": "synthetic-calendar-access",
        "refresh_token": "synthetic-calendar-refresh",
        "scope": " ".join((*mail_scopes, *calendar_scopes)),
        "expires_in": 3600,
    }
    attempt = await service.start_native(
        user_id=OWNER, service="calendar", access_level="read", include_meeting_files=True
    )
    assert (await finish(service, attempt, "calendar"))["connected"] is True
    with engine.connect() as connection:
        grants = dict(
            connection.execute(
                text(
                    "SELECT service, scope_csv FROM google_service_grants WHERE user_id = :owner AND status = 'connected'"
                ),
                {"owner": OWNER},
            ).all()
        )
    assert set(grants) == {"gmail", "calendar"}
    assert set(mail_scopes) <= set(grants["gmail"].split())
    assert set(grants["calendar"].split()) == set((*mail_scopes, *calendar_scopes))


@pytest.mark.asyncio
async def test_new_additional_account_partial_meeting_consent_preserves_primary(pg_service):
    service, engine = pg_service
    await finish(service, await start(service), "primary")
    primary_before = await service.status(user_id=OWNER, service="calendar")
    service._userinfo.return_value = {"sub": "synthetic-additional", "email": "second@example.test"}
    granted = (*service.scopes("calendar", "manage"), CALENDAR_LIST_READ_SCOPE)
    service._post_form.side_effect = None
    service._post_form.return_value = {
        "access_token": "synthetic-access-additional",
        "refresh_token": "synthetic-refresh-additional",
        "scope": " ".join(granted),
        "expires_in": 3600,
    }
    attempt = await service.start_native(
        user_id=OWNER,
        service="calendar",
        access_level="manage",
        calendar_additional=True,
        include_meeting_files=True,
    )
    result = await finish(service, attempt, "additional", access_level="manage")
    assert result["connected"] is True
    assert result["completed_account_id"] != "default"
    assert set(
        next(
            account
            for account in result["accounts"]
            if account["account_id"] == result["completed_account_id"]
        )["scope_csv"].split()
    ) == set(granted)
    primary_after = await service.status(user_id=OWNER, service="calendar")
    assert primary_after["scope_csv"] == primary_before["scope_csv"]
    with engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM google_calendar_additional_accounts WHERE user_id = :owner"
                ),
                {"owner": OWNER},
            ).scalar_one()
            == 1
        )
