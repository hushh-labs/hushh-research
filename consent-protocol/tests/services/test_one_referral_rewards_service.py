"""Lifetime milestone entitlements and the fulfillment review foundation.

Pins: issuing a milestone is idempotent at the database layer too (not just
in the pure-function operon), a concurrent-race loser never creates a
duplicate fulfillment record, and `decide_fulfillment` only ever changes a
status column -- no purchase or shipment action.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services import one_referral_rewards_service as rewards_service

USER = "user_rewards"
MILESTONES = [{"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"}]


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


def test_evaluate_and_issue_milestones_issues_a_new_entitlement_and_fulfillment_record():
    conn = MagicMock()
    fulfillment_inserts = []

    def execute(query, params=None):
        sql = str(query)
        if "SELECT COUNT(*) AS total" in sql:
            return _Result([SimpleNamespace(total=5)])
        if "SELECT milestone_key" in sql:
            return _Result([])
        if "INSERT INTO one_referral_milestone_entitlements" in sql:
            return _Result([SimpleNamespace(id="entitlement-1")])
        if "INSERT INTO one_referral_fulfillment_records" in sql:
            fulfillment_inserts.append(params)
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    issued = rewards_service.evaluate_and_issue_milestones(
        conn, user_id=USER, settings_milestones=MILESTONES, settings_version=1
    )

    assert issued == [{"milestone_key": "tee_5", "reward": "hushh_tee"}]
    assert fulfillment_inserts == [{"eid": "entitlement-1"}]


def test_evaluate_and_issue_milestones_is_a_no_op_below_threshold():
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "SELECT COUNT(*) AS total" in sql:
            return _Result([SimpleNamespace(total=4)])
        if "SELECT milestone_key" in sql:
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    issued = rewards_service.evaluate_and_issue_milestones(
        conn, user_id=USER, settings_milestones=MILESTONES, settings_version=1
    )

    assert issued == []


def test_evaluate_and_issue_milestones_handles_a_lost_concurrent_race():
    """Two workers race to issue the same milestone. ON CONFLICT DO NOTHING
    means the loser's INSERT returns no row; it must not then insert a
    second, orphaned fulfillment record."""
    conn = MagicMock()
    fulfillment_inserts = []

    def execute(query, params=None):
        sql = str(query)
        if "SELECT COUNT(*) AS total" in sql:
            return _Result([SimpleNamespace(total=5)])
        if "SELECT milestone_key" in sql:
            return _Result([])
        if "INSERT INTO one_referral_milestone_entitlements" in sql:
            return _Result([])  # lost the race: ON CONFLICT DO NOTHING, no row returned
        if "INSERT INTO one_referral_fulfillment_records" in sql:
            fulfillment_inserts.append(params)
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    issued = rewards_service.evaluate_and_issue_milestones(
        conn, user_id=USER, settings_milestones=MILESTONES, settings_version=1
    )

    assert issued == []
    assert fulfillment_inserts == []


def test_decide_fulfillment_rejects_an_invalid_decision():
    with pytest.raises(rewards_service.FulfillmentDecisionError):
        rewards_service.decide_fulfillment("f-1", decision="shipped", reviewed_by="staff_a")


def test_decide_fulfillment_approves_and_only_touches_status_columns():
    conn = MagicMock()
    conn.execute.return_value = _Result([SimpleNamespace(id="f-1")])

    with patch.object(rewards_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = rewards_service.decide_fulfillment(
            "f-1", decision="approved", reviewed_by="staff_a"
        )

    assert result.status == "approved"
    assert result.reviewed_by == "staff_a"
    sql = str(conn.execute.call_args.args[0])
    assert "UPDATE one_referral_fulfillment_records" in sql
    assert "status = :decision" in sql
    # No shipment, tracking, or purchase field is ever written by this call.
    assert "tracking_reference" not in sql
    assert "shipped_at" not in sql


def test_decide_fulfillment_raises_when_already_decided_or_missing():
    conn = MagicMock()
    conn.execute.return_value = _Result([])  # WHERE status = 'pending_review' matched nothing

    with patch.object(rewards_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(rewards_service.FulfillmentDecisionError):
            rewards_service.decide_fulfillment("f-1", decision="approved", reviewed_by="staff_a")


def test_list_pending_fulfillment_reads_only_pending_rows():
    row = SimpleNamespace(
        id="f-1",
        entitlement_id="e-1",
        user_id=USER,
        milestone_key="tee_5",
        reward="hushh_tee",
        created_at="2026-11-01T00:00:00Z",
    )
    conn = MagicMock()
    conn.execute.return_value = _Result([row])

    with patch.object(rewards_service, "get_db_connection", side_effect=lambda: _db(conn)):
        pending = rewards_service.list_pending_fulfillment()

    assert pending == [
        {
            "fulfillment_id": "f-1",
            "entitlement_id": "e-1",
            "user_id": USER,
            "milestone_key": "tee_5",
            "reward": "hushh_tee",
            "created_at": "2026-11-01T00:00:00Z",
        }
    ]
    sql = str(conn.execute.call_args.args[0])
    assert "WHERE f.status = 'pending_review'" in sql
