"""The one Google authorization set a Calendar account is connected with.

Calendar, Google Meet, Google Drive and Gmail are requested in a single Google
consent so a person never meets a second Hussh permission screen. This module
is the only place that names the optional capabilities and their scopes; the
attempt store requests them and the publication code records what Google
actually returned. Google's own account chooser and consent screens remain the
provider's, and a partial grant is a normal outcome, never an error.

| Capability     | Scopes                                                     | Access       |
| -------------- | ---------------------------------------------------------- | ------------ |
| Calendar       | calendar.events, calendar.freebusy, calendarlist.readonly  | read + write |
| Meet files     | meetings.space.readonly, drive.meet.readonly               | read         |
| Drive metadata | drive.metadata.readonly (names of organizer-shared files)  | read         |
| Mail read      | gmail.readonly (follow-up discovery)                       | read         |
| Mail send      | gmail.send (only a reviewed meeting email)                 | write        |

Nothing here asks for unrestricted Drive, mailbox modification or drafts.
Gmail read is a Google restricted scope and send a sensitive one. Whether each
scope is listed on the Google Cloud consent screen and verified is Console
state this repository cannot prove; see
docs/reference/iam/gmail-google-verification-readiness.md.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from hushh_mcp.services.google_calendar_meeting_grant import (
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_MEET_READ_SCOPE,
    CALENDAR_SHARED_DRIVE_METADATA_SCOPE,
)

CALENDAR_MAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
CALENDAR_MAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"

MEETING_FILE_SCOPES = (
    CALENDAR_MEET_READ_SCOPE,
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_SHARED_DRIVE_METADATA_SCOPE,
)
MAIL_SCOPES = (CALENDAR_MAIL_READ_SCOPE, CALENDAR_MAIL_SEND_SCOPE)


@dataclass(frozen=True)
class MailGrant:
    """What Google returned for Mail on one authorization, not what was asked."""

    requested: bool
    read: bool
    send: bool

    @property
    def outcome(self) -> str:
        if not self.requested:
            return "not_requested"
        return "granted" if self.read else "declined"


def optional_scopes(*, include_meeting_files: bool, include_mail_access: bool) -> tuple[str, ...]:
    """Optional scopes beyond Calendar itself, in a stable order."""
    return (
        *(MEETING_FILE_SCOPES if include_meeting_files else ()),
        *(MAIL_SCOPES if include_mail_access else ()),
    )


def mail_grant(requested_scopes: Iterable[str], granted_scope: str) -> MailGrant:
    """Per-capability Mail result from the attempt's request and Google's reply."""
    requested = set(requested_scopes)
    granted = set(granted_scope.split())
    asked = CALENDAR_MAIL_READ_SCOPE in requested
    return MailGrant(
        requested=asked,
        read=asked and CALENDAR_MAIL_READ_SCOPE in granted,
        send=CALENDAR_MAIL_SEND_SCOPE in requested and CALENDAR_MAIL_SEND_SCOPE in granted,
    )
