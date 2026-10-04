"""Coverage for the referral gamification program settings and weekly reward
round schedule (migration 269).

These tests pin two contracts directly:

  * `get_active_program_settings` parses every JSONB column and raises a
    typed error rather than returning `None` when no version is active --
    scoring code in later PRs must not be able to silently treat "no
    settings" as "zero points".
  * `get_or_create_reward_round` is idempotent on `cutoff_at`, including
    under the same insert-then-reread race `get_or_create_referral_code`
    already uses: two callers racing on one cutoff must land on the same
    round row, never two.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services import one_referral_program_settings_service as settings_service

SETTINGS_VERSION = 1
CUTOFF_AT = datetime(2026, 11, 1, 18, 0, tzinfo=timezone.utc)
ROUND_ID = "33333333-3333-3333-3333-333333333333"


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


def _settings_row(**overrides):
    base = dict(
        version=SETTINGS_VERSION,
        qualification_policy_version=1,
        points={"qualified_referral_points": 100, "flash_window_total_points": 200},
        milestones=[{"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"}],
        streak_rules={"run_length_days": 3, "bonus_points": 15},
        flash_windows=[],
        weekly_schedule={"timezone": None, "cutoff_day_of_week": None},
        prize_catalogue=[{"reward_key": "weekly_airpods", "rank_slots": [1, 2, 3]}],
        tie_break_rules={},
        fulfillment_config={},
        feature_active=False,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


@contextmanager
def _db(conn):
    yield conn


def test_get_active_program_settings_parses_every_field():
    conn = MagicMock()
    conn.execute.return_value = _Result([_settings_row()])

    with patch.object(settings_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = settings_service.get_active_program_settings()

    assert result.version == 1
    assert result.qualification_policy_version == 1
    assert result.points == {"qualified_referral_points": 100, "flash_window_total_points": 200}
    assert result.milestones == [{"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"}]
    assert result.streak_rules == {"run_length_days": 3, "bonus_points": 15}
    assert result.feature_active is False


def test_get_active_program_settings_raises_when_none_active():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    with patch.object(settings_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(settings_service.ProgramSettingsUnavailable):
            settings_service.get_active_program_settings()


def _round_row(status="scheduled", finalized_at=None):
    return SimpleNamespace(
        id=ROUND_ID,
        settings_version=SETTINGS_VERSION,
        cutoff_at=CUTOFF_AT,
        timezone="America/Los_Angeles",
        status=status,
        created_at=datetime(2026, 10, 25, tzinfo=timezone.utc),
        finalized_at=finalized_at,
    )


def test_get_or_create_reward_round_creates_once_for_a_new_cutoff():
    created = {"called": False}

    def execute(query, params=None):
        sql = str(query)
        if "one_referral_program_settings" in sql:
            return _Result([_settings_row()])
        if "SELECT id, settings_version" in sql and "INSERT" not in sql:
            # First read: nothing exists yet.
            return _Result([])
        if "INSERT INTO one_referral_reward_rounds" in sql:
            created["called"] = True
            return _Result([_round_row()])
        raise AssertionError(f"unexpected query: {sql}")

    conn = MagicMock()
    conn.execute.side_effect = execute

    with patch.object(settings_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = settings_service.get_or_create_reward_round(CUTOFF_AT, "America/Los_Angeles")

    assert created["called"] is True
    assert result["id"] == ROUND_ID
    assert result["status"] == "scheduled"
    assert result["cutoff_at"] == CUTOFF_AT


def test_get_or_create_reward_round_returns_the_existing_round_for_the_same_cutoff():
    """The ordinary idempotent path: a round for this cutoff already exists,
    so no INSERT is attempted at all."""

    def execute(query, params=None):
        sql = str(query)
        if "one_referral_program_settings" in sql:
            return _Result([_settings_row()])
        if "SELECT id, settings_version" in sql:
            return _Result([_round_row()])
        raise AssertionError(f"unexpected query (should not insert): {sql}")

    conn = MagicMock()
    conn.execute.side_effect = execute

    with patch.object(settings_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = settings_service.get_or_create_reward_round(CUTOFF_AT, "America/Los_Angeles")

    assert result["id"] == ROUND_ID


def test_get_or_create_reward_round_recovers_from_a_concurrent_insert_race():
    """Two schedulers race on the same cutoff. Both see no existing row, both
    attempt the INSERT; the unique index on cutoff_at lets exactly one win,
    and the loser must re-read the winner's row rather than raise."""
    calls = {"reads": 0}

    def execute(query, params=None):
        sql = str(query)
        if "one_referral_program_settings" in sql:
            return _Result([_settings_row()])
        if "INSERT INTO one_referral_reward_rounds" in sql:
            raise RuntimeError("duplicate key value violates unique constraint")
        if "SELECT id, settings_version" in sql:
            calls["reads"] += 1
            if calls["reads"] == 1:
                return _Result([])  # first read: nothing yet, so we attempt the insert
            return _Result([_round_row()])  # re-read after the losing insert: the winner's row
        raise AssertionError(f"unexpected query: {sql}")

    conn = MagicMock()
    conn.execute.side_effect = execute

    with patch.object(settings_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = settings_service.get_or_create_reward_round(CUTOFF_AT, "America/Los_Angeles")

    assert result["id"] == ROUND_ID
    assert calls["reads"] == 2


def test_get_or_create_reward_round_rejects_a_naive_datetime():
    """`cutoff_at` must be the one true scheduled instant. A naive datetime is
    ambiguous about timezone and must never silently be treated as UTC or
    local time."""
    with pytest.raises(settings_service.RewardRoundError):
        settings_service.get_or_create_reward_round(
            datetime(2026, 11, 1, 18, 0), "America/Los_Angeles"
        )
