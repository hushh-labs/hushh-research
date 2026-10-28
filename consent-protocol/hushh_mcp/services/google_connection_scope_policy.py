"""Scope preservation rules when a shared Google credential is replaced."""

from __future__ import annotations

from typing import Any, Callable, Protocol

from sqlalchemy import text

from hushh_mcp.services.google_connection_contract import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    GoogleConnectionError,
    GoogleService,
)


class ScopeQueryPort(Protocol):
    async def _execute_raw_async(self, sql: str, params: dict[str, Any] | None = None) -> Any: ...


def selected_grant_scopes(
    token_scope: str, requested_scopes: tuple[str, ...], service: GoogleService
) -> tuple[str, set[str], bool]:
    """Persist only proven optional authority; retain mandatory scope validation."""
    granted = set(token_scope.split())
    scopes = token_scope or " ".join(
        scope for scope in requested_scopes if scope != CALENDAR_GUEST_PHOTO_SCOPE
    )
    guest_photos = (
        service == "calendar"
        and CALENDAR_GUEST_PHOTO_SCOPE in requested_scopes
        and CALENDAR_GUEST_PHOTO_SCOPE in granted
    )
    return scopes, granted, guest_photos


async def require_previous_google_scopes(
    port: ScopeQueryPort,
    *,
    user_id: str,
    token_scope: str,
    covers: Callable[[set[str], set[str]], bool],
) -> None:
    """A new shared bearer cannot silently revoke a connected service grant."""
    grants = await port._execute_raw_async(
        """SELECT scope_csv FROM google_service_grants
           WHERE user_id = :user_id AND provider = 'google' AND status = 'connected'""",
        {"user_id": user_id},
    )
    required = {
        scope
        for grant in grants.data
        for scope in str(grant.get("scope_csv") or "").strip().split()
        if scope != CALENDAR_GUEST_PHOTO_SCOPE
    }
    if required and (not token_scope or not covers(set(token_scope.split()), required)):
        raise GoogleConnectionError(
            "Keep the existing Google permissions when connecting another service.",
            status_code=409,
        )


def require_previous_calendar_scopes(
    *,
    prior: dict[str, Any] | None,
    token_scope: str,
    covers: Callable[[set[str], set[str]], bool],
) -> None:
    if not prior or prior.get("status") != "connected":
        return
    required = set(str(prior.get("scope_csv") or "").strip().split()) - {CALENDAR_GUEST_PHOTO_SCOPE}
    if not covers(set(token_scope.split()), required):
        raise GoogleConnectionError(
            "Keep the existing Calendar permissions when reconnecting.", status_code=409
        )


def clear_stale_calendar_photo_grant(connection: Any, user_id: str) -> None:
    """A replacement shared bearer without Contacts authority cannot advertise it."""
    connection.execute(
        text("""UPDATE google_service_grants
           SET guest_photo_access = FALSE, updated_at = clock_timestamp()
           WHERE user_id = :user_id AND provider = 'google'
             AND service = 'calendar' AND guest_photo_access = TRUE"""),
        {"user_id": user_id},
    )
