"""Weekly challenge cutoff computation, from program settings alone.

Pure function: given the configured weekly schedule and the current instant,
decide when the current seven-day challenge round closes and when it
started. No database, no clock -- `now` is always a parameter, never read
internally, matching `points.py` and `milestones.py` in this package.

This is a display computation only. It never creates, reads, or writes a
`one_referral_reward_rounds` row -- that table's own schedule-slot creation
(`get_or_create_reward_round`) is a separate, not-yet-wired operational path
gated behind the program's own scheduler. A dashboard showing a countdown and
a round actually being opened for finalization are different concerns.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class WeeklyChallengeWindow:
    week_started_at: datetime
    cutoff_at: datetime
    timezone: str


def next_weekly_cutoff(now: datetime, weekly_schedule: dict) -> WeeklyChallengeWindow | None:
    """The current seven-day round's start and close, in UTC.

    Returns `None` when the schedule is unset (v1's state, by design, until a
    settings version supplies a real timezone/cutoff_day_of_week/cutoff_time)
    or malformed -- a caller must treat that as "no published round yet", not
    guess at a deadline the program has not configured.

    `cutoff_day_of_week` is ISO 8601 (1 = Monday .. 7 = Sunday). The returned
    window always has `now` strictly inside it: `week_started_at <= now <
    cutoff_at`, by walking back from the next occurrence of the cutoff
    weekday/time rather than forward from an arbitrary epoch.
    """
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")

    tz_name = weekly_schedule.get("timezone")
    day_of_week = weekly_schedule.get("cutoff_day_of_week")
    time_str = weekly_schedule.get("cutoff_time")
    if not isinstance(tz_name, str) or not tz_name:
        return None
    if not isinstance(day_of_week, int) or not (1 <= day_of_week <= 7):
        return None
    if not isinstance(time_str, str) or not time_str:
        return None

    try:
        program_tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return None
    try:
        cutoff_time = time.fromisoformat(time_str)
    except ValueError:
        return None

    local_now = now.astimezone(program_tz)
    days_until_cutoff = (day_of_week - local_now.isoweekday()) % 7
    candidate_date = local_now.date() + timedelta(days=days_until_cutoff)
    cutoff_local = datetime.combine(candidate_date, cutoff_time, tzinfo=program_tz)
    if cutoff_local <= local_now:
        cutoff_local += timedelta(days=7)

    week_start_local = cutoff_local - timedelta(days=7)
    return WeeklyChallengeWindow(
        week_started_at=week_start_local.astimezone(timezone.utc),
        cutoff_at=cutoff_local.astimezone(timezone.utc),
        timezone=tz_name,
    )
