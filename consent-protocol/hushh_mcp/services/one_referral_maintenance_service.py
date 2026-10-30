"""Bounded recovery of verified usage, ended rounds and published standings."""

import time
from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.one_referral_activity_service import reconcile_product_activity
from hushh_mcp.services.one_referral_challenge_service import get_challenge_status
from hushh_mcp.services.one_referral_program_settings_service import get_active_program_settings
from hushh_mcp.services.one_referral_scoring_service import publish_leaderboard_snapshot
from hushh_mcp.services.one_referral_weekly_award_service import finalize_reward_round


def reconcile_pending_activity(limit=20, deadline=None):
    with get_db_connection() as connection:
        connection.execute(text("SET LOCAL statement_timeout='10s'"))
        connection.execute(
            text("""
          WITH overdue AS (
            SELECT r.id FROM one_referral_relationships r
             JOIN one_referral_policies p ON p.version=r.policy_version
            WHERE r.status IN ('signed_up','phone_verified','onboarded','engaging')
              AND r.created_at+p.qualification_window_days*INTERVAL '1 day'<=NOW()
              AND NOT EXISTS (SELECT 1 FROM one_referral_events e JOIN vault_keys v ON v.user_id=e.user_id
                JOIN actor_identity_cache i ON i.user_id=e.user_id
               WHERE e.user_id=r.referred_user_id AND e.event_type='product_usage'
                 AND i.phone_verified AND v.setup_completed
                 AND e.server_timestamp>=GREATEST(r.created_at,to_timestamp(v.setup_completed_at/1000.0))
                 AND e.server_timestamp<r.created_at+p.qualification_window_days*INTERVAL '1 day')
            ORDER BY r.created_at LIMIT :limit FOR UPDATE OF r SKIP LOCKED
          ) UPDATE one_referral_relationships SET status='expired',expired_at=NOW()
             WHERE id IN(SELECT id FROM overdue)
        """),
            {"limit": limit},
        )
        rows = connection.execute(
            text("""
          SELECT DISTINCT e.user_id FROM one_referral_events e
           LEFT JOIN one_referral_relationships r ON r.referred_user_id=e.user_id
          WHERE e.event_type='product_usage' AND (
            e.scored_at IS NULL
            OR (r.status IN ('signed_up','phone_verified','onboarded','engaging')
                AND EXISTS (SELECT 1 FROM actor_identity_cache i JOIN vault_keys v ON v.user_id=i.user_id
                   WHERE i.user_id=e.user_id AND i.phone_verified AND v.setup_completed
                     AND e.server_timestamp>=to_timestamp(v.setup_completed_at/1000.0))
                AND e.server_timestamp>=r.created_at
                AND e.server_timestamp<r.created_at+(SELECT qualification_window_days*INTERVAL '1 day'
                   FROM one_referral_policies WHERE version=r.policy_version)))
          ORDER BY e.user_id LIMIT :limit
        """),
            {"limit": limit},
        ).fetchall()
    for row in rows:
        if deadline is not None and time.monotonic() >= deadline:
            break
        reconcile_product_activity(row.user_id)
    return len(rows)


def publish_dashboard_state():
    snapshot = publish_leaderboard_snapshot()
    get_challenge_status()
    settings = get_active_program_settings()
    if settings.feature_active:
        with get_db_connection() as connection:
            due = connection.execute(
                text("""
              SELECT cutoff_at,timezone FROM one_referral_reward_rounds
               WHERE cutoff_at<=:now AND status IN ('scheduled','ended','reconciling')
                 AND NOT EXISTS(SELECT 1 FROM one_referral_scoring_jobs j
                  JOIN one_referral_relationships r ON r.id=j.relationship_id
                  WHERE r.qualified_at<one_referral_reward_rounds.cutoff_at AND j.status<>'completed')
               ORDER BY cutoff_at LIMIT 3
            """),
                {"now": datetime.now(timezone.utc)},
            ).fetchall()
        for row in due:
            finalize_reward_round(row.cutoff_at, row.timezone)
    return snapshot.entry_count
