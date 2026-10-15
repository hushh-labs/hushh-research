"""Persisted weekly challenge windows and server-time deadline enforcement."""

from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral_scoring.weekly_cutoff import next_weekly_cutoff
from hushh_mcp.services.one_referral_program_settings_service import (
    ProgramSettingsUnavailable,
    get_active_program_settings,
    get_or_create_reward_round,
)


def get_challenge_status() -> dict:
    now = datetime.now(timezone.utc)
    empty = {
        "active": False,
        "status": "not_configured",
        "week_started_at": None,
        "cutoff_at": None,
        "timezone": None,
        "server_now": now.isoformat(),
    }
    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        return empty
    window = next_weekly_cutoff(now, settings.weekly_schedule)
    if window is None:
        return empty
    round_row = get_or_create_reward_round(window.cutoff_at, window.timezone)
    with get_db_connection() as connection:
        connection.execute(
            text("""
           UPDATE one_referral_reward_rounds SET status='ended'
            WHERE cutoff_at<=:now AND status='scheduled'
        """),
            {"now": now},
        )
        connection.execute(
            text("""
           UPDATE one_referral_reward_rounds SET started_at=COALESCE(started_at,:start)
            WHERE id=CAST(:rid AS UUID)
        """),
            {"start": window.week_started_at, "rid": round_row["id"]},
        )
    return {
        "calendar_active": True,
        "campaign_active": settings.feature_active
        and round_row["status"] == "scheduled"
        and now < window.cutoff_at,
        "active": round_row["status"] == "scheduled" and now < window.cutoff_at,
        "status": round_row["status"],
        "round_id": round_row["id"],
        "week_started_at": window.week_started_at.isoformat(),
        "cutoff_at": window.cutoff_at.isoformat(),
        "timezone": window.timezone,
        "server_now": now.isoformat(),
        "weekly_prizes_enabled": settings.feature_active,
    }


def require_open_round(connection, round_id: str):
    row = connection.execute(
        text("""
      SELECT id,cutoff_at FROM one_referral_reward_rounds WHERE id=CAST(:rid AS UUID)
       AND status='scheduled' AND started_at<=NOW() AND cutoff_at>NOW() FOR UPDATE
    """),
        {"rid": round_id},
    ).fetchone()
    if row is None:
        raise ValueError("challenge ended or unavailable")
    return row
