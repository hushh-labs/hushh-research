"""Cumulative referral scoring: the durable worker and its ledger writes.

Owns `one_referral_score_events`, `one_referral_scoring_jobs`,
`one_referral_streak_state`, and the leaderboard snapshot tables (migration
270). `one_referral_service.sync_referral_qualification_from_onboarding`
calls `enqueue_scoring_work` from inside its own transaction the instant a
relationship reaches `qualified`; everything else here runs later, off that
request, in a retryable worker.

Two things this module will never do:

  * compute a score inline on the qualifying request -- scoring happens in the
    worker so an onboarding-completion write never blocks on it;
  * UPDATE a settled `one_referral_score_events` row -- a correction is always
    a new reversal row that references what it reverses.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral_scoring.points import (
    STREAK_BONUS,
    compute_streak_awards,
    points_for_qualification,
)
from hushh_mcp.services.one_referral_program_settings_service import (
    ProgramSettings,
    get_active_program_settings,
)

logger = logging.getLogger(__name__)

# How long a claimed job may run before another worker is allowed to reclaim
# it. Generous relative to the actual work (a handful of small writes), so a
# live worker is never raced by its own retry.
_LEASE_SECONDS = 120
_DEFAULT_CLAIM_LIMIT = 20
_FALLBACK_TIMEZONE = "UTC"


class ScoringServiceError(RuntimeError):
    """A scoring operation could not be completed."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def enqueue_scoring_work(connection, *, relationship_id: str, user_id: str) -> None:
    """Record the canonical qualification event and enqueue durable work.

    MUST be called with the SAME connection/transaction that just updated the
    relationship to `qualified` -- this is the "all three in one transaction"
    step the product spec requires. Both inserts are idempotent: calling this
    twice for the same relationship (a retried request, a replayed event)
    writes nothing a second time.
    """
    connection.execute(
        text(
            """
            INSERT INTO one_referral_events
              (relationship_id, user_id, event_type, idempotency_key)
            VALUES
              (CAST(:rid AS UUID), :uid, 'qualified', :idempotency_key)
            ON CONFLICT (idempotency_key) DO NOTHING
            """
        ),
        {
            "rid": relationship_id,
            "uid": user_id,
            "idempotency_key": f"referral_qualified:{relationship_id}",
        },
    )
    connection.execute(
        text(
            """
            INSERT INTO one_referral_scoring_jobs (relationship_id, user_id)
            VALUES (CAST(:rid AS UUID), :uid)
            ON CONFLICT (relationship_id) DO NOTHING
            """
        ),
        {"rid": relationship_id, "uid": user_id},
    )


def claim_due_scoring_jobs(limit: int = _DEFAULT_CLAIM_LIMIT) -> list[dict]:
    """Claim up to `limit` due jobs with a bounded lease.

    Due means queued, or running under a lease that already expired (a
    crashed or killed worker). `FOR UPDATE SKIP LOCKED` lets concurrent
    workers claim disjoint batches without blocking on each other.
    """
    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                WITH claimable AS (
                    SELECT job_id
                      FROM one_referral_scoring_jobs
                     WHERE status = 'queued'
                        OR (status = 'running' AND lease_expires_at < :now)
                     ORDER BY next_at
                     LIMIT :limit
                       FOR UPDATE SKIP LOCKED
                )
                UPDATE one_referral_scoring_jobs
                   SET status = 'running',
                       lease_id = gen_random_uuid(),
                       lease_expires_at = :lease_expires_at,
                       inspected_at = :now
                 WHERE job_id IN (SELECT job_id FROM claimable)
                RETURNING job_id, relationship_id, user_id, lease_id, retry_count
                """
            ),
            {
                "now": _now(),
                "limit": limit,
                "lease_expires_at": _now() + timedelta(seconds=_LEASE_SECONDS),
            },
        ).fetchall()
    return [
        {
            "job_id": str(row.job_id),
            "relationship_id": str(row.relationship_id),
            "user_id": row.user_id,
            "lease_id": str(row.lease_id),
            "retry_count": row.retry_count,
        }
        for row in rows
    ]


def _distinct_qualifying_dates(connection, user_id: str, program_timezone: str) -> list[date]:
    rows = connection.execute(
        text(
            """
            SELECT DISTINCT (qualified_at AT TIME ZONE :tz)::date AS qualifying_date
              FROM one_referral_relationships
             WHERE referrer_user_id = :uid
               AND status = 'qualified'
               AND qualified_at IS NOT NULL
            """
        ),
        {"uid": user_id, "tz": program_timezone},
    ).fetchall()
    return [row.qualifying_date for row in rows]


def process_one_job(job: dict) -> dict:
    """Score one qualified relationship: base/flash points, then streak.

    Idempotent end to end -- every insert this function makes uses a unique
    idempotency key, so reprocessing the same job (a retry, a reclaimed lease)
    never double-credits. Returns a summary for the caller/worker route; it
    is not a public API response and carries no user-facing shape contract.
    """
    relationship_id = job["relationship_id"]
    job_id = job["job_id"]
    try:
        with get_db_connection() as connection:
            relationship = connection.execute(
                text(
                    """
                    SELECT id, referrer_user_id, status, qualified_at
                      FROM one_referral_relationships
                     WHERE id = CAST(:rid AS UUID)
                     LIMIT 1
                       FOR UPDATE
                    """
                ),
                {"rid": relationship_id},
            ).fetchone()

            if (
                relationship is None
                or relationship.status != "qualified"
                or relationship.qualified_at is None
            ):
                connection.execute(
                    text(
                        """
                        UPDATE one_referral_scoring_jobs
                           SET status = 'completed', error_code = 'relationship_not_qualified',
                               updated_at = :now
                         WHERE job_id = CAST(:jid AS UUID)
                        """
                    ),
                    {"now": _now(), "jid": job_id},
                )
                return {"status": "skipped", "reason": "relationship_not_qualified"}

            settings: ProgramSettings = get_active_program_settings()
            award = points_for_qualification(
                relationship.qualified_at, settings.points, settings.flash_windows
            )
            connection.execute(
                text(
                    """
                    INSERT INTO one_referral_score_events
                      (user_id, relationship_id, event_type, points, settings_version, idempotency_key)
                    VALUES
                      (:uid, CAST(:rid AS UUID), :event_type, :points, :version, :idempotency_key)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """
                ),
                {
                    "uid": relationship.referrer_user_id,
                    "rid": relationship_id,
                    "event_type": award.event_type,
                    "points": award.points,
                    "version": settings.version,
                    "idempotency_key": f"score:{relationship_id}",
                },
            )

            program_timezone = (
                str(settings.weekly_schedule.get("timezone") or "").strip() or _FALLBACK_TIMEZONE
            )
            streak_row = connection.execute(
                text(
                    """
                    SELECT last_awarded_through_date
                      FROM one_referral_streak_state
                     WHERE user_id = :uid
                       FOR UPDATE
                    """
                ),
                {"uid": relationship.referrer_user_id},
            ).fetchone()
            already_awarded_through = streak_row.last_awarded_through_date if streak_row else None

            qualifying_dates = _distinct_qualifying_dates(
                connection, relationship.referrer_user_id, program_timezone
            )
            new_awards = compute_streak_awards(qualifying_dates, already_awarded_through)
            streak_points = int(settings.streak_rules.get("bonus_points", 0))
            for awarded_day in new_awards:
                connection.execute(
                    text(
                        """
                        INSERT INTO one_referral_score_events
                          (user_id, relationship_id, event_type, points, settings_version, idempotency_key)
                        VALUES
                          (:uid, NULL, :event_type, :points, :version, :idempotency_key)
                        ON CONFLICT (idempotency_key) DO NOTHING
                        """
                    ),
                    {
                        "uid": relationship.referrer_user_id,
                        "event_type": STREAK_BONUS,
                        "points": streak_points,
                        "version": settings.version,
                        "idempotency_key": f"streak:{relationship.referrer_user_id}:{awarded_day.isoformat()}",
                    },
                )
            if new_awards:
                newest = max(new_awards)
                if streak_row is None:
                    connection.execute(
                        text(
                            """
                            INSERT INTO one_referral_streak_state (user_id, last_awarded_through_date)
                            VALUES (:uid, :through)
                            """
                        ),
                        {"uid": relationship.referrer_user_id, "through": newest},
                    )
                else:
                    connection.execute(
                        text(
                            """
                            UPDATE one_referral_streak_state
                               SET last_awarded_through_date = :through, updated_at = :now
                             WHERE user_id = :uid
                            """
                        ),
                        {"through": newest, "now": _now(), "uid": relationship.referrer_user_id},
                    )
            elif streak_row is None:
                connection.execute(
                    text("INSERT INTO one_referral_streak_state (user_id) VALUES (:uid)"),
                    {"uid": relationship.referrer_user_id},
                )

            connection.execute(
                text(
                    """
                    UPDATE one_referral_scoring_jobs
                       SET status = 'completed', updated_at = :now
                     WHERE job_id = CAST(:jid AS UUID)
                    """
                ),
                {"now": _now(), "jid": job_id},
            )
    except Exception:
        logger.exception("[referral_scoring] job_failed job_id=%s", job_id)
        _record_job_failure(job_id, job.get("retry_count", 0))
        return {"status": "failed"}

    return {"status": "completed", "event_type": award.event_type, "streak_awards": len(new_awards)}


def _record_job_failure(job_id: str, retry_count: int) -> None:
    """Best-effort: requeue with backoff, or give up after too many retries.

    Runs in its OWN connection because the job's own transaction already
    rolled back when the exception that got us here was raised.
    """
    next_retry = retry_count + 1
    backoff_seconds = min(60 * (2**retry_count), 3600)
    try:
        with get_db_connection() as connection:
            connection.execute(
                text(
                    """
                    UPDATE one_referral_scoring_jobs
                       SET status = CASE WHEN retry_count >= 5 THEN 'failed' ELSE 'queued' END,
                           retry_count = :next_retry,
                           error_code = 'processing_error',
                           next_at = :next_at,
                           lease_id = NULL,
                           lease_expires_at = NULL,
                           updated_at = :now
                     WHERE job_id = CAST(:jid AS UUID)
                    """
                ),
                {
                    "next_retry": next_retry,
                    "next_at": _now() + timedelta(seconds=backoff_seconds),
                    "now": _now(),
                    "jid": job_id,
                },
            )
    except Exception:
        logger.exception("[referral_scoring] job_failure_record_failed job_id=%s", job_id)


def reverse_relationship_scoring(relationship_id: str, *, reason: str) -> dict:
    """Audited compensating entries for a relationship found to be invalid.

    Reverses only this relationship's own base/flash award -- a streak bonus
    it may have contributed a qualifying day toward is a separate, shared
    event across possibly several relationships and is not auto-reversed
    here; that stays a reviewed, manual follow-up. Idempotent: an event
    already reversed is skipped, so calling this twice for the same
    relationship changes nothing the second time.
    """
    reversed_events: list[dict] = []
    with get_db_connection() as connection:
        originals = connection.execute(
            text(
                """
                SELECT e.id, e.points
                  FROM one_referral_score_events e
                 WHERE e.relationship_id = CAST(:rid AS UUID)
                   AND e.event_type IN ('base_qualification', 'flash_qualification')
                   AND NOT EXISTS (
                         SELECT 1 FROM one_referral_score_events r
                          WHERE r.reverses_event_id = e.id
                       )
                """
            ),
            {"rid": relationship_id},
        ).fetchall()
        for original in originals:
            connection.execute(
                text(
                    """
                    INSERT INTO one_referral_score_events
                      (user_id, relationship_id, event_type, points, settings_version,
                       idempotency_key, reverses_event_id)
                    SELECT user_id, relationship_id, 'reversal', :reversal_points,
                           settings_version, :idempotency_key, :original_id
                      FROM one_referral_score_events
                     WHERE id = :original_id
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """
                ),
                {
                    "reversal_points": -original.points,
                    "idempotency_key": f"reversal:{original.id}",
                    "original_id": original.id,
                },
            )
            reversed_events.append({"event_id": original.id, "points_reversed": -original.points})
    logger.info(
        "[referral_scoring] relationship_scoring_reversed relationship_id=%s reason=%s count=%d",
        relationship_id,
        reason,
        len(reversed_events),
    )
    return {"relationship_id": relationship_id, "reversed_events": reversed_events}


def get_cumulative_score(user_id: str) -> int:
    with get_db_connection() as connection:
        row = connection.execute(
            text(
                "SELECT COALESCE(SUM(points), 0) AS total FROM one_referral_score_events WHERE user_id = :uid"
            ),
            {"uid": user_id},
        ).fetchone()
    return int(row.total) if row else 0


@dataclass(frozen=True)
class LeaderboardPublishResult:
    snapshot_id: str
    entry_count: int
    generated_at: datetime


def publish_leaderboard_snapshot(limit: int = 500) -> LeaderboardPublishResult:
    """Compute and publish one consistent cumulative-ranking snapshot.

    Ties break on the earliest point-earning event: deterministic and
    reproducible from the ledger alone, never on worker timing. The dashboard
    reads the LATEST snapshot rather than this aggregate query directly.
    """
    with get_db_connection() as connection:
        settings = get_active_program_settings()
        ranked = connection.execute(
            text(
                """
                SELECT user_id, SUM(points) AS total, MIN(created_at) AS earliest
                  FROM one_referral_score_events
                 GROUP BY user_id
                HAVING SUM(points) > 0
                 ORDER BY total DESC, earliest ASC
                 LIMIT :limit
                """
            ),
            {"limit": limit},
        ).fetchall()

        snapshot = connection.execute(
            text(
                """
                INSERT INTO one_referral_leaderboard_snapshots (settings_version, entry_count)
                VALUES (:version, :count)
                RETURNING snapshot_id, generated_at
                """
            ),
            {"version": settings.version, "count": len(ranked)},
        ).fetchone()

        for rank, row in enumerate(ranked, start=1):
            connection.execute(
                text(
                    """
                    INSERT INTO one_referral_leaderboard_snapshot_entries
                      (snapshot_id, user_id, cumulative_points, rank)
                    VALUES (:snapshot_id, :uid, :points, :rank)
                    """
                ),
                {
                    "snapshot_id": snapshot.snapshot_id,
                    "uid": row.user_id,
                    "points": int(row.total),
                    "rank": rank,
                },
            )

    return LeaderboardPublishResult(
        snapshot_id=str(snapshot.snapshot_id),
        entry_count=len(ranked),
        generated_at=snapshot.generated_at,
    )
