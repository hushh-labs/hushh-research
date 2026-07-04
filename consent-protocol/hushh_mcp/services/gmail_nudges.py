"""Pure derivation of Gmail inbox "nudges" (smart flashcards).

This module contains NO I/O: it takes already-fetched thread/message metadata and
derives structured nudges the Gmail agent can surface as flashcards (e.g. "Needs a
reply"). Keeping it side-effect free makes the intent logic fully unit-testable and
independent of Gmail API access, OAuth, or the database.

The Gmail I/O (listing threads, resolving the connected address, refreshing tokens)
lives in ``GmailReceiptsService`` and feeds this module the plain data shapes below.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr

# Nudge type identifiers (stable — the frontend keys card rendering off these).
NUDGE_NEEDS_REPLY = "needs_reply"

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
class Nudge:
    """A derived flashcard the Gmail agent can surface."""

    type: str
    thread_id: str
    message_id: str
    title: str
    sender: str
    sender_email: str
    received_at: datetime | None

    def to_dict(self) -> dict[str, object]:
        return {
            "type": self.type,
            "thread_id": self.thread_id,
            "message_id": self.message_id,
            "title": self.title,
            "sender": self.sender,
            "sender_email": self.sender_email,
            "received_at": self.received_at.isoformat() if self.received_at else None,
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
    """Umbrella deriver. Currently emits only "Needs a reply"; additional nudge
    types (e.g. upcoming meetings) will compose here behind the same interface."""
    return derive_needs_reply_nudges(threads, user_email=user_email, now=now, limit=limit)
