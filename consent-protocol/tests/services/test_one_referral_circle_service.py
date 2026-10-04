"""Referral-contest team selection and event-time resolution (migration 271).

Pins the contracts the product spec calls out:

  * selection requires accepted Location Circle membership and never writes
    to one_location_circles / one_location_circle_memberships;
  * exactly one active selection per user, enforced by closing the previous
    interval before opening a new one;
  * `resolve_contributing_circle` answers "which team as of timestamp T",
    not "which team right now" -- the event-time lookup delayed processing
    depends on.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services import one_referral_circle_service as circle_service

USER = "user_circle_member"
CIRCLE_A = "11111111-aaaa-aaaa-aaaa-111111111111"
CIRCLE_B = "22222222-bbbb-bbbb-bbbb-222222222222"


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


def test_select_competition_circle_rejects_a_non_member():
    conn = MagicMock()
    conn.execute.return_value = _Result([])  # membership check: no row

    with patch.object(circle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        with pytest.raises(circle_service.CircleSelectionError):
            circle_service.select_competition_circle(USER, CIRCLE_A)


def test_select_competition_circle_opens_the_first_selection_for_a_member():
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "one_location_circle_memberships" in sql:
            return _Result([SimpleNamespace(x=1)])
        if "SELECT id, circle_id, selected_at" in sql and "FOR UPDATE" in sql:
            return _Result([])  # no current open selection
        if "INSERT INTO one_referral_circle_selections" in sql:
            return _Result([SimpleNamespace(id="sel-1", circle_id=CIRCLE_A, selected_at=now)])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(circle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        selection = circle_service.select_competition_circle(USER, CIRCLE_A)

    assert selection.circle_id == CIRCLE_A


def test_reselecting_the_same_circle_is_a_no_op():
    current = SimpleNamespace(
        id="sel-1", circle_id=CIRCLE_A, selected_at=datetime(2026, 11, 1, tzinfo=timezone.utc)
    )
    conn = MagicMock()
    update_calls = []

    def execute(query, params=None):
        sql = str(query)
        if "one_location_circle_memberships" in sql:
            return _Result([SimpleNamespace(x=1)])
        if "SELECT id, circle_id, selected_at" in sql and "FOR UPDATE" in sql:
            return _Result([current])
        if "UPDATE one_referral_circle_selections" in sql:
            update_calls.append(params)
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(circle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        selection = circle_service.select_competition_circle(USER, CIRCLE_A)

    assert selection.circle_id == CIRCLE_A
    assert update_calls == []  # no interval churn for re-selecting the same team


def test_switching_teams_closes_the_old_interval_and_opens_a_new_one():
    old = SimpleNamespace(
        id="sel-1", circle_id=CIRCLE_A, selected_at=datetime(2026, 11, 1, tzinfo=timezone.utc)
    )
    new_selected_at = datetime(2026, 11, 5, tzinfo=timezone.utc)
    conn = MagicMock()
    closed = []

    def execute(query, params=None):
        sql = str(query)
        if "one_location_circle_memberships" in sql:
            return _Result([SimpleNamespace(x=1)])
        if "SELECT id, circle_id, selected_at" in sql and "FOR UPDATE" in sql:
            return _Result([old])
        if "UPDATE one_referral_circle_selections" in sql:
            closed.append(params["sid"])
            return _Result([])
        if "INSERT INTO one_referral_circle_selections" in sql:
            return _Result(
                [SimpleNamespace(id="sel-2", circle_id=CIRCLE_B, selected_at=new_selected_at)]
            )
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(circle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        selection = circle_service.select_competition_circle(USER, CIRCLE_B)

    assert closed == ["sel-1"]
    assert selection.circle_id == CIRCLE_B


def test_resolve_contributing_circle_returns_none_with_no_covering_interval():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    result = circle_service.resolve_contributing_circle(
        conn, user_id=USER, as_of=datetime(2026, 11, 1, tzinfo=timezone.utc)
    )

    assert result is None


def test_resolve_contributing_circle_returns_the_covering_team():
    conn = MagicMock()
    conn.execute.return_value = _Result([SimpleNamespace(circle_id=CIRCLE_A)])

    result = circle_service.resolve_contributing_circle(
        conn, user_id=USER, as_of=datetime(2026, 11, 1, tzinfo=timezone.utc)
    )

    assert result == CIRCLE_A


def test_record_circle_contribution_is_idempotent_via_on_conflict():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    circle_service.record_circle_contribution(
        conn,
        relationship_id="rel-1",
        user_id=USER,
        circle_id=CIRCLE_A,
        contributed_at=datetime(2026, 11, 1, tzinfo=timezone.utc),
    )

    sql = str(conn.execute.call_args.args[0])
    assert "ON CONFLICT (relationship_id) DO NOTHING" in sql


def test_get_team_rankings_orders_by_contribution_count():
    rows = [
        SimpleNamespace(circle_id=CIRCLE_A, circle_name="Team A", contribution_count=42),
        SimpleNamespace(circle_id=CIRCLE_B, circle_name="Team B", contribution_count=10),
    ]
    conn = MagicMock()
    conn.execute.return_value = _Result(rows)

    with patch.object(circle_service, "get_db_connection", side_effect=lambda: _db(conn)):
        rankings = circle_service.get_team_rankings(limit=10)

    assert rankings == [
        {"circle_id": CIRCLE_A, "circle_name": "Team A", "contribution_count": 42},
        {"circle_id": CIRCLE_B, "circle_name": "Team B", "contribution_count": 10},
    ]
