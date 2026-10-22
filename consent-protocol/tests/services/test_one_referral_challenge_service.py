"""A weekly-prize clock follows the persisted round and fresh server time."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hushh_mcp.services import one_referral_challenge_service as challenge

SCHEDULE = {"timezone": "Asia/Kolkata", "cutoff_day_of_week": 1, "cutoff_time": "00:00:00"}
CUTOFF = datetime(2026, 10, 18, 18, 30, tzinfo=timezone.utc)


def configure(monkeypatch, *, enabled=True, status="scheduled", times=None):
    settings = SimpleNamespace(feature_active=enabled, weekly_schedule=SCHEDULE)
    monkeypatch.setattr(challenge, "get_active_program_settings", lambda: settings)
    now = CUTOFF - timedelta(days=2)
    clock = Mock(side_effect=times or [now, now + timedelta(seconds=5)])
    monkeypatch.setattr(challenge, "datetime", SimpleNamespace(now=clock))
    rounds = Mock(side_effect=lambda cutoff, tz: {"id": cutoff.isoformat()})
    monkeypatch.setattr(challenge, "get_or_create_reward_round", rounds)

    def execute(statement, params):
        if "RETURNING" not in str(statement):
            return None
        start = params["start"]
        row = SimpleNamespace(
            started_at=start,
            cutoff_at=start + timedelta(days=7),
            timezone="Asia/Kolkata",
            status=status,
        )
        return SimpleNamespace(fetchone=lambda: row)

    @contextmanager
    def database():
        yield SimpleNamespace(execute=execute)

    monkeypatch.setattr(challenge, "get_db_connection", database)
    return rounds


@pytest.mark.parametrize(
    "enabled,status,active",
    [(False, "scheduled", False), (True, "scheduled", True), (True, "finalized", False)],
)
def test_only_an_enabled_open_prize_round_is_active(monkeypatch, enabled, status, active):
    configure(monkeypatch, enabled=enabled, status=status)
    result = challenge.get_challenge_status()
    assert result["active"] is result["campaign_active"] is active
    assert result["weekly_prizes_enabled"] is enabled
    assert result["calendar_active"] is True
    assert result["cutoff_at"] == CUTOFF.isoformat()
    assert result["server_now"] == (CUTOFF - timedelta(days=2) + timedelta(seconds=5)).isoformat()
    assert result["server_processing_ms"] >= 0


def test_database_wait_crossing_cutoff_resolves_the_new_round(monkeypatch):
    before = CUTOFF - timedelta(milliseconds=100)
    after = CUTOFF + timedelta(milliseconds=100)
    rounds = configure(monkeypatch, times=[before, after, after])
    result = challenge.get_challenge_status()
    assert rounds.call_count == 2
    assert result["active"] is True
    assert result["week_started_at"] == CUTOFF.isoformat()
    assert result["cutoff_at"] == (CUTOFF + timedelta(days=7)).isoformat()
    assert result["server_now"] == after.isoformat()


def test_an_unconfigured_schedule_has_no_prize_deadline(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(
        challenge, "get_active_program_settings", lambda: SimpleNamespace(weekly_schedule={})
    )
    result = challenge.get_challenge_status()
    assert result["active"] is result["campaign_active"] is False
    assert result["cutoff_at"] is None


def test_repeated_rollover_uses_retryable_failure_instead_of_claiming_prizes_paused(monkeypatch):
    configure(
        monkeypatch,
        times=[
            CUTOFF - timedelta(seconds=1),
            CUTOFF + timedelta(days=8),
            CUTOFF + timedelta(days=16),
        ],
    )
    with pytest.raises(RuntimeError, match="changed during read"):
        challenge.get_challenge_status()
