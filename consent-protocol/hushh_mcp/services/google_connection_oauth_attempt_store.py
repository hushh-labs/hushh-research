"""Persist a Google OAuth attempt with Calendar consent chosen under the owner lock."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from sqlalchemy import text

from hushh_mcp.services.google_calendar_meeting_grant import (
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_MEET_READ_SCOPE,
    CALENDAR_SHARED_DRIVE_METADATA_SCOPE,
)
from hushh_mcp.services.google_connection_contract import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    CALENDAR_LIST_READ_SCOPE,
    GoogleConnectionError,
    GoogleService,
)
from hushh_mcp.services.google_connector_transition_store import require_legacy_publication
from hushh_mcp.services.google_oauth_attempt import connection_generation, encode_attempt


class OAuthAttemptPort(Protocol):
    db: Any

    def _signed_state(self, attempt_id: str) -> str: ...

    def _lock_google_owner(self, connection: Any, user_id: str) -> None: ...

    def _encrypt(self, value: str, *, aad: str) -> dict[str, str]: ...

    def scopes(
        self, service: GoogleService, access_level: Literal["read", "manage"]
    ) -> tuple[str, ...]: ...


def expire_oauth_attempt(connection: Any, attempt_id: str) -> None:
    """Consume the one-time callback record in its publication transaction."""
    connection.execute(
        text(
            "UPDATE google_oauth_attempts SET expires_at = clock_timestamp() WHERE attempt_id = :attempt_id"
        ),
        {"attempt_id": attempt_id},
    )


def _include_guest_photos(
    connection: Any,
    *,
    user_id: str,
    service: GoogleService,
    calendar_additional: bool,
    calendar_account_id: str | None,
    provider_row: Any,
) -> bool:
    existing_grant = None
    if service == "calendar" and not calendar_additional:
        existing_grant = (
            connection.execute(
                text("""SELECT status, guest_photo_access FROM google_service_grants
                WHERE user_id = :user_id AND provider = 'google' AND service = 'calendar' FOR UPDATE"""),
                {"user_id": user_id},
            )
            .mappings()
            .first()
        )
    additional_photo_access = False
    if calendar_account_id:
        account = (
            connection.execute(
                text("""SELECT status, guest_photo_access FROM google_calendar_additional_accounts
                WHERE user_id = :user_id AND account_id = :account_id FOR UPDATE"""),
                {"user_id": user_id, "account_id": calendar_account_id},
            )
            .mappings()
            .first()
        )
        if not account or account["status"] == "disconnected":
            raise GoogleConnectionError(
                "Choose a connected Calendar account to reconnect", status_code=409
            )
        additional_photo_access = account["status"] in ("connected", "needs_reauth") and bool(
            account["guest_photo_access"]
        )
    elif calendar_additional:
        slots = connection.execute(
            text("""SELECT COUNT(*) FROM google_calendar_additional_accounts
            WHERE user_id = :user_id AND status IN ('connected', 'needs_reauth')"""),
            {"user_id": user_id},
        ).scalar_one()
        default_calendar = connection.execute(
            text("""SELECT 1 FROM google_service_grants
            WHERE user_id = :user_id AND provider = 'google' AND service = 'calendar'
            AND status IN ('connected', 'needs_reauth')"""),
            {"user_id": user_id},
        ).first()
        if (
            slots
            + int(
                bool(provider_row and provider_row["status"] != "disconnected" and default_calendar)
            )
            >= 3
        ):
            raise GoogleConnectionError(
                "Calendar supports up to three connected accounts.", status_code=409
            )
    return service == "calendar" and (
        additional_photo_access
        if calendar_additional
        else bool(
            existing_grant
            and existing_grant["status"] in ("connected", "needs_reauth")
            and existing_grant["guest_photo_access"]
        )
    )


def _requested_scopes(
    port: OAuthAttemptPort,
    *,
    service: GoogleService,
    access_level: Literal["read", "manage"],
    transport: Literal["web", "native"],
    include_calendar_list: bool,
    include_meeting_files: bool,
    include_guest_photos: bool,
) -> tuple[str, ...]:
    return (
        "openid",
        "email",
        "profile",
        *port.scopes(service, access_level),
        *(
            (CALENDAR_LIST_READ_SCOPE,)
            if service == "calendar"
            and (transport == "web" or include_calendar_list or include_meeting_files)
            else ()
        ),
        *(
            (
                CALENDAR_MEET_READ_SCOPE,
                CALENDAR_MEET_DRIVE_READ_SCOPE,
                CALENDAR_SHARED_DRIVE_METADATA_SCOPE,
            )
            if service == "calendar" and include_meeting_files
            else ()
        ),
        *((CALENDAR_GUEST_PHOTO_SCOPE,) if include_guest_photos else ()),
    )


def _persist_attempt(
    port: OAuthAttemptPort,
    *,
    user_id: str,
    service: GoogleService,
    access_level: Literal["read", "manage"],
    redirect_uri: str,
    transport: Literal["web", "native"],
    include_calendar_list: bool,
    include_meeting_files: bool,
    calendar_additional: bool,
    calendar_account_id: str | None,
    attempt_id: str,
    verifier: str,
    state: str,
) -> tuple[str, ...]:
    with port.db.engine.begin() as connection:
        port._lock_google_owner(connection, user_id)
        require_legacy_publication(connection, user_id)
        row = (
            connection.execute(
                text(
                    "SELECT * FROM google_provider_connections WHERE user_id = :user_id AND provider = 'google' FOR UPDATE"
                ),
                {"user_id": user_id},
            )
            .mappings()
            .first()
        )
        generation = connection_generation(dict(row) if row else None)
        if service == "gmail" and calendar_additional:
            if not calendar_account_id:
                raise GoogleConnectionError(
                    "Choose an additional Calendar account", status_code=422
                )
            selected = (
                connection.execute(
                    text("""SELECT * FROM google_calendar_additional_accounts
                    WHERE user_id = :user_id AND account_id = :account_id FOR UPDATE"""),
                    {"user_id": user_id, "account_id": calendar_account_id},
                )
                .mappings()
                .first()
            )
            if not selected or selected["status"] != "connected":
                raise GoogleConnectionError(
                    "Reconnect the selected Calendar account", status_code=409
                )
            generation = connection_generation(dict(selected))
        include_photos = _include_guest_photos(
            connection,
            user_id=user_id,
            service=service,
            calendar_additional=calendar_additional,
            calendar_account_id=calendar_account_id,
            provider_row=row,
        )
        scopes = _requested_scopes(
            port,
            service=service,
            access_level=access_level,
            transport=transport,
            include_calendar_list=include_calendar_list,
            include_meeting_files=include_meeting_files,
            include_guest_photos=include_photos,
        )
        connection.execute(
            text("""INSERT INTO google_oauth_attempts (
              attempt_id, user_id, service, redirect_uri, requested_scope_csv,
              state_digest, verifier_ciphertext, verifier_iv, verifier_tag, expires_at, created_at,
              calendar_additional, calendar_account_id
            ) VALUES (
              :attempt_id, :user_id, :service, :redirect_uri, :scope_csv,
              :state_digest, :ciphertext, :iv, :tag, :expires_at, clock_timestamp(),
              :calendar_additional, :calendar_account_id
            )"""),
            {
                "attempt_id": attempt_id,
                "user_id": user_id,
                "service": service,
                "redirect_uri": redirect_uri,
                "scope_csv": " ".join(scopes),
                "calendar_additional": calendar_additional,
                "calendar_account_id": calendar_account_id,
                "state_digest": hashlib.sha256(state.encode()).hexdigest(),
                **port._encrypt(
                    encode_attempt(verifier=verifier, generation=generation, transport=transport),
                    aad=f"oauth-attempt:{attempt_id}",
                ),
                "expires_at": datetime.now(UTC) + timedelta(minutes=10),
            },
        )
        return scopes


async def create_oauth_attempt(
    port: OAuthAttemptPort,
    *,
    user_id: str,
    service: GoogleService,
    access_level: Literal["read", "manage"],
    redirect_uri: str,
    transport: Literal["web", "native"],
    include_calendar_list: bool = False,
    include_meeting_files: bool = False,
    calendar_additional: bool = False,
    calendar_account_id: str | None = None,
) -> dict[str, Any]:
    attempt_id = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    state = port._signed_state(attempt_id)
    try:
        scopes = await asyncio.to_thread(
            _persist_attempt,
            port,
            user_id=user_id,
            service=service,
            access_level=access_level,
            redirect_uri=redirect_uri,
            transport=transport,
            include_calendar_list=include_calendar_list,
            include_meeting_files=include_meeting_files,
            calendar_additional=calendar_additional,
            calendar_account_id=calendar_account_id,
            attempt_id=attempt_id,
            verifier=verifier,
            state=state,
        )
    except GoogleConnectionError:
        raise
    except Exception:
        raise GoogleConnectionError(
            "Google connection could not be started. Please try again.", status_code=503
        ) from None
    return {"state": state, "verifier": verifier, "scopes": scopes}
