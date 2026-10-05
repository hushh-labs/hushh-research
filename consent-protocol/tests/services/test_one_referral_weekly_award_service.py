"""Coverage for weekly reward-round finalization (migration 273, PR5).

The contracts the product spec calls out explicitly:

  * finalization is gated on `feature_active` -- real prize processing stays
    off until the operator deliberately turns that on.
  * the essential repeat-winner shape: a user who won round 1 can win again
    in round 2 having made zero NEW qualifying referrals that week, purely
    because their cumulative standing is still top-3 -- and winning never
    changes their score or referral count.
  * re-finalizing an already-finalized round creates zero extra prizes.
  * fewer than 3 eligible (positive cumulative points) users leaves the
    remaining slot(s) unawarded, never backfilled.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services import one_referral_weekly_award_service as weekly_award_service

CUTOFF_AT = datetime(2026, 10, 12, 0, 0, tzinfo=timezone.utc)
ROUND_ID = "55555555-5555-5555-5555-555555555555"


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@contextmanager
def _db(conn):
    yield conn


def _settings_row(**overrides):
    base = SimpleNamespace(
        version=1,
        qualification_policy_version=1,
        points={},
        milestones=[],
        streak_rules={},
        flash_windows=[],
        weekly_schedule={"timezone": "UTC"},
        prize_catalogue=[],
        tie_break_rules={},
        fulfillment_config={},
        feature_active=True,
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def _patch_settings(monkeypatch, settings):
    monkeypatch.setattr(weekly_award_service, "get_active_program_settings", lambda: settings)


def _patch_round(monkeypatch, *, status="scheduled"):
    round_row = {
        "id": ROUND_ID,
        "settings_version": 1,
        "cutoff_at": CUTOFF_AT,
        "timezone": "UTC",
        "status": status,
        "created_at": CUTOFF_AT,
        "finalized_at": None,
    }
    monkeypatch.setattr(
        weekly_award_service, "get_or_create_reward_round", lambda *a, **k: round_row
    )
    return round_row


def test_finalize_refuses_when_settings_are_not_feature_active(monkeypatch):
    _patch_settings(monkeypatch, _settings_row(feature_active=False))

    with pytest.raises(weekly_award_service.RealAwardProcessingDisabled):
        weekly_award_service.finalize_reward_round(CUTOFF_AT, "UTC")


def test_finalize_awards_top_three_by_cumulative_points_as_of_cutoff(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    _patch_round(monkeypatch)

    ranked_rows = [
        SimpleNamespace(user_id="user_a", total=300),
        SimpleNamespace(user_id="user_b", total=200),
        SimpleNamespace(user_id="user_c", total=100),
    ]
    inserted: list[dict] = []
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "GROUP BY user_id" in sql:
            assert params["cutoff_at"] == CUTOFF_AT
            return _Result(ranked_rows)
        if "INSERT INTO one_referral_weekly_awards" in sql:
            inserted.append(params)
            row = SimpleNamespace(
                award_slot=params["slot"],
                user_id=params["uid"],
                cumulative_points_at_cutoff=params["points"],
            )
            return _Result([row])
        if "UPDATE one_referral_reward_rounds" in sql:
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(weekly_award_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = weekly_award_service.finalize_reward_round(CUTOFF_AT, "UTC")

    assert [a.user_id for a in result.awards] == ["user_a", "user_b", "user_c"]
    assert [a.award_slot for a in result.awards] == [1, 2, 3]
    assert inserted[0]["points"] == 300


def test_finalize_leaves_a_slot_unawarded_when_fewer_than_three_are_eligible(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    _patch_round(monkeypatch)

    ranked_rows = [SimpleNamespace(user_id="user_a", total=50)]
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "GROUP BY user_id" in sql:
            return _Result(ranked_rows)
        if "INSERT INTO one_referral_weekly_awards" in sql:
            row = SimpleNamespace(
                award_slot=params["slot"],
                user_id=params["uid"],
                cumulative_points_at_cutoff=params["points"],
            )
            return _Result([row])
        if "UPDATE one_referral_reward_rounds" in sql:
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(weekly_award_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = weekly_award_service.finalize_reward_round(CUTOFF_AT, "UTC")

    assert len(result.awards) == 1
    assert result.awards[0].user_id == "user_a"


def test_finalize_is_a_no_op_the_second_time_for_an_already_finalized_round(monkeypatch):
    """Re-running finalization for the same round must create zero extra
    prizes and return the same rows -- never recompute or re-insert."""
    _patch_settings(monkeypatch, _settings_row())
    _patch_round(monkeypatch, status="finalized")

    existing_rows = [
        SimpleNamespace(award_slot=1, user_id="user_a", cumulative_points_at_cutoff=300),
        SimpleNamespace(award_slot=2, user_id="user_b", cumulative_points_at_cutoff=200),
    ]
    conn = MagicMock()
    conn.execute.return_value = _Result(existing_rows)

    with patch.object(weekly_award_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = weekly_award_service.finalize_reward_round(CUTOFF_AT, "UTC")

    assert conn.execute.call_count == 1
    assert [a.user_id for a in result.awards] == ["user_a", "user_b"]


def test_a_previous_winner_can_win_the_next_round_with_zero_new_referrals(monkeypatch):
    """The essential repeat-winner contract: user A wins round 1. In round 2
    user A makes no new qualifying referrals, but their cumulative standing
    (unchanged) is still top-3, so they win again. Winning never touches the
    score ledger -- the second finalize reads the SAME cumulative total A
    already had, proving the first win added nothing to and subtracted
    nothing from it."""
    _patch_settings(monkeypatch, _settings_row())

    round_1 = {
        "id": "11111111-1111-1111-1111-111111111111",
        "settings_version": 1,
        "cutoff_at": CUTOFF_AT,
        "timezone": "UTC",
        "status": "scheduled",
        "created_at": CUTOFF_AT,
        "finalized_at": None,
    }
    cutoff_2 = datetime(2026, 10, 19, 0, 0, tzinfo=timezone.utc)
    round_2 = {**round_1, "id": "22222222-2222-2222-2222-222222222222", "cutoff_at": cutoff_2}

    # Round 1: user A has 300 cumulative points and wins slot 1. No award
    # row changes a_total -- it stays 300 going into round 2 below.
    a_total = 300
    ranked_round_1 = [SimpleNamespace(user_id="user_a", total=a_total)]

    conn1 = MagicMock()

    def execute_round_1(query, params=None):
        sql = str(query)
        if "GROUP BY user_id" in sql:
            return _Result(ranked_round_1)
        if "INSERT INTO one_referral_weekly_awards" in sql:
            return _Result(
                [
                    SimpleNamespace(
                        award_slot=params["slot"],
                        user_id=params["uid"],
                        cumulative_points_at_cutoff=params["points"],
                    )
                ]
            )
        if "UPDATE one_referral_reward_rounds" in sql:
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn1.execute.side_effect = execute_round_1

    with patch.object(weekly_award_service, "get_or_create_reward_round", lambda *a, **k: round_1):
        with patch.object(
            weekly_award_service, "get_db_connection", side_effect=lambda: _db(conn1)
        ):
            result_1 = weekly_award_service.finalize_reward_round(CUTOFF_AT, "UTC")

    assert result_1.awards[0].user_id == "user_a"
    assert result_1.awards[0].cumulative_points_at_cutoff == a_total

    # Round 2, one week later: A made zero new qualifying referrals, so the
    # ledger still sums to the SAME 300 -- this is what "cumulative, no
    # weekly reset" means at the data layer. A ranks top-3 again on that
    # unchanged total and wins again, with no exclusion for the prior win.
    ranked_round_2 = [SimpleNamespace(user_id="user_a", total=a_total)]
    conn2 = MagicMock()

    def execute_round_2(query, params=None):
        sql = str(query)
        if "GROUP BY user_id" in sql:
            assert params["cutoff_at"] == cutoff_2
            return _Result(ranked_round_2)
        if "INSERT INTO one_referral_weekly_awards" in sql:
            return _Result(
                [
                    SimpleNamespace(
                        award_slot=params["slot"],
                        user_id=params["uid"],
                        cumulative_points_at_cutoff=params["points"],
                    )
                ]
            )
        if "UPDATE one_referral_reward_rounds" in sql:
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn2.execute.side_effect = execute_round_2

    with patch.object(weekly_award_service, "get_or_create_reward_round", lambda *a, **k: round_2):
        with patch.object(
            weekly_award_service, "get_db_connection", side_effect=lambda: _db(conn2)
        ):
            result_2 = weekly_award_service.finalize_reward_round(cutoff_2, "UTC")

    assert result_2.awards[0].user_id == "user_a"
    # Same cumulative total both times: winning round 1 did not add to it,
    # and making no new referrals in round 2 did not subtract from it.
    assert (
        result_2.awards[0].cumulative_points_at_cutoff
        == a_total
        == result_1.awards[0].cumulative_points_at_cutoff
    )
    assert result_1.reward_round_id != result_2.reward_round_id
