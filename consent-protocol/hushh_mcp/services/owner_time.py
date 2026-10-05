"""The owner's clock: which zone they are in, and what a send time means there.

One rule runs through this module: a time the person names is theirs, never
the server's. "Tomorrow at 9" in Kolkata is 03:30 UTC, and a scheduled send
that fires at 09:00 UTC has gone out five and a half hours late while every log
line reads correct.

The model resolves relative phrases ("kal subah", "next Friday") against the
owner-local time the instruction gives it, and passes the owner's wall-clock
time as ISO-8601 without an offset; the server applies the owner's zone,
daylight saving included, because an offset the model attaches to a date past
a daylight-saving change can only be today's. A duration ("in 30 minutes") is
passed as minutes and counted from the server clock, because the instruction's
clock is built once per session and is stale by the time it is said. This
module only validates: it never parses words, never guesses, and never uses a
fuzzy date parser, because a fuzzy parser that reads "9" as today 09:00 UTC is
a confident wrong answer.

The zone is the client's hint (``AuthFrame.timezone``), already bounded by the
auth frame. It is a hint, not authority: an unknown zone degrades to UTC, which
is honest about being a fallback rather than a correct answer.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# A scheduled send must be far enough out that a drain running every minute
# can fire it on time, and near enough that the person still means it.
SCHEDULE_MIN_LEAD_SECONDS = 60
SCHEDULE_HORIZON_DAYS = 30

# Locale-proof names. strftime's %A/%b/%p follow the process locale.
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# Some zones have no letter abbreviation in tzdata and report a bare offset.
_NUMERIC_ABBR = re.compile(r"^([+-])(\d{2})(\d{2})?$")
_INDIA_ZONES = frozenset({"Asia/Calcutta", "Asia/Kolkata"})

_UNPARSEABLE = (
    "I couldn't understand that time. When should I send it — for example, tomorrow at 9 AM?"
)
_IN_PAST = "That time has already passed. What time should I schedule it for?"
_TOO_SOON = (
    "That's less than a minute away — too soon to schedule reliably. "
    "Want me to open a draft to send right now instead?"
)
_TOO_FAR = "I can only schedule up to 30 days ahead. Pick a nearer time?"


class ScheduleTimeError(ValueError):
    """A send time the server will not schedule, with the sentence to say."""

    def __init__(self, code: str, spoken: str) -> None:
        super().__init__(code)
        self.code = code
        self.spoken = spoken


def owner_zone(name: str | None) -> ZoneInfo:
    """The owner's IANA zone, or UTC when the hint is absent or unusable."""
    try:
        return ZoneInfo(name or "UTC")
    except (ValueError, ZoneInfoNotFoundError, OSError):
        # OSError is what ZoneInfo raises for an over-long or unusable name.
        # A bad zone degrades to UTC; it never breaks the caller.
        return ZoneInfo("UTC")


def _zone(value: ZoneInfo | str | None) -> ZoneInfo:
    return value if isinstance(value, ZoneInfo) else owner_zone(value)


def _aware_utc(now: datetime) -> datetime:
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(timezone.utc)


def check_send_at(send_at: datetime, *, now: datetime) -> datetime:
    """An instant already resolved, held against the server clock.

    The three refusals after parsing, in order: already past, too soon to fire
    reliably, beyond the horizon. ``send_at == now + 30 days`` is accepted.
    """
    current = _aware_utc(now)
    send_at = _aware_utc(send_at)
    if send_at <= current:
        raise ScheduleTimeError("schedule_time_in_past", _IN_PAST)
    if send_at <= current + timedelta(seconds=SCHEDULE_MIN_LEAD_SECONDS):
        raise ScheduleTimeError("schedule_time_too_soon", _TOO_SOON)
    if send_at > current + timedelta(days=SCHEDULE_HORIZON_DAYS):
        raise ScheduleTimeError("schedule_time_too_far", _TOO_FAR)
    return send_at


def send_at_after_minutes(minutes: int, *, now: datetime) -> datetime:
    """A duration the person named, counted from the server clock and checked."""
    return check_send_at(_aware_utc(now) + timedelta(minutes=int(minutes)), now=now)


def resolve_send_at(raw: str, *, owner_zone: ZoneInfo | str | None, now: datetime) -> datetime:
    """An absolute send time as aware UTC, or :class:`ScheduleTimeError`.

    Only ISO-8601 with a time of day is accepted. A timestamp without an offset
    is the owner's wall-clock time, because that is what they said, and the
    zone's own rules (daylight saving included) place it; an explicit offset is
    still honoured. Unparseable is refused first, including a year that leaves
    the representable range once converted; then :func:`check_send_at`.
    """
    _aware_utc(now)
    value = str(raw or "").strip()
    # A date alone is not a send time; the model resolves bare dates to 9:00
    # first, so a date-only value is a missing time, not midnight.
    if not value or ("T" not in value and " " not in value):
        raise ScheduleTimeError("schedule_time_unparseable", _UNPARSEABLE)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ScheduleTimeError("schedule_time_unparseable", _UNPARSEABLE) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_zone(owner_zone))
    try:
        # Year 1 east of UTC or year 9999 west of it has no UTC instant.
        send_at = parsed.astimezone(timezone.utc)
    except (OverflowError, ValueError):
        raise ScheduleTimeError("schedule_time_unparseable", _UNPARSEABLE) from None
    return check_send_at(send_at, now=now)


def zone_abbreviation(local: datetime) -> str:
    """A short zone label a person recognises: IST, EDT, or UTC+5:45."""
    key = getattr(local.tzinfo, "key", "")
    name = local.tzname() or ""
    if key in _INDIA_ZONES and not name.isalpha():
        return "IST"
    match = _NUMERIC_ABBR.match(name)
    if match:
        sign, hours, minutes = match.groups()
        label = f"UTC{sign}{int(hours)}"
        return label + (f":{minutes}" if minutes and minutes != "00" else "")
    return name or "UTC"


def _clock(local: datetime) -> str:
    hour = local.hour % 12 or 12
    return f"{hour}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"


def _relative_day(local: datetime, today: datetime) -> tuple[str, bool]:
    """The day as a person says it, and whether it is a named day ("on ...")."""
    days = (local.date() - today.date()).days
    if days == 0:
        return "Today", False
    if days == 1:
        return "Tomorrow", False
    if 1 < days <= 6:
        return _WEEKDAYS[local.weekday()], True
    return f"{local.day} {_MONTHS[local.month - 1]}", True


def format_schedule_echo(
    send_at_utc: datetime, zone: ZoneInfo | str | None, *, now: datetime
) -> str:
    """The on-screen label for a send time: "Tomorrow, 9:00 AM IST"."""
    tz = _zone(zone)
    local = _aware_utc(send_at_utc).astimezone(tz)
    day, _named = _relative_day(local, _aware_utc(now).astimezone(tz))
    return f"{day}, {_clock(local)} {zone_abbreviation(local)}"


def spoken_schedule_time(
    send_at_utc: datetime, zone: ZoneInfo | str | None, *, now: datetime
) -> str:
    """The same time inside a sentence: "tomorrow at 9:00 AM IST", "on Friday at …"."""
    tz = _zone(zone)
    local = _aware_utc(send_at_utc).astimezone(tz)
    day, named = _relative_day(local, _aware_utc(now).astimezone(tz))
    lead = f"on {day}" if named else day.lower()
    return f"{lead} at {_clock(local)} {zone_abbreviation(local)}"


def render_time_block(*, timezone_name: str | None, now: datetime | None = None) -> str:
    """The instruction's clock: server time, the owner's local time, and the rule.

    Built once per live session. It is context for resolving relative phrases,
    not authority: every send time is re-validated against the server clock
    when the card is prepared and again when it is confirmed.
    """
    current = _aware_utc(now or datetime.now(timezone.utc)).replace(microsecond=0)
    tz = owner_zone(timezone_name)
    local = current.astimezone(tz)
    # The owner's wall clock, no offset: tomorrow's offset may not be today's.
    example = (local + timedelta(days=1)).replace(hour=9, minute=0, second=0, tzinfo=None)
    return (
        f"Current time: {current.isoformat()} (UTC). The owner's local time is "
        f"{local.strftime('%Y-%m-%d %H:%M:%S')} {tz.key} — "
        f"{_WEEKDAYS[local.weekday()]}, {local.date().isoformat()}.\n"
        'Resolve relative times ("tomorrow", "kal subah", "next Friday") against '
        "the owner's local time, never against UTC. When you call schedule_mail "
        "for a clock time or a day, pass send_at as the owner's local wall-clock "
        "time in ISO-8601 without a UTC offset, e.g. "
        f"{example.isoformat()}; the server applies the owner's time zone, "
        "including daylight-saving changes. For a duration from now "
        '("in 30 minutes"), pass send_in_minutes instead and leave send_at out. '
        'Never pass words like "tomorrow" as send_at.'
    )


__all__ = [
    "SCHEDULE_HORIZON_DAYS",
    "SCHEDULE_MIN_LEAD_SECONDS",
    "ScheduleTimeError",
    "check_send_at",
    "format_schedule_echo",
    "owner_zone",
    "render_time_block",
    "resolve_send_at",
    "send_at_after_minutes",
    "spoken_schedule_time",
    "zone_abbreviation",
]
