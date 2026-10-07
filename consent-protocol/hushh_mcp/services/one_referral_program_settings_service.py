"""Referral gamification program settings and weekly reward round schedule.

Owns `one_referral_program_settings` and `one_referral_reward_rounds`
(migration 270). Deliberately a separate module from `one_referral_service`:
that file owns attribution and qualification -- whether a referral counts at
all. This file owns the rules for what a qualified referral is WORTH (points,
milestones, streaks, flash windows, the weekly schedule, the prize catalogue)
and the schedule slots those weekly rounds fill. Scoring and reward
entitlements themselves are a later PR; this is the foundation they read.

Nothing here invents an operational value the product has not supplied. v1
settings ship with `feature_active = FALSE` and an unset weekly schedule
(timezone, cutoff day, cutoff time) -- `get_active_program_settings()` still
returns a row so the app has point values and milestone thresholds to render,
but nothing may finalize a weekly round until a real schedule is configured.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection


class ProgramSettingsUnavailable(RuntimeError):
    """No referral gamification settings version is currently active."""


class RewardRoundError(RuntimeError):
    """A reward round operation could not be completed."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class ProgramSettings:
    """One version of the gamification program's configuration, as read from
    the database. Fields are the raw JSONB shapes; callers that need typed
    access (scoring, milestones, flash windows -- later PRs) parse them from
    here rather than re-querying the table."""

    version: int
    qualification_policy_version: int
    points: dict
    milestones: list
    streak_rules: dict
    flash_windows: list
    weekly_schedule: dict
    prize_catalogue: list
    tie_break_rules: dict
    fulfillment_config: dict
    feature_active: bool


def _row_to_settings(row) -> ProgramSettings:
    return ProgramSettings(
        version=row.version,
        qualification_policy_version=row.qualification_policy_version,
        points=dict(row.points or {}),
        milestones=list(row.milestones or []),
        streak_rules=dict(row.streak_rules or {}),
        flash_windows=list(row.flash_windows or []),
        weekly_schedule=dict(row.weekly_schedule or {}),
        prize_catalogue=list(row.prize_catalogue or []),
        tie_break_rules=dict(row.tie_break_rules or {}),
        fulfillment_config=dict(row.fulfillment_config or {}),
        feature_active=bool(row.feature_active),
    )


def get_active_program_settings() -> ProgramSettings:
    """The one live gamification settings version.

    Raises if none is active. A row existing with `feature_active = False` is
    the normal pre-launch state, not an error -- callers that gate on whether
    real prizes may be awarded must check `.feature_active` themselves rather
    than treating "a settings row exists" as "the program is live".
    """
    with get_db_connection() as connection:
        row = connection.execute(
            text(
                """
                SELECT *
                  FROM one_referral_program_settings
                 WHERE activated_at IS NOT NULL AND retired_at IS NULL
                 LIMIT 1
                """
            )
        ).fetchone()
    if row is None:
        raise ProgramSettingsUnavailable("no active referral gamification settings")
    return _row_to_settings(row)


def get_or_create_reward_round(cutoff_at: datetime, program_timezone: str) -> dict:
    """The weekly round for this cutoff, creating it on first ask.

    `cutoff_at` is the round's whole identity: callers (a scheduler, a manual
    reconciliation run) pass the ORIGINAL scheduled cutoff, never "now". Two
    callers racing on the same cutoff -- a delayed job and a retry, a cron
    firing twice -- both try to insert; the unique index on `cutoff_at` lets
    exactly one win, and the loser re-reads the winner's row instead of
    erroring. This function creates the schedule slot only: ranking snapshots,
    entitlements, and finalization are a later PR.
    """
    if cutoff_at.tzinfo is None:
        raise RewardRoundError("cutoff_at must be timezone-aware")

    settings = get_active_program_settings()

    with get_db_connection() as connection:
        existing = connection.execute(
            text(
                """
                SELECT id, settings_version, cutoff_at, timezone, status,
                       created_at, finalized_at
                  FROM one_referral_reward_rounds
                 WHERE cutoff_at = :cutoff_at
                 LIMIT 1
                """
            ),
            {"cutoff_at": cutoff_at},
        ).fetchone()
        if existing:
            return _round_row_to_dict(existing)

        try:
            row = connection.execute(
                text(
                    """
                    INSERT INTO one_referral_reward_rounds
                      (settings_version, cutoff_at, timezone)
                    VALUES (:version, :cutoff_at, :tz)
                    RETURNING id, settings_version, cutoff_at, timezone, status,
                              created_at, finalized_at
                    """
                ),
                {
                    "version": settings.version,
                    "cutoff_at": cutoff_at,
                    "tz": program_timezone,
                },
            ).fetchone()
            return _round_row_to_dict(row)
        except Exception:  # noqa: BLE001 -- unique violation on cutoff_at
            reread = connection.execute(
                text(
                    """
                    SELECT id, settings_version, cutoff_at, timezone, status,
                           created_at, finalized_at
                      FROM one_referral_reward_rounds
                     WHERE cutoff_at = :cutoff_at
                     LIMIT 1
                    """
                ),
                {"cutoff_at": cutoff_at},
            ).fetchone()
            if reread is None:
                raise RewardRoundError("could not create or read reward round") from None
            return _round_row_to_dict(reread)


def _round_row_to_dict(row) -> dict:
    return {
        "id": str(row.id),
        "settings_version": row.settings_version,
        "cutoff_at": row.cutoff_at,
        "timezone": row.timezone,
        "status": row.status,
        "created_at": row.created_at,
        "finalized_at": row.finalized_at,
    }
