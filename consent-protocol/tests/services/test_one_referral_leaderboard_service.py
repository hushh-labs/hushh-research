"""Leaderboard reads composed from the latest published snapshot (PR4).

Pins the two contracts that matter most here:

  * a referrer with no chosen handle renders as the anonymous placeholder,
    never under any other name -- this is the direct fix for the privacy gap
    the PR1 audit flagged before any leaderboard existed;
  * the viewer's own row is included even when it falls outside the
    requested page, and is never duplicated when it IS on the page.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hushh_mcp.services import one_referral_leaderboard_service as leaderboard_service

SNAPSHOT_ID = "33333333-3333-3333-3333-333333333333"
GENERATED_AT = datetime(2026, 11, 9, tzinfo=timezone.utc)


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


def test_get_individual_leaderboard_is_honestly_empty_with_no_snapshot_yet():
    conn = MagicMock()
    conn.execute.return_value = _Result([])  # no snapshot header exists

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = leaderboard_service.get_individual_leaderboard(viewer_user_id="user_viewer")

    assert result["stale"] is True
    assert result["entries"] == []
    assert result["viewer"] is None
    assert result["snapshot_generated_at"] is None


def test_a_referrer_with_no_handle_renders_as_the_anonymous_placeholder(monkeypatch):
    page_rows = [SimpleNamespace(user_id="user_no_handle", cumulative_points=300, rank=1)]
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_leaderboard_snapshots" in sql:
            return _Result([SimpleNamespace(snapshot_id=SNAPSHOT_ID, generated_at=GENERATED_AT)])
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "rank >" in sql:
            return _Result(page_rows)
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "user_id = :uid" in sql:
            return _Result([])  # viewer has no row in this snapshot yet
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute
    monkeypatch.setattr(leaderboard_service, "get_display_handles", lambda ids: {})

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = leaderboard_service.get_individual_leaderboard(viewer_user_id="someone_else")

    assert result["entries"][0]["handle"] == leaderboard_service.ANONYMOUS_PLACEHOLDER
    assert "user_no_handle" not in str(result)


def test_a_referrer_with_a_handle_renders_their_chosen_handle_never_a_real_name(monkeypatch):
    page_rows = [SimpleNamespace(user_id="user_with_handle", cumulative_points=500, rank=1)]
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_leaderboard_snapshots" in sql:
            return _Result([SimpleNamespace(snapshot_id=SNAPSHOT_ID, generated_at=GENERATED_AT)])
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "rank >" in sql:
            return _Result(page_rows)
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "user_id = :uid" in sql:
            return _Result([])  # viewer has no row in this snapshot yet
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute
    monkeypatch.setattr(
        leaderboard_service, "get_display_handles", lambda ids: {"user_with_handle": "top-dog"}
    )

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = leaderboard_service.get_individual_leaderboard(viewer_user_id="someone_else")

    assert result["entries"][0]["handle"] == "top-dog"


def test_viewer_row_included_when_outside_the_page(monkeypatch):
    page_rows = [SimpleNamespace(user_id="user_rank_1", cumulative_points=1000, rank=1)]
    viewer_row = SimpleNamespace(user_id="user_viewer", cumulative_points=20, rank=47)
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_leaderboard_snapshots" in sql:
            return _Result([SimpleNamespace(snapshot_id=SNAPSHOT_ID, generated_at=GENERATED_AT)])
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "rank >" in sql:
            return _Result(page_rows)
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "user_id = :uid" in sql:
            return _Result([viewer_row])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute
    monkeypatch.setattr(leaderboard_service, "get_display_handles", lambda ids: {})

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = leaderboard_service.get_individual_leaderboard(viewer_user_id="user_viewer")

    assert result["viewer"]["rank"] == 47
    assert result["viewer"]["is_viewer"] is True
    assert len(result["entries"]) == 1  # the page itself is untouched


def test_viewer_row_not_duplicated_when_already_on_the_page(monkeypatch):
    page_rows = [SimpleNamespace(user_id="user_viewer", cumulative_points=900, rank=2)]
    conn = MagicMock()
    viewer_lookup_calls = []

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_leaderboard_snapshots" in sql:
            return _Result([SimpleNamespace(snapshot_id=SNAPSHOT_ID, generated_at=GENERATED_AT)])
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "rank >" in sql:
            return _Result(page_rows)
        if "FROM one_referral_leaderboard_snapshot_entries" in sql and "user_id = :uid" in sql:
            viewer_lookup_calls.append(params)
            raise AssertionError(
                "should not look up the viewer separately when already on the page"
            )
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute
    monkeypatch.setattr(leaderboard_service, "get_display_handles", lambda ids: {})

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = leaderboard_service.get_individual_leaderboard(viewer_user_id="user_viewer")

    assert result["viewer"] is None
    assert result["entries"][0]["is_viewer"] is True
    assert viewer_lookup_calls == []


def test_get_milestone_progress_reports_earned_and_the_nearest_next_milestone(monkeypatch):
    earned_row = SimpleNamespace(
        milestone_key="tee_5",
        reward="hushh_tee",
        earned_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
    )
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_relationships" in sql:
            return _Result([SimpleNamespace(total=7)])
        if "FROM one_referral_milestone_entitlements" in sql:
            return _Result([earned_row])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        progress = leaderboard_service.get_milestone_progress(
            "user_a",
            settings_milestones=[
                {"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"},
                {"milestone_key": "backpack_15", "threshold": 15, "reward": "hushh_backpack"},
            ],
        )

    assert progress["lifetime_qualified_count"] == 7
    assert progress["earned"] == [
        {"milestone_key": "tee_5", "reward": "hushh_tee", "earned_at": "2026-10-01T00:00:00+00:00"}
    ]
    assert progress["next_milestone"] == {
        "milestone_key": "backpack_15",
        "threshold": 15,
        "reward": "hushh_backpack",
        "progress": 7,
    }


def test_get_engagement_status_reports_live_streak_and_no_active_flash(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value = _Result(
        [
            SimpleNamespace(qualifying_date=date(2026, 11, 8)),
            SimpleNamespace(qualifying_date=date(2026, 11, 9)),
        ]
    )

    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 9, 12, 0, tzinfo=tz or timezone.utc)

    monkeypatch.setattr(leaderboard_service, "datetime", _FrozenDateTime)

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        status = leaderboard_service.get_engagement_status(
            "user_a", flash_windows=[], program_timezone="UTC"
        )

    assert status["streak"]["current_run_days"] == 2
    assert status["flash"]["active"] is False
    assert status["flash"]["ends_at"] is None


def test_get_engagement_status_reports_an_active_flash_window(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 8, 15, 0, tzinfo=tz or timezone.utc)

    monkeypatch.setattr(leaderboard_service, "datetime", _FrozenDateTime)
    windows = [
        {
            "start": datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc).isoformat(),
            "end": datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc).isoformat(),
        }
    ]

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        status = leaderboard_service.get_engagement_status(
            "user_a", flash_windows=windows, program_timezone="UTC"
        )

    assert status["flash"]["active"] is True
    assert status["flash"]["ends_at"] == "2026-11-08T18:00:00+00:00"


def test_get_milestone_progress_has_no_next_milestone_once_everything_is_earned():
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "FROM one_referral_relationships" in sql:
            return _Result([SimpleNamespace(total=20)])
        if "FROM one_referral_milestone_entitlements" in sql:
            return _Result(
                [
                    SimpleNamespace(
                        milestone_key="tee_5", reward="hushh_tee", earned_at=GENERATED_AT
                    ),
                    SimpleNamespace(
                        milestone_key="backpack_15", reward="hushh_backpack", earned_at=GENERATED_AT
                    ),
                ]
            )
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(leaderboard_service, "get_db_connection", side_effect=lambda: _db(conn)):
        progress = leaderboard_service.get_milestone_progress(
            "user_a",
            settings_milestones=[
                {"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"},
                {"milestone_key": "backpack_15", "threshold": 15, "reward": "hushh_backpack"},
            ],
        )

    assert progress["next_milestone"] is None
