"""Persisted weekly challenge windows and server-time deadline enforcement."""

from __future__ import annotations

from datetime import datetime, timezone
from time import monotonic

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral_scoring.weekly_cutoff import next_weekly_cutoff
from hushh_mcp.services.one_referral_program_settings_service import (
    ProgramSettingsUnavailable,
    get_active_program_settings,
    get_or_create_reward_round,
)


def get_challenge_status() -> dict:
    requested_at = monotonic()
    empty = {
        "active": False,
        "calendar_active": False,
        "campaign_active": False,
        "weekly_prizes_enabled": False,
        "status": "not_configured",
        "week_started_at": None,
        "cutoff_at": None,
        "timezone": None,
    }

    def timed_response(payload: dict, now: datetime | None = None) -> dict:
        return {
            **payload,
            "server_now": (now or datetime.now(timezone.utc)).isoformat(),
            "server_processing_ms": max(0, monotonic() - requested_at) * 1000,
        }

    try:
        settings = get_active_program_settings()
    except ProgramSettingsUnavailable:
        return timed_response(empty)
    now = datetime.now(timezone.utc)
    # A database wait can cross the cutoff. Resolve the next round once rather
    # than returning an expired deadline with a running-prize indicator.
    for _ in range(2):
        window = next_weekly_cutoff(now, settings.weekly_schedule)
        if window is None:
            return timed_response(empty)
        round_row = get_or_create_reward_round(window.cutoff_at, window.timezone)
        with get_db_connection() as connection:
            connection.execute(
                text("""
               UPDATE one_referral_reward_rounds SET status='ended'
                WHERE cutoff_at<=:now AND status='scheduled'
            """),
                {"now": now},
            )
            persisted = connection.execute(
                text("""
               UPDATE one_referral_reward_rounds SET started_at=COALESCE(started_at,:start)
                WHERE id=CAST(:rid AS UUID)
                RETURNING started_at,cutoff_at,timezone,status
            """),
                {"start": window.week_started_at, "rid": round_row["id"]},
            ).fetchone()
        now = datetime.now(timezone.utc)
        if persisted is None:
            raise RuntimeError("Weekly prize round is unavailable")
        if now >= persisted.cutoff_at:
            continue
        active = bool(
            settings.feature_active
            and persisted.status == "scheduled"
            and persisted.started_at <= now < persisted.cutoff_at
        )
        return timed_response(
            {
                "calendar_active": True,
                "campaign_active": active,
                "active": active,
                "status": persisted.status,
                "round_id": round_row["id"],
                "week_started_at": persisted.started_at.isoformat(),
                "cutoff_at": persisted.cutoff_at.isoformat(),
                "timezone": persisted.timezone,
                "weekly_prizes_enabled": settings.feature_active,
            },
            now,
        )
    raise RuntimeError("Weekly prize round changed during read")


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
