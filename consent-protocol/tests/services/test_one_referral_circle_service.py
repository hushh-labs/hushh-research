"""Worker authority rejects timestamp-only (legacy lifetime) team resolution."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

from hushh_mcp.services import one_referral_circle_service as circles
from hushh_mcp.services.one_referral_circle_service import resolve_contributing_circle


def test_legacy_interval_alone_never_proves_weekly_opt_in():
    connection = MagicMock()
    assert (
        resolve_contributing_circle(connection, user_id="owner", as_of=datetime.now(timezone.utc))
        is None
    )
    connection.execute.assert_not_called()


def period_row(*, round_id="round-one", cutoff=None, now=None):
    cutoff = cutoff or datetime(2026, 10, 18, 18, 30, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=round_id,
        started_at=cutoff - timedelta(days=7),
        cutoff_at=cutoff,
        timezone="Asia/Kolkata",
        status="scheduled",
        now=now or cutoff - timedelta(hours=1),
    )


def test_current_period_uses_database_time_even_when_physical_prizes_are_disabled(monkeypatch):
    resolver = Mock(
        return_value={"calendar_active": True, "active": False, "round_id": "round-one"}
    )
    monkeypatch.setattr(circles, "get_challenge_status", resolver)
    row = period_row()
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = row
    result = circles._period(connection)
    assert result["seconds_remaining"] == 3600
    assert result["server_now"] == row.now.isoformat()
    assert result["ends_at"] == row.cutoff_at.isoformat()
    assert result["timezone"] == "Asia/Kolkata"
    assert "clock_timestamp()" in str(connection.execute.call_args.args[0])


def test_current_period_re_resolves_if_database_read_crosses_cutoff(monkeypatch):
    first = period_row()
    first.now = first.cutoff_at
    second = period_row(
        round_id="round-two", cutoff=first.cutoff_at + timedelta(days=7), now=first.now
    )
    resolver = Mock(
        side_effect=[{"calendar_active": True, "round_id": row.id} for row in [first, second]]
    )
    monkeypatch.setattr(circles, "get_challenge_status", resolver)
    connection = MagicMock()
    connection.execute.return_value.fetchone.side_effect = [first, second]
    result = circles._period(connection)
    assert result["round_id"] == "round-two"
    assert result["seconds_remaining"] == 7 * 86400
    assert resolver.call_count == 2


def test_repeated_period_rollover_is_bounded_and_retryable(monkeypatch):
    resolver = Mock(return_value={"calendar_active": True, "round_id": "round-one"})
    monkeypatch.setattr(circles, "get_challenge_status", resolver)
    row = period_row()
    row.now = row.cutoff_at + timedelta(seconds=1)
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = row
    with pytest.raises(circles.CircleWarsError) as error:
        circles._period(connection)
    assert error.value.status == 503
    assert error.value.code == "COMPETITION_WEEK_CHANGED"
    assert resolver.call_count == 2


def test_historical_period_stays_on_requested_round_at_zero(monkeypatch):
    resolver = Mock()
    monkeypatch.setattr(circles, "get_challenge_status", resolver)
    row = period_row()
    row.now = row.cutoff_at + timedelta(days=1)
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = row
    result = circles._period(connection, "round-one")
    assert result["round_id"] == "round-one"
    assert result["seconds_remaining"] == 0
    resolver.assert_not_called()
