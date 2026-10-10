"""Reward-threshold boundaries for the production milestone ladder.

The dashboard renders `next_milestone` / `earned` from `get_milestone_progress`
directly -- it does not recompute thresholds client-side. This pins the exact
crossing behaviour at every boundary the referral-dashboard repair brief calls
out for the real four-reward ladder (voucher at 10, earbuds at 100, AirPods at
500, iPhone at 10,000), using `lifetime_qualified_count` as the single source
`get_milestone_progress` reads -- never pending referrals, never bonus points.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hushh_mcp.services import one_referral_leaderboard_service as leaderboard_service

EARNED_AT = datetime(2026, 11, 9, tzinfo=timezone.utc)

MILESTONES = [
    {"milestone_key": "voucher_10", "threshold": 10, "reward": "₹250 Amazon voucher"},
    {"milestone_key": "earbuds_100", "threshold": 100, "reward": "Wireless earbuds, worth ₹10,000"},
    {"milestone_key": "airpods_500", "threshold": 500, "reward": "Apple AirPods, worth ₹30,000"},
    {"milestone_key": "iphone_10000", "threshold": 10000, "reward": "iPhone"},
]


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


def _progress(qualified_count: int, earned_keys: list[str]):
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_relationships" in sql:
            return _Result([SimpleNamespace(total=qualified_count)])
        if "FROM one_referral_milestone_entitlements" in sql:
            return _Result(
                [
                    SimpleNamespace(milestone_key=key, reward="x", earned_at=EARNED_AT)
                    for key in earned_keys
                ]
            )
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        return leaderboard_service.get_milestone_progress("user_a", settings_milestones=MILESTONES)


def test_9_of_10_has_not_crossed_the_voucher():
    progress = _progress(9, earned_keys=[])
    assert progress["next_milestone"]["milestone_key"] == "voucher_10"
    assert progress["next_milestone"]["progress"] == 9
    assert progress["earned"] == []


def test_10_of_10_crosses_the_voucher():
    progress = _progress(10, earned_keys=["voucher_10"])
    assert [m["milestone_key"] for m in progress["earned"]] == ["voucher_10"]
    assert progress["next_milestone"]["milestone_key"] == "earbuds_100"
    assert progress["next_milestone"]["progress"] == 10


def test_99_of_100_has_not_crossed_the_earbuds():
    progress = _progress(99, earned_keys=["voucher_10"])
    assert progress["next_milestone"]["milestone_key"] == "earbuds_100"
    assert progress["next_milestone"]["progress"] == 99
    assert "earbuds_100" not in [m["milestone_key"] for m in progress["earned"]]


def test_100_of_100_crosses_the_earbuds():
    progress = _progress(100, earned_keys=["voucher_10", "earbuds_100"])
    assert set(m["milestone_key"] for m in progress["earned"]) == {"voucher_10", "earbuds_100"}
    assert progress["next_milestone"]["milestone_key"] == "airpods_500"


def test_499_of_500_has_not_crossed_the_airpods():
    progress = _progress(499, earned_keys=["voucher_10", "earbuds_100"])
    assert progress["next_milestone"]["milestone_key"] == "airpods_500"
    assert progress["next_milestone"]["progress"] == 499


def test_500_of_500_crosses_the_airpods():
    progress = _progress(500, earned_keys=["voucher_10", "earbuds_100", "airpods_500"])
    assert set(m["milestone_key"] for m in progress["earned"]) == {
        "voucher_10",
        "earbuds_100",
        "airpods_500",
    }
    assert progress["next_milestone"]["milestone_key"] == "iphone_10000"


def test_9999_of_10000_has_not_crossed_the_iphone():
    progress = _progress(9999, earned_keys=["voucher_10", "earbuds_100", "airpods_500"])
    assert progress["next_milestone"]["milestone_key"] == "iphone_10000"
    assert progress["next_milestone"]["progress"] == 9999


def test_10000_of_10000_crosses_the_iphone_and_earns_every_reward():
    progress = _progress(
        10000, earned_keys=["voucher_10", "earbuds_100", "airpods_500", "iphone_10000"]
    )
    assert set(m["milestone_key"] for m in progress["earned"]) == {
        "voucher_10",
        "earbuds_100",
        "airpods_500",
        "iphone_10000",
    }
    assert progress["next_milestone"] is None
