"""Authenticated calendar activity and verified product-event awards.

Writes use the existing append-only ledger. No public API accepts an award amount.
"""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.one_referral_program_settings_service import get_active_program_settings

DASHBOARD_TIMEZONE = "Asia/Kolkata"


def record_score(
    connection,
    *,
    user_id,
    event_type,
    points,
    coins,
    version,
    key,
    relationship_id=None,
    occurred_at=None,
):
    if points <= 0:
        return
    connection.execute(
        text("""
        INSERT INTO one_referral_score_events
          (user_id,relationship_id,event_type,points,coins,settings_version,idempotency_key,created_at)
        VALUES (:uid,CAST(:rid AS UUID),:event,:points,:coins,:version,:key,:at)
        ON CONFLICT (idempotency_key) DO NOTHING
    """),
        {
            "uid": user_id,
            "rid": relationship_id,
            "event": event_type,
            "points": points,
            "coins": coins,
            "version": version,
            "key": key,
            "at": occurred_at or datetime.now(timezone.utc),
        },
    )


def record_referral_activity(connection, *, user_id, relationship_id, qualified=False):
    settings = get_active_program_settings()
    initial = int(settings.points.get("referral_in_progress_points", 0))
    total = int(settings.points.get("referral_qualified_activity_total_points", initial))
    record_score(
        connection,
        user_id=user_id,
        relationship_id=relationship_id,
        event_type="in_progress_activity",
        points=initial,
        coins=0,
        version=settings.version,
        key=f"referral_joined:{relationship_id}",
    )
    if qualified:
        record_score(
            connection,
            user_id=user_id,
            relationship_id=relationship_id,
            event_type="qualified_activity",
            points=max(0, total - initial),
            coins=0,
            version=settings.version,
            key=f"referral_activity_upgrade:{relationship_id}",
        )


def next_daily_streak(
    last_day: date | None, current: int, longest: int, today: date
) -> tuple[int, int]:
    if last_day is not None and today <= last_day:
        return current, longest
    current = current + 1 if last_day == today - timedelta(days=1) else 1
    return current, max(current, longest)


def get_daily_streak(user_id: str, program_timezone: str) -> dict:
    today = datetime.now(timezone.utc).astimezone(ZoneInfo(DASHBOARD_TIMEZONE)).date()
    with get_db_connection() as connection:
        row = connection.execute(
            text("""
            SELECT dashboard_last_activity_date AS last_activity_date,
                   dashboard_current_streak AS current_streak,
                   dashboard_longest_streak AS longest_streak
              FROM one_referral_streak_state WHERE user_id=:uid
        """),
            {"uid": user_id},
        ).fetchone()
    current = (
        row.current_streak
        if row and row.last_activity_date and today - row.last_activity_date <= timedelta(days=1)
        else 0
    )
    return {
        "current_run_days": current,
        "longest_run_days": row.longest_streak if row else 0,
        "last_activity_date": row.last_activity_date.isoformat()
        if row and row.last_activity_date
        else None,
    }


def record_app_open(user_id: str, *, dashboard_visit: bool = True) -> dict:
    settings = get_active_program_settings()
    tz = DASHBOARD_TIMEZONE
    if not dashboard_visit:
        # Old clients called this globally. Preserve their response shape, but
        # never reinterpret their app-open signal as a dashboard visit.
        now = datetime.now(timezone.utc)
        today = now.astimezone(ZoneInfo(tz)).date()
        return {
            **get_daily_streak(user_id, tz),
            "recorded": False,
            "status": "dashboard_visit_required",
            "server_now": now.isoformat(),
            "next_day_at": datetime.combine(
                today + timedelta(days=1), datetime.min.time(), tzinfo=ZoneInfo(tz)
            ).isoformat(),
            "activity_date": today.isoformat(),
            "timezone": tz,
        }
    with get_db_connection() as connection:
        connection.execute(
            text("""
            INSERT INTO one_referral_streak_state(user_id) VALUES(:uid) ON CONFLICT DO NOTHING
        """),
            {"uid": user_id},
        )
        row = connection.execute(
            text("""
            SELECT dashboard_last_activity_date AS last_activity_date,
                   dashboard_current_streak AS current_streak,
                   dashboard_longest_streak AS longest_streak
            FROM one_referral_streak_state WHERE user_id=:uid FOR UPDATE
        """),
            {"uid": user_id},
        ).fetchone()
        # Read the server date after acquiring the owner lock, including when
        # another device held it across midnight.
        now = datetime.now(timezone.utc)
        today = now.astimezone(ZoneInfo(tz)).date()
        current, longest = next_daily_streak(
            row.last_activity_date, row.current_streak, row.longest_streak, today
        )
        inserted = connection.execute(
            text("""
            INSERT INTO one_referral_activity_days(user_id,activity_date,timezone,dashboard_visited_at)
            VALUES(:uid,:day,:tz,:now) ON CONFLICT (user_id,activity_date)
            DO UPDATE SET dashboard_visited_at=EXCLUDED.dashboard_visited_at
             WHERE one_referral_activity_days.dashboard_visited_at IS NULL
            RETURNING activity_date
        """),
            {"uid": user_id, "day": today, "tz": tz, "now": now},
        ).fetchone()
        if inserted and (row.last_activity_date is None or today > row.last_activity_date):
            connection.execute(
                text("""
                UPDATE one_referral_streak_state SET dashboard_last_activity_date=:day,
                dashboard_current_streak=:current,dashboard_longest_streak=:longest,
                updated_at=:now WHERE user_id=:uid
            """),
                {"day": today, "current": current, "longest": longest, "now": now, "uid": user_id},
            )
            run = int(settings.streak_rules.get("run_length_days", 3))
            bonus = int(settings.streak_rules.get("bonus_points", 0))
            if run > 0 and current % run == 0:
                record_score(
                    connection,
                    user_id=user_id,
                    event_type="app_streak_bonus",
                    points=bonus,
                    coins=bonus,
                    version=settings.version,
                    key=f"app_streak:{user_id}:{today}",
                    occurred_at=now,
                )
    return {
        "server_now": now.isoformat(),
        "next_day_at": datetime.combine(
            today + timedelta(days=1), datetime.min.time(), tzinfo=ZoneInfo(tz)
        ).isoformat(),
        "recorded": bool(inserted),
        "activity_date": today.isoformat(),
        "current_run_days": current,
        "longest_run_days": longest,
        "timezone": tz,
    }


def reconcile_product_activity(user_id: str, message_id: str | None = None) -> dict:
    """Award only events recorded by the completed-reply database trigger.

    A message ID is a filter, never evidence by itself. Events must belong to
    the authenticated owner. Content, model answers and device telemetry are absent.
    """
    settings = get_active_program_settings()
    with get_db_connection() as connection:
        rows = connection.execute(
            text("""
            SELECT e.id,e.idempotency_key,e.server_timestamp
            FROM one_referral_events e WHERE e.user_id=:uid AND e.event_type='product_usage'
              AND (:mid IS NULL OR e.metadata->>'message_id'=:mid)
              AND e.scored_at IS NULL
            ORDER BY e.id LIMIT 100 FOR UPDATE SKIP LOCKED
        """),
            {"uid": user_id, "mid": message_id},
        ).fetchall()
        for row in rows:
            record_score(
                connection,
                user_id=user_id,
                event_type="agent_usage",
                points=int(settings.points.get("agent_usage_points", 0)),
                coins=0,
                version=settings.version,
                key=f"activity:{row.idempotency_key}",
                occurred_at=row.server_timestamp,
            )
            connection.execute(
                text("UPDATE one_referral_events SET scored_at=NOW() WHERE id=:id"), {"id": row.id}
            )
    from hushh_mcp.services.one_referral_service import sync_referral_qualification_from_onboarding

    qualification = sync_referral_qualification_from_onboarding(user_id)
    return {"verified_events": len(rows), "qualification": qualification}


def get_transaction_history(user_id: str, before_id: int | None = None, limit: int = 20) -> dict:
    with get_db_connection() as connection:
        rows = connection.execute(
            text("""
            SELECT id,event_type,points,coins,created_at FROM one_referral_score_events
             WHERE user_id=:uid AND (:before IS NULL OR id<:before)
             ORDER BY id DESC LIMIT :limit
        """),
            {"uid": user_id, "before": before_id, "limit": limit + 1},
        ).fetchall()
    page = rows[:limit]
    return {
        "entries": [
            {
                "id": r.id,
                "event_type": r.event_type,
                "points": r.points,
                "coins": r.points,
                "created_at": r.created_at.isoformat(),
            }
            for r in page
        ],
        "next_before_id": page[-1].id if len(rows) > limit else None,
    }


def get_balances(user_id: str) -> dict:
    with get_db_connection() as connection:
        row = connection.execute(
            text("""
          SELECT COALESCE(SUM(points),0) AS points
            FROM one_referral_score_events WHERE user_id=:uid
        """),
            {"uid": user_id},
        ).fetchone()
    return {"points": int(row.points), "coins": int(row.points)}
