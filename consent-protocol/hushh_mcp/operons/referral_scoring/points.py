"""Base/flash point selection and streak-award recomputation.

Both functions take already-fetched values (settings JSON, a sorted list of
dates) and return a decision; neither touches the database or the clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

BASE_QUALIFICATION = "base_qualification"
FLASH_QUALIFICATION = "flash_qualification"
STREAK_BONUS = "streak_bonus"
REVERSAL = "reversal"

STREAK_RUN_LENGTH_DAYS = 3


@dataclass(frozen=True)
class QualificationAward:
    event_type: str
    points: int


def _parse_window_edge(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def is_within_a_flash_window(qualified_at: datetime, flash_windows: list) -> bool:
    """True if `qualified_at` falls in ANY configured [start, end) window.

    Membership in more than one overlapping window still counts once: this is
    a yes/no check, not a count, which is what keeps overlapping windows from
    stacking a qualification's flash credit.
    """
    if qualified_at.tzinfo is None:
        raise ValueError("qualified_at must be timezone-aware")
    for window in flash_windows or []:
        if not isinstance(window, dict):
            continue
        start = _parse_window_edge(window.get("start"))
        end = _parse_window_edge(window.get("end"))
        if start is None or end is None or end <= start:
            continue
        if start <= qualified_at < end:
            return True
    return False


def points_for_qualification(
    qualified_at: datetime, settings_points: dict, flash_windows: list
) -> QualificationAward:
    """What one qualifying relationship is worth, as of `qualified_at`.

    Flash REPLACES the base award for this relationship; it never adds to it.
    Doubling raw referral counts, milestone counts, or streak bonuses is
    explicitly out of scope for a flash window -- this function only ever
    returns one of the two qualification event types, never both.
    """
    base_points = int(settings_points.get("qualified_referral_points", 0))
    flash_points = int(settings_points.get("flash_window_total_points", base_points))
    if is_within_a_flash_window(qualified_at, flash_windows):
        return QualificationAward(FLASH_QUALIFICATION, flash_points)
    return QualificationAward(BASE_QUALIFICATION, base_points)


def compute_streak_awards(
    qualifying_dates: list,
    already_awarded_through: date | None,
) -> list:
    """Which NEW non-overlapping 3-day runs, if any, should now be paid.

    Recomputed from the referrer's full set of distinct qualifying calendar
    days every time, rather than tracked as a running counter, so this
    function is order-independent: calling it with the same dates and
    watermark always returns the same answer regardless of what order the
    underlying qualification events actually arrived or were reprocessed in.
    Each returned date is the THIRD day of a newly-completed run, which is
    also what the caller uses to build that award's idempotency key.

    `qualifying_dates` need not be pre-sorted or de-duplicated: multiple
    qualifiers on the same calendar day still count as one qualifying day.
    """
    distinct_sorted = sorted(set(qualifying_dates))
    awards: list = []
    run_length = 0
    previous_day: date | None = None
    for day in distinct_sorted:
        if previous_day is not None and (day - previous_day) == timedelta(days=1):
            run_length += 1
        else:
            run_length = 1
        previous_day = day
        if run_length == STREAK_RUN_LENGTH_DAYS:
            if already_awarded_through is None or day > already_awarded_through:
                awards.append(day)
            run_length = 0
    return awards


def current_streak_progress(qualifying_dates: list, today: date) -> int:
    """How many consecutive days toward the next streak bonus, right now.

    A display-only read, never used for awarding: the worker's own
    `compute_streak_awards` is the sole source of truth for that. The streak
    is considered live only if its most recent qualifying day is today or
    yesterday; a longer gap displays as 0 even though the historical run
    that already completed and paid out is untouched. Weekly award cutoffs
    never enter this calculation -- a streak crossing one keeps counting.
    """
    distinct_sorted = sorted(set(qualifying_dates))
    if not distinct_sorted:
        return 0
    if (today - distinct_sorted[-1]) > timedelta(days=1):
        return 0

    run_length = 0
    previous_day: date | None = None
    for day in distinct_sorted:
        if previous_day is not None and (day - previous_day) == timedelta(days=1):
            run_length += 1
        else:
            run_length = 1
        previous_day = day
        if run_length == STREAK_RUN_LENGTH_DAYS:
            run_length = 0
    return run_length
