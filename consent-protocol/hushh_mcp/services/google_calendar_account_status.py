"""Present owner-bound Calendar accounts without exposing Google credentials."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Callable, Literal, Protocol

from hushh_mcp.services.google_oauth_attempt import connection_generation


class CalendarAccountStatusOwner(Protocol):
    async def status(self, *, user_id: str, service: Literal["calendar"]) -> dict[str, Any]: ...

    async def _execute_raw_async(self, sql: str, params: dict[str, Any]) -> Any: ...

    async def _connection(self, user_id: str) -> dict[str, Any] | None: ...

    async def _calendar_picture(
        self, *, user_id: str, account_id: str, row: dict[str, Any]
    ) -> dict[str, str | None] | None: ...


_ACCOUNTS_SQL = """SELECT account_id, provider_subject, provider_email,
                      refresh_token_ciphertext, status, scope_csv, access_level,
                      connected_at
               FROM google_calendar_additional_accounts WHERE user_id = :user_id
               ORDER BY connected_at, account_id"""


def _project_accounts(
    default: dict[str, Any],
    rows: list[dict[str, Any]],
    primary: dict[str, Any] | None,
    pictures: dict[tuple[str, str], dict[str, str | None] | None],
    calendar_list_access: Callable[[object | None], bool],
) -> list[dict[str, Any]]:
    accounts: list[dict[str, Any]] = []
    if default["status"] != "disconnected":
        accounts.append(
            {
                "account_id": "default",
                "google_email": default["google_email"],
                "profile_photo_url": (
                    pictures.get(("default", connection_generation(primary))) or {}
                ).get("picture_url")
                if primary
                else None,
                "hosted_domain": (
                    pictures.get(("default", connection_generation(primary))) or {}
                ).get("hosted_domain")
                if primary
                else None,
                "provider_subject_sha256": hashlib.sha256(
                    str(primary["provider_subject"]).encode()
                ).hexdigest()
                if primary and default["connected"] and primary.get("provider_subject")
                else "",
                "status": default["status"],
                "connected": default["connected"],
                "access_level": default["access_level"],
                "scope_csv": default.get("scope_csv", "") if default["connected"] else "",
                "grant_generation": connection_generation(primary)
                if primary and default["connected"]
                else "",
                "calendar_list_access": default.get("calendar_list_access", False),
            }
        )
    for row in rows:
        if row["status"] == "disconnected":
            continue
        accounts.append(
            {
                "account_id": row["account_id"],
                "google_email": row["provider_email"],
                "profile_photo_url": (
                    pictures.get((row["account_id"], connection_generation(row))) or {}
                ).get("picture_url")
                if row["status"] == "connected"
                else None,
                "hosted_domain": (
                    pictures.get((row["account_id"], connection_generation(row))) or {}
                ).get("hosted_domain")
                if row["status"] == "connected"
                else None,
                "provider_subject_sha256": hashlib.sha256(
                    str(row["provider_subject"]).encode()
                ).hexdigest()
                if row["status"] == "connected" and row.get("provider_subject")
                else "",
                "status": row["status"],
                "connected": row["status"] == "connected",
                "access_level": row["access_level"],
                "scope_csv": row.get("scope_csv", "") if row["status"] == "connected" else "",
                "grant_generation": connection_generation(row)
                if row["status"] == "connected"
                else "",
                "calendar_list_access": calendar_list_access(row["scope_csv"]),
            }
        )
    return accounts


async def calendar_accounts_status(
    owner: CalendarAccountStatusOwner,
    *,
    user_id: str,
    calendar_list_access: Callable[[object | None], bool],
) -> dict[str, Any]:
    """Read photos with each grant and fence the final account projection."""
    default = await owner.status(user_id=user_id, service="calendar")
    result = await owner._execute_raw_async(_ACCOUNTS_SQL, {"user_id": user_id})
    primary = await owner._connection(user_id) if default["connected"] else None
    photo_rows = ([("default", primary)] if primary else []) + [
        (row["account_id"], row) for row in result.data
    ]
    photos = await asyncio.gather(
        *(
            owner._calendar_picture(user_id=user_id, account_id=account_id, row=row)
            for account_id, row in photo_rows
        )
    )
    pictures = {
        (account_id, connection_generation(row)): photo
        for (account_id, row), photo in zip(photo_rows, photos, strict=True)
    }
    # A lookup may refresh a bearer and discover revoked authority. Re-read
    # status and generations so a stale photo never accompanies a new grant.
    default = await owner.status(user_id=user_id, service="calendar")
    result = await owner._execute_raw_async(_ACCOUNTS_SQL, {"user_id": user_id})
    primary = await owner._connection(user_id) if default["connected"] else None
    accounts = _project_accounts(default, result.data, primary, pictures, calendar_list_access)
    return {
        **default,
        # Legacy top-level fields describe the default grant. Other accounts
        # cannot act through its authorization.
        "accounts": accounts,
        "account_limit": 3,
    }
