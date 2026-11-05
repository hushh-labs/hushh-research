"""Selected Calendar account plus separately authorized Gmail read grant.

This adapter deliberately does not select the user's default Gmail mailbox for
an additional Calendar account. It binds both grants before yielding a token
and checks the same epochs after every provider request.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime

from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service
from hushh_mcp.services.google_connection_service import get_google_connection_service


class SelectedMailAccessError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SelectedMailGrant:
    user_id: str
    account_id: str
    provider_subject: str
    calendar_binding: tuple[str, ...]
    mail_binding: tuple[str, ...]
    token: str

    @property
    def epoch_digest(self) -> str:
        content = json.dumps(
            [self.user_id, self.account_id, self.calendar_binding, self.mail_binding],
            separators=(",", ":"),
        )
        return hashlib.sha256(content.encode()).hexdigest()

    @property
    def mail_generation(self) -> str:
        return str(self.mail_binding[-1])

    @property
    def calendar_connected_at(self) -> datetime:
        return datetime.fromisoformat(
            self.calendar_binding[3 if self.account_id == "default" else 4]
        )

    @property
    def provider_subject_sha256(self) -> str:
        return hashlib.sha256(self.provider_subject.encode()).hexdigest()

    @property
    def calendar_grant_revision(self) -> str | None:
        return self.calendar_binding[-1] if self.account_id == "default" else None

    async def require_current(self) -> None:
        try:
            current = await _bindings(self.user_id, self.account_id)
        except SelectedMailAccessError:
            raise SelectedMailAccessError("mail_grant_changed") from None
        if current != (
            self.provider_subject,
            self.calendar_binding,
            self.mail_binding,
        ):
            raise SelectedMailAccessError("mail_grant_changed")


async def _bindings(user_id: str, account_id: str) -> tuple[str, tuple[str, ...], tuple[str, ...]]:
    google = get_google_connection_service()
    calendar = await google.read_calendar_grant_identity(user_id=user_id, account_id=account_id)
    if calendar is None:
        raise SelectedMailAccessError("calendar_account_unavailable")
    if account_id == "default":
        gmail = get_gmail_receipts_service()
        row = await asyncio.to_thread(gmail._fetch_connection_row, user_id=user_id)
        if (
            not row
            or row.get("status") != "connected"
            or row.get("revoked") is not False
            or row.get("google_sub") != calendar.provider_subject
            or "https://www.googleapis.com/auth/gmail.readonly"
            not in str(row.get("scope_csv") or "").replace(",", " ").split()
            or not row.get("followup_read_generation")
        ):
            raise SelectedMailAccessError("selected_mail_permission_required")
        mail_binding = (
            user_id,
            "gmail",
            account_id,
            str(row["google_sub"]),
            str(row["followup_read_generation"]),
        )
    else:
        mail_binding = await google.read_grant_binding(
            user_id=user_id, service="gmail", account_id=account_id
        )
        if not mail_binding:
            raise SelectedMailAccessError("selected_mail_permission_required")
    return calendar.provider_subject, calendar.binding, mail_binding


async def open_selected_mail_grant(*, user_id: str, account_id: str) -> SelectedMailGrant:
    subject, calendar_binding, mail_binding = await _bindings(user_id, account_id)
    if account_id == "default":
        token = await get_gmail_receipts_service().get_read_access_token(user_id=user_id)
    else:
        token = await get_google_connection_service().access_token(
            user_id=user_id, service="gmail", access_level="read", account_id=account_id
        )
    if (subject, calendar_binding, mail_binding) != await _bindings(user_id, account_id):
        raise SelectedMailAccessError("mail_grant_changed")
    return SelectedMailGrant(
        user_id=user_id,
        account_id=account_id,
        provider_subject=subject,
        calendar_binding=calendar_binding,
        mail_binding=mail_binding,
        token=token,
    )


async def selected_mail_status(*, user_id: str, account_id: str) -> bool:
    try:
        await _bindings(user_id, account_id)
    except SelectedMailAccessError:
        return False
    return True


async def selected_mail_epoch_digest(*, user_id: str, account_id: str) -> str | None:
    """Digest of the selected account's current grants, or None if mail is not granted.

    Lets a status check compare the live grant to a stored monitor without
    opening a token or contacting Gmail.
    """
    try:
        subject, calendar_binding, mail_binding = await _bindings(user_id, account_id)
    except SelectedMailAccessError:
        return None
    return SelectedMailGrant(
        user_id=user_id,
        account_id=account_id,
        provider_subject=subject,
        calendar_binding=calendar_binding,
        mail_binding=mail_binding,
        token="",  # noqa: S106 - no credential is opened here
    ).epoch_digest
