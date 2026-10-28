"""Shared types and errors for the Google connection service ports."""

from __future__ import annotations

from typing import Literal

GoogleService = Literal["gmail", "calendar", "contacts", "drive"]
CALENDAR_LIST_READ_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
CALENDAR_GUEST_PHOTO_SCOPE = "https://www.googleapis.com/auth/contacts.readonly"


class GoogleConnectionError(RuntimeError):
    def __init__(
        self, message: str, *, status_code: int = 400, reason_code: str | None = None
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.reason_code = reason_code
