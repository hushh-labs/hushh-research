"""Optional meeting-file OAuth scopes and selected Calendar grant identity."""

from __future__ import annotations

from dataclasses import dataclass

from hushh_mcp.services.google_connection_contract import (
    CALENDAR_LIST_READ_SCOPE,
    GoogleConnectionError,
)

CALENDAR_MEET_READ_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly"
CALENDAR_MEET_DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.meet.readonly"
MEETING_SCOPES = {CALENDAR_MEET_READ_SCOPE, CALENDAR_MEET_DRIVE_READ_SCOPE}


@dataclass(frozen=True)
class CalendarGrantIdentity:
    """One selected account and its exact revocable Calendar grant."""

    user_id: str
    account_id: str
    provider_subject: str
    binding: tuple[str, ...]


def require_meeting_scopes(requested, granted, error_type):
    if MEETING_SCOPES.intersection(requested) and not MEETING_SCOPES.issubset(set(granted)):
        raise error_type(
            "Recording and notes permission was not granted.",
            status_code=403,
            reason_code="calendar_meeting_files_permission_required",
        )


async def require_existing_calendar_optional_scopes(
    owner, *, user_id, service, existing, requested_scopes, granted_scopes, token_scope, covers
):
    """Do not make optional first-connection scopes fatal on a sibling grant."""
    if service != "calendar" or not existing or existing.get("status") != "connected":
        return
    prior = await owner._execute_raw_async(
        """SELECT status FROM google_service_grants
           WHERE user_id = :user_id AND provider = 'google' AND service = 'calendar'""",
        {"user_id": user_id},
    )
    if not (prior.data and prior.data[0].get("status") == "connected"):
        return
    require_meeting_scopes(requested_scopes, granted_scopes, GoogleConnectionError)
    if CALENDAR_LIST_READ_SCOPE in requested_scopes and not covers(
        set(token_scope.split()), {CALENDAR_LIST_READ_SCOPE}
    ):
        raise GoogleConnectionError(
            "Calendar list permission was not granted",
            status_code=403,
            reason_code="calendar_list_permission_required",
        )


def native_allowed_scope_sets(service, base, calendar_list_scope, guest_photo_scope):
    allowed = [base]
    if service == "calendar":
        for mask in range(1, 8):
            allowed.append(
                base
                | ({calendar_list_scope} if mask & 1 else set())
                | ({guest_photo_scope} if mask & 2 else set())
                | (MEETING_SCOPES if mask & 4 else set())
            )
    return allowed


async def read_calendar_grant_identity(owner, *, user_id, account_id, clean):
    binding = await owner.read_grant_binding(
        user_id=user_id, service="calendar", account_id=account_id
    )
    if not binding:
        return None
    row = (
        await owner._connection(user_id)
        if account_id == "default"
        else await owner._calendar_account(user_id, account_id)
    )
    subject = clean((row or {}).get("provider_subject"))
    if not subject or binding != await owner.read_grant_binding(
        user_id=user_id, service="calendar", account_id=account_id
    ):
        return None
    return CalendarGrantIdentity(user_id, account_id, subject, binding)


def requested_calendar_level(requested_scopes):
    return (
        "manage"
        if "https://www.googleapis.com/auth/calendar.events" in requested_scopes
        else "read"
    )
