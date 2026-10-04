"""Coverage for the durable referral-scoring worker (migration 270).

These tests pin the contracts the product spec calls out explicitly:

  * `enqueue_scoring_work` writes the canonical event and the durable job in
    the SAME connection it is given -- the "atomic qualification event" the
    caller (`one_referral_service.sync_referral_qualification_from_onboarding`)
    relies on.
  * `process_one_job` is idempotent (ON CONFLICT DO NOTHING everywhere) and
    recomputes streak state from the referrer's full qualifying-day history
    rather than an incremental counter, so reprocessing never double-credits.
  * `reverse_relationship_scoring` writes an audited compensating entry and
    is itself idempotent.
  * `publish_leaderboard_snapshot` ranks deterministically.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from hushh_mcp.services import one_referral_scoring_service as scoring_service

RELATIONSHIP_ID = "44444444-4444-4444-4444-444444444444"
REFERRER = "user_referrer_scoring"
SETTINGS_VERSION = 1


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
        version=SETTINGS_VERSION,
        qualification_policy_version=1,
        points={"qualified_referral_points": 100, "flash_window_total_points": 200},
        milestones=[],
        streak_rules={"run_length_days": 3, "bonus_points": 15},
        flash_windows=[],
        weekly_schedule={"timezone": "UTC"},
        prize_catalogue=[],
        tie_break_rules={},
        fulfillment_config={},
        feature_active=False,
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def _patch_settings(monkeypatch, settings):
    monkeypatch.setattr(scoring_service, "get_active_program_settings", lambda: settings)


# --- enqueue_scoring_work: the atomic-write contract --------------------------


def test_enqueue_scoring_work_writes_event_and_job_with_the_given_connection():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    scoring_service.enqueue_scoring_work(conn, relationship_id=RELATIONSHIP_ID, user_id=REFERRER)

    assert conn.execute.call_count == 2
    first_sql = str(conn.execute.call_args_list[0].args[0])
    second_sql = str(conn.execute.call_args_list[1].args[0])
    assert "INSERT INTO one_referral_events" in first_sql
    assert "INSERT INTO one_referral_scoring_jobs" in second_sql
    first_params = conn.execute.call_args_list[0].args[1]
    assert first_params["idempotency_key"] == f"referral_qualified:{RELATIONSHIP_ID}"


# --- claim_due_scoring_jobs ---------------------------------------------------


def test_claim_due_scoring_jobs_parses_claimed_rows():
    claimed_row = SimpleNamespace(
        job_id=RELATIONSHIP_ID,
        relationship_id=RELATIONSHIP_ID,
        user_id=REFERRER,
        lease_id="lease-1",
        retry_count=0,
    )
    conn = MagicMock()
    conn.execute.return_value = _Result([claimed_row])

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        claimed = scoring_service.claim_due_scoring_jobs(limit=5)

    assert claimed == [
        {
            "job_id": RELATIONSHIP_ID,
            "relationship_id": RELATIONSHIP_ID,
            "user_id": REFERRER,
            "lease_id": "lease-1",
            "retry_count": 0,
        }
    ]


# --- process_one_job -----------------------------------------------------


class _ProcessJobConnection:
    """Enough SQLAlchemy-shaped behavior to drive one `process_one_job` call.

    Tracks inserted score events and the streak-state row so a test can
    assert on what actually got written, not just that *a* query ran.
    """

    def __init__(
        self,
        *,
        relationship_status="qualified",
        qualified_at=datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc),
        existing_streak_row: date | None = None,
        qualifying_dates: list[date] | None = None,
        raise_on_score_insert: bool = False,
        contributing_circle_id: str | None = None,
        lifetime_qualified_count: int = 1,
        already_earned_milestone_keys: frozenset = frozenset(),
    ):
        self.relationship_status = relationship_status
        self.qualified_at = qualified_at
        self.existing_streak_row = existing_streak_row
        self.streak_row_exists = existing_streak_row is not None
        self.qualifying_dates = (
            qualifying_dates
            if qualifying_dates is not None
            else ([qualified_at.date()] if qualified_at else [])
        )
        self.raise_on_score_insert = raise_on_score_insert
        self.contributing_circle_id = contributing_circle_id
        self.lifetime_qualified_count = lifetime_qualified_count
        self.already_earned_milestone_keys = already_earned_milestone_keys
        self.inserted_score_events: list[dict] = []
        self.streak_updates: list[date] = []
        self.job_updates: list[dict] = []
        self.inserted_circle_contributions: list[dict] = []
        self.issued_milestones: list[dict] = []
        self._next_entitlement_id = 1

    def execute(self, query, params=None):
        sql = str(query)
        params = params or {}
        if "SELECT id, referrer_user_id, status, qualified_at" in sql:
            return _Result(
                [
                    SimpleNamespace(
                        id=RELATIONSHIP_ID,
                        referrer_user_id=REFERRER,
                        status=self.relationship_status,
                        qualified_at=self.qualified_at,
                    )
                ]
            )
        if "INSERT INTO one_referral_score_events" in sql:
            if self.raise_on_score_insert:
                raise RuntimeError("simulated insert failure")
            self.inserted_score_events.append(dict(params))
            return _Result([])
        if "SELECT circle_id" in sql and "one_referral_circle_selections" in sql:
            if self.contributing_circle_id is None:
                return _Result([])
            return _Result([SimpleNamespace(circle_id=self.contributing_circle_id)])
        if "INSERT INTO one_referral_circle_contributions" in sql:
            self.inserted_circle_contributions.append(dict(params))
            return _Result([])
        if "SELECT COUNT(*) AS total" in sql and "one_referral_relationships" in sql:
            return _Result([SimpleNamespace(total=self.lifetime_qualified_count)])
        if "SELECT milestone_key" in sql and "one_referral_milestone_entitlements" in sql:
            return _Result(
                [SimpleNamespace(milestone_key=key) for key in self.already_earned_milestone_keys]
            )
        if "INSERT INTO one_referral_milestone_entitlements" in sql:
            entitlement_id = self._next_entitlement_id
            self._next_entitlement_id += 1
            self.issued_milestones.append(dict(params))
            return _Result([SimpleNamespace(id=entitlement_id)])
        if "INSERT INTO one_referral_fulfillment_records" in sql:
            return _Result([])
        if "SELECT last_awarded_through_date" in sql:
            if not self.streak_row_exists:
                return _Result([])
            return _Result([SimpleNamespace(last_awarded_through_date=self.existing_streak_row)])
        if "DISTINCT (qualified_at AT TIME ZONE" in sql:
            return _Result([SimpleNamespace(qualifying_date=d) for d in self.qualifying_dates])
        if (
            "INSERT INTO one_referral_streak_state" in sql
            or "UPDATE one_referral_streak_state" in sql
        ):
            self.streak_updates.append(params.get("through"))
            self.streak_row_exists = True
            return _Result([])
        if "UPDATE one_referral_scoring_jobs" in sql:
            self.job_updates.append(dict(params))
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")


def _job():
    return {
        "job_id": "job-1",
        "relationship_id": RELATIONSHIP_ID,
        "user_id": REFERRER,
        "retry_count": 0,
    }


def test_process_one_job_awards_base_points_for_a_single_qualification(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    conn = _ProcessJobConnection(qualifying_dates=[date(2026, 11, 3)])

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["status"] == "completed"
    assert result["event_type"] == "base_qualification"
    assert len(conn.inserted_score_events) == 1
    assert conn.inserted_score_events[0]["points"] == 100
    assert conn.inserted_score_events[0]["idempotency_key"] == f"score:{RELATIONSHIP_ID}"
    assert conn.job_updates[-1]["jid"] == "job-1"


def test_process_one_job_awards_flash_points_inside_a_configured_window(monkeypatch):
    qualified_at = datetime(2026, 11, 8, 15, 0, tzinfo=timezone.utc)
    settings = _settings_row(
        flash_windows=[
            {
                "start": datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc).isoformat(),
                "end": datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc).isoformat(),
            }
        ]
    )
    _patch_settings(monkeypatch, settings)
    conn = _ProcessJobConnection(qualified_at=qualified_at, qualifying_dates=[qualified_at.date()])

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["event_type"] == "flash_qualification"
    assert conn.inserted_score_events[0]["points"] == 200


def test_process_one_job_awards_a_streak_bonus_on_the_third_qualifying_day(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    conn = _ProcessJobConnection(
        qualifying_dates=[date(2026, 11, 1), date(2026, 11, 2), date(2026, 11, 3)],
    )

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["streak_awards"] == 1
    streak_events = [e for e in conn.inserted_score_events if e.get("event_type") == "streak_bonus"]
    assert len(streak_events) == 1
    assert streak_events[0]["points"] == 15
    assert streak_events[0]["idempotency_key"] == f"streak:{REFERRER}:2026-11-03"
    assert conn.streak_updates[-1] == date(2026, 11, 3)


def test_process_one_job_does_not_reaward_a_streak_already_paid(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    conn = _ProcessJobConnection(
        qualifying_dates=[date(2026, 11, 1), date(2026, 11, 2), date(2026, 11, 3)],
        existing_streak_row=date(2026, 11, 3),
    )

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["streak_awards"] == 0
    assert all(e.get("event_type") != "streak_bonus" for e in conn.inserted_score_events)


def test_process_one_job_records_a_circle_contribution_when_a_team_is_selected(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    circle_id = "circle-123"
    conn = _ProcessJobConnection(
        qualifying_dates=[date(2026, 11, 3)], contributing_circle_id=circle_id
    )

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["contributed_circle_id"] == circle_id
    assert len(conn.inserted_circle_contributions) == 1
    assert conn.inserted_circle_contributions[0]["cid"] == circle_id
    assert conn.inserted_circle_contributions[0]["rid"] == RELATIONSHIP_ID


def test_process_one_job_records_no_contribution_when_no_team_is_selected(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    conn = _ProcessJobConnection(qualifying_dates=[date(2026, 11, 3)], contributing_circle_id=None)

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["contributed_circle_id"] is None
    assert conn.inserted_circle_contributions == []


def test_process_one_job_issues_a_milestone_on_crossing_its_threshold(monkeypatch):
    settings = _settings_row(
        milestones=[{"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"}]
    )
    _patch_settings(monkeypatch, settings)
    conn = _ProcessJobConnection(qualifying_dates=[date(2026, 11, 3)], lifetime_qualified_count=5)

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["milestones_issued"] == ["tee_5"]
    assert len(conn.issued_milestones) == 1
    assert conn.issued_milestones[0]["key"] == "tee_5"


def test_process_one_job_does_not_reissue_an_already_earned_milestone(monkeypatch):
    settings = _settings_row(
        milestones=[{"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"}]
    )
    _patch_settings(monkeypatch, settings)
    conn = _ProcessJobConnection(
        qualifying_dates=[date(2026, 11, 3)],
        lifetime_qualified_count=6,
        already_earned_milestone_keys=frozenset({"tee_5"}),
    )

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result["milestones_issued"] == []
    assert conn.issued_milestones == []


def test_process_one_job_skips_a_relationship_no_longer_qualified(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    conn = _ProcessJobConnection(relationship_status="revoked")

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.process_one_job(_job())

    assert result == {"status": "skipped", "reason": "relationship_not_qualified"}
    assert conn.inserted_score_events == []
    assert conn.job_updates[-1]["jid"] == "job-1"


def test_process_one_job_requeues_with_backoff_on_failure(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    work_conn = _ProcessJobConnection(raise_on_score_insert=True)
    failure_conn = MagicMock()
    failure_conn.execute.return_value = _Result([])
    connections = iter([work_conn, failure_conn])

    with patch.object(
        scoring_service, "get_db_connection", side_effect=lambda: _db(next(connections))
    ):
        result = scoring_service.process_one_job(_job())

    assert result == {"status": "failed"}
    failure_sql = str(failure_conn.execute.call_args.args[0])
    assert "UPDATE one_referral_scoring_jobs" in failure_sql
    failure_params = failure_conn.execute.call_args.args[1]
    assert failure_params["next_retry"] == 1


# --- reverse_relationship_scoring --------------------------------------------


def test_reverse_relationship_scoring_inserts_a_negative_compensating_entry():
    original = SimpleNamespace(id=42, points=100)
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "SELECT e.id, e.points" in sql:
            return _Result([original])
        if "INSERT INTO one_referral_score_events" in sql:
            execute.insert_params = params
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.reverse_relationship_scoring(
            RELATIONSHIP_ID, reason="fraud_review"
        )

    assert result["reversed_events"] == [{"event_id": 42, "points_reversed": -100}]
    assert execute.insert_params["reversal_points"] == -100
    assert execute.insert_params["idempotency_key"] == "reversal:42"


def test_reverse_relationship_scoring_is_a_no_op_when_nothing_is_left_to_reverse():
    conn = MagicMock()
    conn.execute.return_value = _Result([])

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.reverse_relationship_scoring(
            RELATIONSHIP_ID, reason="fraud_review"
        )

    assert result["reversed_events"] == []


# --- get_cumulative_score / publish_leaderboard_snapshot ---------------------


def test_get_cumulative_score_sums_the_ledger():
    conn = MagicMock()
    conn.execute.return_value = _Result([SimpleNamespace(total=315)])

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        total = scoring_service.get_cumulative_score(REFERRER)

    assert total == 315


def test_publish_leaderboard_snapshot_ranks_by_points_then_earliest_event(monkeypatch):
    _patch_settings(monkeypatch, _settings_row())
    ranked_rows = [
        SimpleNamespace(
            user_id="user_b", total=300, earliest=datetime(2026, 11, 1, tzinfo=timezone.utc)
        ),
        SimpleNamespace(
            user_id="user_a", total=200, earliest=datetime(2026, 11, 2, tzinfo=timezone.utc)
        ),
    ]
    snapshot_header = SimpleNamespace(
        snapshot_id="snap-1", generated_at=datetime(2026, 11, 9, tzinfo=timezone.utc)
    )
    entries_inserted: list[dict] = []
    conn = MagicMock()

    def execute(query, params=None):
        sql = str(query)
        if "GROUP BY user_id" in sql:
            return _Result(ranked_rows)
        if "INSERT INTO one_referral_leaderboard_snapshots" in sql:
            return _Result([snapshot_header])
        if "INSERT INTO one_referral_leaderboard_snapshot_entries" in sql:
            entries_inserted.append(params)
            return _Result([])
        raise AssertionError(f"unexpected query: {sql}")

    conn.execute.side_effect = execute

    with patch.object(scoring_service, "get_db_connection", side_effect=lambda: _db(conn)):
        result = scoring_service.publish_leaderboard_snapshot(limit=10)

    assert result.snapshot_id == "snap-1"
    assert result.entry_count == 2
    assert entries_inserted[0]["uid"] == "user_b"
    assert entries_inserted[0]["rank"] == 1
    assert entries_inserted[1]["uid"] == "user_a"
    assert entries_inserted[1]["rank"] == 2
