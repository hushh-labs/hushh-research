"""Calendar-day streak contract: one per day, independent of award intervals."""

from datetime import date, timedelta

from hushh_mcp.services.one_referral_activity_service import next_daily_streak


def test_streak_increases_once_per_day_and_continues_past_weekly_and_bonus_boundaries():
    start = date(2026, 10, 11)
    last = None
    current = longest = 0
    for day in range(10):
        today = start + timedelta(days=day)
        current, longest = next_daily_streak(last, current, longest, today)
        assert (current, longest) == (day + 1, day + 1)
        assert next_daily_streak(today, current, longest, today) == (current, longest)
        assert next_daily_streak(today, current, longest, today - timedelta(days=1)) == (
            current,
            longest,
        )
        last = today


def test_a_missed_day_starts_a_new_run_and_preserves_the_longest():
    assert next_daily_streak(date(2026, 10, 14), 8, 12, date(2026, 10, 16)) == (1, 12)
