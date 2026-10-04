"""Base/flash point selection and streak-award recomputation.

Pure-function operon: no database, no clock. These tests pin the product
rules directly:

  * flash REPLACES the base award, it never adds to it, and falling inside
    more than one overlapping configured window still counts once;
  * a streak bonus is awarded on the referrer's distinct qualifying calendar
    days, not on raw referral count, and recomputing from the same input
    always gives the same answer regardless of call order -- which is what
    makes it safe to call from a worker that may reprocess a job.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from hushh_mcp.operons.referral_scoring.points import (
    BASE_QUALIFICATION,
    FLASH_QUALIFICATION,
    compute_streak_awards,
    current_streak_progress,
    is_within_a_flash_window,
    points_for_qualification,
)

SETTINGS_POINTS = {"qualified_referral_points": 100, "flash_window_total_points": 200}


def _window(start: datetime, end: datetime) -> dict:
    return {"start": start.isoformat(), "end": end.isoformat()}


# --- flash windows -----------------------------------------------------------


def test_outside_any_window_earns_base_points():
    qualified_at = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
    windows = [
        _window(
            datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc),
            datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc),
        )
    ]

    award = points_for_qualification(qualified_at, SETTINGS_POINTS, windows)

    assert award.event_type == BASE_QUALIFICATION
    assert award.points == 100


def test_inside_a_window_earns_flash_points_instead_of_base():
    qualified_at = datetime(2026, 11, 8, 15, 0, tzinfo=timezone.utc)
    windows = [
        _window(
            datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc),
            datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc),
        )
    ]

    award = points_for_qualification(qualified_at, SETTINGS_POINTS, windows)

    assert award.event_type == FLASH_QUALIFICATION
    assert award.points == 200


def test_window_is_half_open_start_inclusive_end_exclusive():
    start = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)
    end = datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc)
    windows = [_window(start, end)]

    assert is_within_a_flash_window(start, windows) is True
    assert is_within_a_flash_window(end, windows) is False
    assert is_within_a_flash_window(end - timedelta(seconds=1), windows) is True


def test_overlapping_windows_still_count_once():
    qualified_at = datetime(2026, 11, 8, 15, 0, tzinfo=timezone.utc)
    windows = [
        _window(
            datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc),
            datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc),
        ),
        _window(
            datetime(2026, 11, 8, 14, 0, tzinfo=timezone.utc),
            datetime(2026, 11, 8, 20, 0, tzinfo=timezone.utc),
        ),
    ]

    award = points_for_qualification(qualified_at, SETTINGS_POINTS, windows)

    assert award.event_type == FLASH_QUALIFICATION
    assert award.points == 200


def test_malformed_window_entries_are_ignored_not_fatal():
    qualified_at = datetime(2026, 11, 8, 15, 0, tzinfo=timezone.utc)
    windows = [{}, {"start": "not-a-date", "end": "also-not-a-date"}, None, "garbage"]

    assert is_within_a_flash_window(qualified_at, windows) is False


def test_naive_qualified_at_is_rejected():
    with pytest.raises(ValueError):
        is_within_a_flash_window(datetime(2026, 11, 8, 15, 0), [])


# --- streaks -------------------------------------------------------------


def _d(iso: str) -> date:
    return date.fromisoformat(iso)


def test_three_consecutive_days_earns_one_award_on_the_third():
    dates = [_d("2026-11-01"), _d("2026-11-02"), _d("2026-11-03")]

    awards = compute_streak_awards(dates, already_awarded_through=None)

    assert awards == [_d("2026-11-03")]


def test_two_consecutive_days_earns_nothing_yet():
    dates = [_d("2026-11-01"), _d("2026-11-02")]

    assert compute_streak_awards(dates, already_awarded_through=None) == []


def test_a_gap_resets_the_run():
    dates = [
        _d("2026-11-01"),
        _d("2026-11-02"),
        _d("2026-11-05"),
        _d("2026-11-06"),
        _d("2026-11-07"),
    ]

    awards = compute_streak_awards(dates, already_awarded_through=None)

    assert awards == [_d("2026-11-07")]


def test_multiple_qualifiers_on_one_day_still_count_as_one_day():
    dates = [_d("2026-11-01"), _d("2026-11-01"), _d("2026-11-02"), _d("2026-11-03")]

    awards = compute_streak_awards(dates, already_awarded_through=None)

    assert awards == [_d("2026-11-03")]


def test_runs_are_non_overlapping_six_days_earns_two_awards():
    dates = [_d(f"2026-11-0{n}") for n in range(1, 7)]

    awards = compute_streak_awards(dates, already_awarded_through=None)

    assert awards == [_d("2026-11-03"), _d("2026-11-06")]


def test_already_awarded_through_prevents_reawarding_the_same_run():
    dates = [_d("2026-11-01"), _d("2026-11-02"), _d("2026-11-03")]

    awards = compute_streak_awards(dates, already_awarded_through=_d("2026-11-03"))

    assert awards == []


def test_recompute_after_a_late_delayed_event_only_awards_the_new_run():
    """A worker already paid through day 3. A delayed event for day 2 arrives
    and is reprocessed alongside days 4-6 that have since also qualified.
    Recomputing from the full set must not re-pay days 1-3 and must still pay
    days 4-6 once."""
    dates = [_d(f"2026-11-0{n}") for n in range(1, 7)]

    awards = compute_streak_awards(dates, already_awarded_through=_d("2026-11-03"))

    assert awards == [_d("2026-11-06")]


def test_processing_order_does_not_affect_the_result():
    forward = [_d(f"2026-11-0{n}") for n in range(1, 7)]
    shuffled = [forward[2], forward[0], forward[5], forward[1], forward[4], forward[3]]

    assert compute_streak_awards(shuffled, None) == compute_streak_awards(forward, None)


def test_current_streak_progress_with_no_history_is_zero():
    assert current_streak_progress([], today=_d("2026-11-05")) == 0


def test_current_streak_progress_counts_a_live_run():
    dates = [_d("2026-11-04"), _d("2026-11-05")]

    assert current_streak_progress(dates, today=_d("2026-11-05")) == 2


def test_current_streak_progress_counts_yesterday_as_still_live():
    dates = [_d("2026-11-04")]

    assert current_streak_progress(dates, today=_d("2026-11-05")) == 1


def test_current_streak_progress_is_zero_after_a_gap():
    dates = [_d("2026-11-01"), _d("2026-11-02")]

    assert current_streak_progress(dates, today=_d("2026-11-05")) == 0


def test_current_streak_progress_resets_to_zero_right_after_a_completed_run():
    dates = [_d("2026-11-01"), _d("2026-11-02"), _d("2026-11-03")]

    assert current_streak_progress(dates, today=_d("2026-11-03")) == 0


def test_weekly_award_cutoffs_do_not_reset_the_streak():
    """Nothing here reads a reward-round cutoff at all -- the streak is a
    pure function of qualifying calendar days, so a weekly cutoff landing in
    the middle of a run changes nothing about whether that run completes."""
    dates = [_d("2026-11-01"), _d("2026-11-02"), _d("2026-11-03")]
    with_round_boundary_irrelevant = compute_streak_awards(dates, already_awarded_through=None)

    assert with_round_boundary_irrelevant == [_d("2026-11-03")]
