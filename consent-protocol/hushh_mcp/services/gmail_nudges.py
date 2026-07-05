"""Pure derivation of Gmail inbox "nudges" (smart flashcards).

This module contains NO I/O: it takes already-fetched thread/message metadata and
derives structured nudges the Gmail agent can surface as flashcards (e.g. "Needs a
reply"). Keeping it side-effect free makes the intent logic fully unit-testable and
independent of Gmail API access, OAuth, or the database.

The Gmail I/O (listing threads, resolving the connected address, refreshing tokens)
lives in ``GmailReceiptsService`` and feeds this module the plain data shapes below.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr

# Nudge type identifiers (stable — the frontend keys card rendering off these).
NUDGE_NEEDS_REPLY = "needs_reply"
NUDGE_UPCOMING_MEETING = "upcoming_meeting"

# Local-part prefixes / addresses that indicate an automated sender no human is
# expected to reply to. Filtered out so "Needs a reply" stays high-signal.
_AUTOMATED_LOCALPARTS = (
    "noreply",
    "no-reply",
    "no_reply",
    "donotreply",
    "do-not-reply",
    "do_not_reply",
    "mailer-daemon",
    "postmaster",
    "notifications",
    "notification",
    "automated",
    "bounce",
)


@dataclass(frozen=True)
class NudgeMessage:
    """A single message within a thread, reduced to the fields nudges need."""

    message_id: str
    from_email: str
    from_name: str
    subject: str
    received_at: datetime | None


@dataclass(frozen=True)
class NudgeThread:
    """A thread's messages in chronological order (oldest first)."""

    thread_id: str
    messages: tuple[NudgeMessage, ...]


@dataclass(frozen=True)
class MeetingEvent:
    """A meeting derived from an email — either a calendar invite (.ics) or a
    body-text meeting mention. ``starts_at`` may be None for a mention with no
    parseable time; ``received_at`` is the email's date; ``source`` is
    "invite" or "email"."""

    message_id: str
    thread_id: str
    summary: str
    organizer_name: str
    organizer_email: str
    starts_at: datetime | None
    received_at: datetime | None = None
    source: str = "invite"
    # Conferencing "join" link (Zoom / Google Meet / Teams / Webex), if found.
    meeting_url: str | None = None


@dataclass(frozen=True)
class Nudge:
    """A derived flashcard the Gmail agent can surface."""

    type: str
    thread_id: str
    message_id: str
    title: str
    sender: str
    sender_email: str
    received_at: datetime | None
    # Meeting start time for NUDGE_UPCOMING_MEETING; None for other nudge types.
    starts_at: datetime | None = None
    # Conferencing "join" link for NUDGE_UPCOMING_MEETING; None when unavailable.
    meeting_url: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "type": self.type,
            "thread_id": self.thread_id,
            "message_id": self.message_id,
            "title": self.title,
            "sender": self.sender,
            "sender_email": self.sender_email,
            "received_at": self.received_at.isoformat() if self.received_at else None,
            "starts_at": self.starts_at.isoformat() if self.starts_at else None,
            "meeting_url": self.meeting_url,
        }


def _normalize_email(value: str | None) -> str:
    return (value or "").strip().lower()


def is_automated_sender(from_email: str | None) -> bool:
    """True when the address looks like an automated/no-reply sender."""
    email = _normalize_email(from_email)
    if not email or "@" not in email:
        return True  # unparseable sender -> not a human to reply to
    localpart = email.split("@", 1)[0]
    return any(marker in localpart for marker in _AUTOMATED_LOCALPARTS)


def parse_from_header(raw_from: str | None) -> tuple[str, str]:
    """Split a raw ``From`` header into (display_name, email). Falls back the
    display name to the email's local part when no name is present."""
    name, email = parseaddr(raw_from or "")
    email = _normalize_email(email)
    name = (name or "").strip()
    if not name and email:
        name = email.split("@", 1)[0]
    return name, email


def _newest_message(thread: NudgeThread) -> NudgeMessage | None:
    if not thread.messages:
        return None
    dated = [m for m in thread.messages if m.received_at is not None]
    if dated:
        return max(dated, key=lambda m: m.received_at)  # type: ignore[arg-type]
    return thread.messages[-1]


def derive_needs_reply_nudges(
    threads: list[NudgeThread],
    *,
    user_email: str,
    now: datetime | None = None,
    limit: int = 10,
    max_age_days: int = 30,
) -> list[Nudge]:
    """Derive "Needs a reply" nudges.

    A thread needs a reply when its most recent message is inbound (from someone
    other than the account holder), from a human (not an automated sender), and
    recent enough to still be actionable. Threads where the account holder sent
    the last message are skipped — those are "waiting on them", a future nudge.

    Results are sorted newest-first and capped at ``limit``.
    """
    reference = now or datetime.now(timezone.utc)
    cutoff = reference - timedelta(days=max_age_days)
    account = _normalize_email(user_email)

    nudges: list[Nudge] = []
    for thread in threads:
        newest = _newest_message(thread)
        if newest is None:
            continue
        # Last message is ours -> we already responded / are waiting on them.
        if account and _normalize_email(newest.from_email) == account:
            continue
        if is_automated_sender(newest.from_email):
            continue
        # Stale threads are not actionable nudges.
        if newest.received_at is not None and newest.received_at < cutoff:
            continue

        name, email = (newest.from_name, _normalize_email(newest.from_email))
        title = newest.subject.strip() if newest.subject.strip() else "(no subject)"
        nudges.append(
            Nudge(
                type=NUDGE_NEEDS_REPLY,
                thread_id=thread.thread_id,
                message_id=newest.message_id,
                title=title,
                sender=name or email or "Unknown sender",
                sender_email=email,
                received_at=newest.received_at,
            )
        )

    nudges.sort(
        key=lambda n: n.received_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return nudges[: max(0, limit)]


def derive_nudges(
    threads: list[NudgeThread],
    *,
    user_email: str,
    now: datetime | None = None,
    limit: int = 10,
) -> list[Nudge]:
    """Umbrella deriver for thread-based nudges (currently just "Needs a reply").
    Meeting nudges come from calendar invites via derive_upcoming_meeting_nudges."""
    return derive_needs_reply_nudges(threads, user_email=user_email, now=now, limit=limit)


# ---------------------------------------------------------------------------
# Upcoming meeting nudges (from calendar-invite .ics attachments)
# ---------------------------------------------------------------------------


def _ics_unfold(text: str) -> str:
    """Undo RFC 5545 line folding (a CRLF followed by a space/tab continues a line)."""
    for fold in ("\r\n ", "\r\n\t", "\n ", "\n\t"):
        text = text.replace(fold, "")
    return text


def _ics_line_value(line: str) -> str:
    return line.split(":", 1)[1] if ":" in line else ""


def parse_ics_datetime(value: str) -> datetime | None:
    """Parse an iCalendar DTSTART value. Best-effort: UTC ('...Z'), local/floating,
    and all-day (date-only) forms are all normalized to a UTC datetime."""
    text = (value or "").strip()
    if text.endswith("Z"):
        text = text[:-1]
    try:
        parsed = (
            datetime.strptime(text, "%Y%m%dT%H%M%S")
            if "T" in text
            else datetime.strptime(text, "%Y%m%d")
        )
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc)


# Conferencing "join" links we recognize (Zoom / Google Meet / Teams / Webex).
_MEETING_URL_RE = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*"
    r"(?:zoom\.us/(?:j|my|w|s)/\S+"
    r"|meet\.google\.com/[a-z0-9-]+\S*"
    r"|teams\.microsoft\.com/l/\S+"
    r"|teams\.live\.com/meet/\S+"
    r"|[a-z0-9-]+\.webex\.com/\S+)",
    re.IGNORECASE,
)


def extract_meeting_url(text: str | None) -> str | None:
    """Best-effort conferencing "join" link from free text (Zoom / Google Meet /
    Teams / Webex). Trailing sentence punctuation is stripped. None when absent."""
    if not text:
        return None
    match = _MEETING_URL_RE.search(text)
    if not match:
        return None
    return match.group(0).rstrip(".,;:)]}>\"'")


def parse_ics_event(ics_text: str, *, message_id: str, thread_id: str) -> MeetingEvent | None:
    """Parse SUMMARY / DTSTART / ORGANIZER / conferencing link out of an .ics body.
    Returns None when there is no parseable start time (nothing to schedule a
    nudge around)."""
    summary = ""
    starts_at: datetime | None = None
    organizer_name = ""
    organizer_email = ""
    conference_text = ""  # accumulate LOCATION / DESCRIPTION / URL / X-*-CONFERENCE
    for raw_line in _ics_unfold(ics_text or "").splitlines():
        line = raw_line.strip()
        upper = line.upper()
        if upper.startswith("SUMMARY"):
            summary = _ics_line_value(line).strip()
        elif upper.startswith("DTSTART"):
            starts_at = parse_ics_datetime(_ics_line_value(line))
        elif upper.startswith("ORGANIZER"):
            lower = line.lower()
            if "mailto:" in lower:
                organizer_email = line[lower.index("mailto:") + 7 :].strip().lower()
            if "cn=" in lower:
                cn = line[lower.index("cn=") + 3 :]
                organizer_name = cn.split(":", 1)[0].split(";", 1)[0].strip().strip('"')
        elif (
            upper.startswith("LOCATION")
            or upper.startswith("DESCRIPTION")
            or upper.startswith("URL")
            or "CONFERENCE" in upper
        ):
            conference_text += " " + _ics_line_value(line)
    if starts_at is None:
        return None
    meeting_url = extract_meeting_url(conference_text)
    summary = (
        summary.replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\n", " ")
        .replace("\\N", " ")
        .strip()
    )
    if not organizer_name and organizer_email:
        organizer_name = organizer_email.split("@", 1)[0]
    return MeetingEvent(
        message_id=message_id,
        thread_id=thread_id,
        summary=summary or "(untitled meeting)",
        organizer_name=organizer_name,
        organizer_email=organizer_email,
        starts_at=starts_at,
        meeting_url=meeting_url,
    )


# Words that signal a meeting in an email subject/body (secondary filter over the
# coarse Gmail search). Deliberately excludes bare "call" (too noisy).
_MEETING_LANGUAGE_RE = re.compile(
    r"\b(meeting|let'?s meet|meet up|catch ?up|sync up|1:1|one[ -]on[ -]one|"
    r"schedule (?:a )?(?:call|meeting|time)|calendar invite|zoom|google meet|"
    r"ms teams|teams meeting|hop on a call|book a time)\b",
    re.IGNORECASE,
)

_TIME_RE = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", re.IGNORECASE)
_WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


def looks_like_meeting(text: str | None) -> bool:
    """True when subject/snippet text reads like a meeting request."""
    return bool(_MEETING_LANGUAGE_RE.search(text or ""))


def extract_meeting_datetime(text: str | None, *, now: datetime | None = None) -> datetime | None:
    """Best-effort future meeting time from free text. Conservative: requires an
    explicit time-of-day (e.g. "3pm"); picks the day from "tomorrow" / a named
    weekday, else the next occurrence of that time. Returns None when no time is
    present (the caller then treats it as an undated mention). UTC, stdlib only."""
    reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    lower = (text or "").lower()
    match = _TIME_RE.search(lower)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    meridiem = match.group(3).lower()
    if meridiem == "pm" and hour != 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None

    day = reference.date()
    if "tomorrow" in lower:
        day = (reference + timedelta(days=1)).date()
    else:
        for name, index in _WEEKDAYS.items():
            if name in lower:
                ahead = (index - reference.weekday()) % 7 or 7
                day = (reference + timedelta(days=ahead)).date()
                break

    candidate = datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc)
    if candidate < reference:
        candidate += timedelta(days=1)
    return candidate


def derive_upcoming_meeting_nudges(
    events: list[MeetingEvent],
    *,
    now: datetime | None = None,
    limit: int = 10,
    horizon_days: int = 30,
) -> list[Nudge]:
    """Derive "Upcoming meeting" nudges.

    Only **scheduled** meetings are surfaced: those with a real start time in the
    future and within the horizon (from a .ics invite or a parseable body time).
    One nudge per thread, soonest first, capped at ``limit``.

    Undated meeting-language emails (``starts_at is None``) are intentionally NOT
    surfaced — without a time they cannot be shown as upcoming, counted down to,
    or given a join link, and a past meeting would otherwise linger for days."""
    reference = now or datetime.now(timezone.utc)
    horizon = reference + timedelta(days=horizon_days)

    nudges: list[Nudge] = []
    seen_threads: set = set()
    for event in events:
        if event.starts_at is None or not (reference <= event.starts_at <= horizon):
            continue
        if event.thread_id:
            if event.thread_id in seen_threads:
                continue
            seen_threads.add(event.thread_id)
        nudges.append(
            Nudge(
                type=NUDGE_UPCOMING_MEETING,
                thread_id=event.thread_id,
                message_id=event.message_id,
                title=event.summary,
                sender=event.organizer_name or event.organizer_email or "Organizer",
                sender_email=event.organizer_email,
                received_at=event.received_at,
                starts_at=event.starts_at,
                meeting_url=event.meeting_url,
            )
        )

    nudges.sort(key=lambda n: n.starts_at.timestamp())  # all non-None here
    return nudges[: max(0, limit)]
