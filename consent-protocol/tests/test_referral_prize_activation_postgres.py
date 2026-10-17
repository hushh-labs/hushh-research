"""Prize activation preserves immutable settings and all governed replay paths."""

# ruff: noqa: F811 -- imported shared PostgreSQL fixture

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text

from db.migration_authority import _replay_sql, build_manifest_entries
from db.referral_prize_activation import activate_weekly_prizes_sql
from hushh_mcp.services import one_referral_program_settings_service as settings
from hushh_mcp.services import one_referral_weekly_award_service as weekly
from tests.test_one_referral_lifecycle_postgres import db  # noqa: F401

pytestmark = pytest.mark.db
MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"


def test_activation_is_additive_idempotent_and_replayable(db):
    with db.begin() as connection:
        before = connection.execute(
            text("SELECT to_jsonb(s) FROM one_referral_program_settings s WHERE version=5")
        ).scalar()
        connection.execute(text(activate_weekly_prizes_sql()))
        connection.execute(text(activate_weekly_prizes_sql()))
        rows = connection.execute(
            text(
                "SELECT version,feature_active,activated_at,retired_at FROM one_referral_program_settings WHERE version IN (5,6) ORDER BY version"
            )
        ).fetchall()
        assert len(rows) == 2 and rows[0].feature_active is False and rows[1].feature_active is True
        assert rows[0].retired_at == rows[1].activated_at
        milestone = connection.execute(
            text(
                "SELECT item->>'reward' FROM one_referral_program_settings, jsonb_array_elements(milestones) item WHERE version=6 AND item->>'milestone_key'='airpods_500'"
            )
        ).scalar()
        assert milestone == "Apple Watch"
        after = connection.execute(
            text("SELECT to_jsonb(s) FROM one_referral_program_settings s WHERE version=5")
        ).scalar()
        assert {k: v for k, v in before.items() if k != "retired_at"} == {
            k: v for k, v in after.items() if k != "retired_at"
        }

    for number in (289, 338, 347, 349):
        filename = next(MIGRATIONS.glob(f"{number}_*.sql")).name
        entry = build_manifest_entries(MIGRATIONS, (filename,))[0]
        with db.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            connection.connection.cursor().execute(_replay_sql(entry))
    with db.connect() as connection:
        assert (
            connection.execute(
                text("SELECT version FROM one_referral_program_settings WHERE retired_at IS NULL")
            ).scalar()
            == 6
        )


def test_activation_refuses_unresolved_past_rounds_without_changing_settings(db):
    with db.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO one_referral_reward_rounds(settings_version,cutoff_at,timezone,status) VALUES(5,NOW()-INTERVAL '1 day','Asia/Kolkata','ended')"
            )
        )
    with pytest.raises(Exception, match="historical inactive rounds"):
        with db.begin() as connection:
            connection.execute(text(activate_weekly_prizes_sql()))
    with db.connect() as connection:
        assert (
            connection.execute(
                text("SELECT version FROM one_referral_program_settings WHERE retired_at IS NULL")
            ).scalar()
            == 5
        )


def test_replay_rejects_a_changed_activation_successor(db):
    with db.begin() as connection:
        connection.execute(text(activate_weekly_prizes_sql()))
        connection.execute(
            text("UPDATE one_referral_program_settings SET points='{}'::JSONB WHERE version=6")
        )
    filename = "349_one_referral_dashboard_truth.sql"
    entry = build_manifest_entries(MIGRATIONS, (filename,))[0]
    with pytest.raises(Exception, match="conflicting or inactive settings 5"):
        with db.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            try:
                connection.connection.cursor().execute(_replay_sql(entry))
            finally:
                connection.connection.cursor().execute("ROLLBACK")


def test_activation_uses_fresh_time_after_a_transaction_wait(db):
    with pytest.raises(Exception, match="historical inactive rounds"):
        with db.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO one_referral_reward_rounds(settings_version,cutoff_at,timezone,status) VALUES(5,NOW()+INTERVAL '1 second','Asia/Kolkata','scheduled')"
                )
            )
            connection.execute(text("SELECT pg_sleep(1.05)"))
            connection.execute(text(activate_weekly_prizes_sql()))
    with db.connect() as connection:
        assert (
            connection.execute(
                text("SELECT version FROM one_referral_program_settings WHERE retired_at IS NULL")
            ).scalar()
            == 5
        )


def test_upcoming_v5_round_survives_activation_and_awards_once(db, monkeypatch):
    cutoff = datetime.now(timezone.utc) + timedelta(days=1)
    before = settings.get_or_create_reward_round(cutoff, "Asia/Kolkata")
    with db.begin() as connection:
        connection.execute(text("INSERT INTO actor_profiles(user_id) VALUES('weekly-winner')"))
        connection.execute(
            text(
                "INSERT INTO one_referral_score_events(user_id,event_type,points,settings_version,idempotency_key) VALUES('weekly-winner','streak_bonus',15,5,'weekly-winner-bonus')"
            )
        )
        connection.execute(text(activate_weekly_prizes_sql()))
    after = settings.get_or_create_reward_round(cutoff, "Asia/Kolkata")
    assert after == before
    assert after["settings_version"] == 5

    @contextmanager
    def database():
        with db.begin() as connection:
            yield connection

    class AfterCutoff(datetime):
        @classmethod
        def now(cls, tz=None):
            return cutoff + timedelta(seconds=1)

    monkeypatch.setattr(weekly, "get_db_connection", database)
    monkeypatch.setattr(weekly, "datetime", AfterCutoff)
    first = weekly.finalize_reward_round(cutoff, "Asia/Kolkata")
    repeated = weekly.finalize_reward_round(cutoff, "Asia/Kolkata")
    assert first.reward_round_id == repeated.reward_round_id == before["id"]
    assert len(first.awards) == len(repeated.awards) == 1
    with db.connect() as connection:
        assert (
            connection.execute(text("SELECT COUNT(*) FROM one_referral_weekly_awards")).scalar()
            == 1
        )
