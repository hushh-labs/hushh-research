"""Weekly reward-round finalization (migration 273, PR5).

Closes one scheduled `one_referral_reward_rounds` row into up to three
`one_referral_weekly_awards` rows -- the frozen top-3 CUMULATIVE standing as
of that round's cutoff. This never recomputes or touches
`one_referral_score_events`: a prize is a read of the existing ledger, never
a write to it, and winning a round changes nothing about a user's score or
referral count.

The product spec is explicit and repeated: the program is cumulative with no
weekly reset, prizes are awarded weekly, and a previous winner is expected to
win again in a later round with zero new qualifying referrals that week.
Nothing here excludes a user for having already won -- the only identity a
slot has is (reward_round_id, award_slot), never (user_id, anything).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.one_referral_program_settings_service import (
    get_active_program_settings,
    get_or_create_reward_round,
)

AWARD_SLOTS = 3


class RealAwardProcessingDisabled(RuntimeError):
    """Program settings are not feature_active; no weekly award may be finalized."""


@dataclass(frozen=True)
class FinalizedAward:
    award_slot: int
    user_id: str
    cumulative_points_at_cutoff: int


@dataclass(frozen=True)
class FinalizeResult:
    reward_round_id: str
    status: str
    awards: list[FinalizedAward] = field(default_factory=list)


def finalize_reward_round(cutoff_at: datetime, program_timezone: str) -> FinalizeResult:
    """Close one weekly round: freeze the top-3 cumulative standing as of
    `cutoff_at` into up to 3 award rows. Fewer than 3 users with positive
    cumulative points leaves the remaining slot(s) unawarded -- never
    backfilled with a zero-point or ineligible user.

    Idempotent and repeat-winner-safe by construction, never by caller
    discipline:
      * the round is found-or-created exactly once per `cutoff_at`
        (`get_or_create_reward_round`'s unique index on cutoff_at);
      * each slot is written ON CONFLICT (reward_round_id, award_slot) DO
        NOTHING, so finalizing an already-finalized round again -- a
        retried scheduler, a redeployed worker, an operator re-run -- creates
        zero extra prizes;
      * ranking reads this user's CURRENT cumulative points as of the
        cutoff with no exclusion for a prior winner, so the same user can
        fill rank 1 in round 7 after already filling it in round 3.

    Gated on `settings.feature_active`: v1 ships inactive, and this function
    refuses to create any award row until that is deliberately turned on, so
    real prize processing stays off by construction.
    """
    settings = get_active_program_settings()
    if not settings.feature_active:
        raise RealAwardProcessingDisabled(
            "referral gamification settings are not feature_active; "
            "no weekly award may be finalized"
        )

    round_row = get_or_create_reward_round(cutoff_at, program_timezone)

    with get_db_connection() as connection:
        if round_row["status"] == "finalized":
            existing = connection.execute(
                text(
                    """
                    SELECT award_slot, user_id, cumulative_points_at_cutoff
                      FROM one_referral_weekly_awards
                     WHERE reward_round_id = CAST(:rid AS UUID)
                     ORDER BY award_slot
                    """
                ),
                {"rid": round_row["id"]},
            ).fetchall()
            return FinalizeResult(
                reward_round_id=round_row["id"],
                status="finalized",
                awards=[
                    FinalizedAward(row.award_slot, row.user_id, row.cumulative_points_at_cutoff)
                    for row in existing
                ],
            )

        ranked = connection.execute(
            text(
                """
                SELECT user_id, SUM(points) AS total
                  FROM one_referral_score_events
                 WHERE created_at < :cutoff_at
                 GROUP BY user_id
                HAVING SUM(points) > 0
                 ORDER BY total DESC, user_id ASC
                 LIMIT :limit
                """
            ),
            {"cutoff_at": round_row["cutoff_at"], "limit": AWARD_SLOTS},
        ).fetchall()

        awards: list[FinalizedAward] = []
        for slot, row in enumerate(ranked, start=1):
            inserted = connection.execute(
                text(
                    """
                    INSERT INTO one_referral_weekly_awards
                      (reward_round_id, award_slot, user_id, cumulative_points_at_cutoff)
                    VALUES (CAST(:rid AS UUID), :slot, :uid, :points)
                    ON CONFLICT (reward_round_id, award_slot) DO NOTHING
                    RETURNING award_slot, user_id, cumulative_points_at_cutoff
                    """
                ),
                {
                    "rid": round_row["id"],
                    "slot": slot,
                    "uid": row.user_id,
                    "points": int(row.total),
                },
            ).fetchone()
            if inserted is not None:
                awards.append(
                    FinalizedAward(
                        inserted.award_slot,
                        inserted.user_id,
                        inserted.cumulative_points_at_cutoff,
                    )
                )

        connection.execute(
            text(
                """
                UPDATE one_referral_reward_rounds
                   SET status = 'finalized', finalized_at = NOW()
                 WHERE id = CAST(:rid AS UUID) AND status <> 'finalized'
                """
            ),
            {"rid": round_row["id"]},
        )

    return FinalizeResult(reward_round_id=round_row["id"], status="finalized", awards=awards)


def list_pending_weekly_awards(*, limit: int = 100) -> list[dict]:
    """Staff review queue: awards finalized but not yet decided."""
    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT id, reward_round_id, award_slot, user_id,
                       cumulative_points_at_cutoff, status, created_at
                  FROM one_referral_weekly_awards
                 WHERE status = 'pending_review'
                 ORDER BY created_at
                 LIMIT :limit
                """
            ),
            {"limit": limit},
        ).fetchall()
    return [
        {
            "id": str(row.id),
            "reward_round_id": str(row.reward_round_id),
            "award_slot": row.award_slot,
            "user_id": row.user_id,
            "cumulative_points_at_cutoff": row.cumulative_points_at_cutoff,
            "status": row.status,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]
