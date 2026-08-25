"""Regression coverage for the referral counter 50-row cap.

`get_referral_summary()` used to compute `qualified_count`, `in_progress_count`
and `under_review_count` from the same 50-row window that backs the Recent
list. A referrer with more than 50 referral relationships saw counters that
silently stopped climbing at 50, even though the underlying relationships kept
growing. These tests pin the fix: the counters must reflect every relationship
the referrer owns, while the Recent list stays bounded at 50.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hushh_mcp.services import one_referral_service

USER_ID = "user_referrer_123"
NOW = datetime(2026, 8, 25, tzinfo=timezone.utc)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


def _policy_row():
    return SimpleNamespace(
        version=1,
        program_enabled=True,
        new_users_only=True,
        attribution_window_days=30,
        qualification_window_days=7,
        required_active_seconds=900,
        minimum_meaningful_events=3,
        eligible_agent_keys=(),
        heartbeat_interval_seconds=30,
        max_credit_per_heartbeat_secs=30,
        recent_interaction_window_secs=60,
        max_reporting_gap_seconds=90,
    )


def _code_row():
    return SimpleNamespace(slug="ada-1234", normalized_slug="ada-1234", created_at=NOW)


def _relationship_row(status: str):
    return SimpleNamespace(
        status=status,
        created_at=NOW,
        qualified_at=None,
        credited_seconds=0,
        meaningful_events=0,
    )


def _conn_with_relationships(all_statuses: list[str]):
    """A fake connection whose responses depend on which query is issued.

    The counting query and the detail query both select from
    `one_referral_relationships`, so they are told apart by whether the SQL
    text carries the LATERAL join that only the detail query uses.
    """
    all_rows = [SimpleNamespace(status=s) for s in all_statuses]
    detail_rows = [_relationship_row(s) for s in all_statuses[:50]]

    def execute(query, params=None):
        sql = str(query)
        if "one_referral_policies" in sql:
            return _Result([_policy_row()])
        if "one_referral_codes" in sql:
            return _Result([_code_row()])
        if "one_referral_relationships" in sql:
            if "LATERAL" in sql:
                return _Result(detail_rows)
            return _Result(all_rows)
        raise AssertionError(f"unexpected query: {sql}")

    conn = MagicMock()
    conn.execute.side_effect = execute
    return conn


@contextmanager
def _db(conn):
    yield conn


def test_counters_are_not_capped_at_the_fifty_row_recent_limit():
    # 63 total referrals: 60 in progress (an "In progress" status), 3 qualified.
    statuses = ["qualified"] * 3 + ["attributed"] * 60
    conn = _conn_with_relationships(statuses)

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        summary = one_referral_service.get_referral_summary(USER_ID)

    assert summary["in_progress_count"] == 60
    assert summary["qualified_count"] == 3
    assert len(summary["referrals"]) == 50


def test_under_review_count_is_not_capped_either():
    statuses = ["under_review"] * 55 + ["qualified"] * 2
    conn = _conn_with_relationships(statuses)

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        summary = one_referral_service.get_referral_summary(USER_ID)

    assert summary["under_review_count"] == 55
    assert summary["qualified_count"] == 2
    assert len(summary["referrals"]) == 50


def test_counts_and_recent_list_agree_when_under_the_cap():
    statuses = ["qualified", "attributed", "under_review"]
    conn = _conn_with_relationships(statuses)

    with patch.object(one_referral_service, "get_db_connection", side_effect=lambda: _db(conn)):
        summary = one_referral_service.get_referral_summary(USER_ID)

    assert summary["qualified_count"] == 1
    assert summary["in_progress_count"] == 1
    assert summary["under_review_count"] == 1
    assert len(summary["referrals"]) == 3
