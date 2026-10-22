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
from hushh_mcp.operons.referral.joined import JOINED_REFERRAL_PREDICATE
from hushh_mcp.operons.referral_scoring.points import (
    points_for_qualification,
)
from hushh_mcp.services.one_referral_circle_service import (
    record_circle_contribution,
    resolve_contributing_circle,
)
from hushh_mcp.services.one_referral_program_settings_service import (
    ProgramSettings,
    get_active_program_settings,
    get_program_settings_at,
)
from hushh_mcp.services.one_referral_rewards_service import evaluate_and_issue_milestones

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
                     WHERE (status = 'queued' AND next_at <= NOW())
                        OR (status = 'running' AND lease_expires_at < NOW())
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
            lease = connection.execute(
                text("""
                SELECT lease_id FROM one_referral_scoring_jobs
                 WHERE job_id=CAST(:jid AS UUID) AND status='running'
                   AND lease_id=CAST(:lease AS UUID) AND lease_expires_at>NOW() FOR UPDATE
            """),
                {"jid": job_id, "lease": job.get("lease_id")},
            ).fetchone()
            if lease is None:
                return {"status": "skipped", "reason": "stale_lease"}
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

            settings: ProgramSettings = get_program_settings_at(relationship.qualified_at)
            award = points_for_qualification(
                relationship.qualified_at, settings.points, settings.flash_windows
            )
            connection.execute(
                text(
                    """
                    INSERT INTO one_referral_score_events
                      (user_id, relationship_id, event_type, points, coins, settings_version, idempotency_key,created_at)
                    VALUES
                      (:uid, CAST(:rid AS UUID), :event_type, :points, :points, :version, :idempotency_key,:occurred_at)
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
                    "occurred_at": relationship.qualified_at,
                },
            )

            contributing_circle_id = resolve_contributing_circle(
                connection,
                user_id=relationship.referrer_user_id,
                as_of=relationship.qualified_at,
                relationship_id=relationship_id,
            )
            if contributing_circle_id is not None:
                record_circle_contribution(
                    connection,
                    relationship_id=relationship_id,
                    user_id=relationship.referrer_user_id,
                    circle_id=contributing_circle_id,
                    contributed_at=relationship.qualified_at,
                )

            milestones_issued = evaluate_and_issue_milestones(
                connection,
                user_id=relationship.referrer_user_id,
                settings_milestones=settings.milestones,
                settings_version=settings.version,
            )

            # Daily activity owns streak awards; referral jobs never increment a day.
            new_awards = []

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
        _record_job_failure(job_id, job.get("retry_count", 0), lease_id=job.get("lease_id"))
        return {"status": "failed"}

    return {
        "status": "completed",
        "event_type": award.event_type,
        "streak_awards": len(new_awards),
        "contributed_circle_id": contributing_circle_id,
        "milestones_issued": [m["milestone_key"] for m in milestones_issued],
    }


def _record_job_failure(job_id: str, retry_count: int, *, lease_id: str | None = None) -> None:
    """Best-effort: requeue with backoff, or give up after too many retries.

    Runs in its OWN connection because the job's own transaction already
    rolled back when the exception that got us here was raised.
    """
    next_retry = min(5, retry_count + 1)
    backoff_seconds = min(60 * (2**retry_count), 3600)
    try:
        with get_db_connection() as connection:
            connection.execute(
                text(
                    """
                    UPDATE one_referral_scoring_jobs
                       SET status = CASE WHEN :next_retry >= 5 THEN 'failed' ELSE 'queued' END,
                           retry_count = :next_retry,
                           error_code = 'processing_error',
                           next_at = :next_at,
                           lease_id = NULL,
                           lease_expires_at = NULL,
                           updated_at = :now
                     WHERE job_id = CAST(:jid AS UUID) AND lease_id=CAST(:lease AS UUID) AND status='running'
                    """
                ),
                {
                    "next_retry": next_retry,
                    "next_at": _now() + timedelta(seconds=backoff_seconds),
                    "now": _now(),
                    "jid": job_id,
                    "lease": lease_id,
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
                SELECT e.id, e.points,e.coins
                  FROM one_referral_score_events e
                 WHERE e.relationship_id = CAST(:rid AS UUID)
                   AND e.event_type IN ('base_qualification', 'flash_qualification','in_progress_activity','qualified_activity')
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
                      (user_id, relationship_id, event_type, points, coins, settings_version,
                       idempotency_key, reverses_event_id)
                    SELECT user_id, relationship_id, 'reversal', :reversal_points,
                           :reversal_coins, settings_version, :idempotency_key, :original_id
                      FROM one_referral_score_events
                     WHERE id = :original_id
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """
                ),
                {
                    "reversal_points": -original.points,
                    "reversal_coins": -original.coins,
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


_LEADERBOARD_COHORT_SQL = f"""
            SELECT p.user_id,COALESCE(s.total,0) AS total,s.earliest
            FROM actor_profiles p
            LEFT JOIN (
              SELECT user_id,SUM(points) AS total,MIN(created_at) FILTER(WHERE points>0) AS earliest
              FROM one_referral_score_events WHERE id<=:watermark GROUP BY user_id
            ) s ON s.user_id=p.user_id
            WHERE s.total>0 OR EXISTS(SELECT 1 FROM one_referral_relationships r
              WHERE r.referrer_user_id=p.user_id AND {JOINED_REFERRAL_PREDICATE})
"""  # nosec B608 # Authored constant predicate; watermark is bound.


def publish_leaderboard_snapshot(limit: int | None = None) -> LeaderboardPublishResult:
    """Publish all coin ranks in one SQL write, retaining pinned pages for a day."""
    settings = get_active_program_settings()
    with get_db_connection() as connection:
        connection.execute(text("SET LOCAL statement_timeout='10s'"))
        connection.execute(text("SELECT pg_advisory_xact_lock(332,2)"))
        watermark = connection.execute(
            text("SELECT COALESCE(MAX(id),0) FROM one_referral_score_events")
        ).scalar()
        latest = connection.execute(
            text("""
          SELECT snapshot_id,generated_at,entry_count,source_event_id,settings_version
            FROM one_referral_leaderboard_snapshots ORDER BY generated_at DESC LIMIT 1
        """)
        ).fetchone()
        if (
            latest
            and latest.source_event_id == watermark
            and (_now() - latest.generated_at).total_seconds() < 60
            and latest.settings_version == settings.version
            and not connection.execute(
                text(f"""WITH cohort AS ({_LEADERBOARD_COHORT_SQL}), ranked AS (
                  SELECT user_id,total,ROW_NUMBER() OVER(ORDER BY total DESC,earliest,user_id) AS rank FROM cohort
                ), saved AS (
                  SELECT user_id,cumulative_points AS total,rank FROM one_referral_leaderboard_snapshot_entries WHERE snapshot_id=:sid
                ) SELECT EXISTS(SELECT * FROM ranked EXCEPT SELECT * FROM saved)
                      OR EXISTS(SELECT * FROM saved EXCEPT SELECT * FROM ranked)"""),  # nosec B608 # Fixed cohort SQL; snapshot ID and watermark are bound.
                {"sid": latest.snapshot_id, "watermark": watermark},
            ).scalar()
        ):
            return LeaderboardPublishResult(
                str(latest.snapshot_id), latest.entry_count, latest.generated_at
            )
        snapshot = connection.execute(
            text("""
          INSERT INTO one_referral_leaderboard_snapshots(settings_version,entry_count,source_event_id)
          VALUES(:version,0,:watermark) RETURNING snapshot_id,generated_at
        """),
            {"version": settings.version, "watermark": watermark},
        ).fetchone()
        inserted = connection.execute(
            text(f"""
          INSERT INTO one_referral_leaderboard_snapshot_entries(snapshot_id,user_id,cumulative_points,rank)
          SELECT :sid,user_id,total,ROW_NUMBER() OVER(ORDER BY total DESC,earliest,user_id)
          FROM ({_LEADERBOARD_COHORT_SQL}) ranked
        """),  # nosec B608 # Fixed cohort SQL; snapshot ID and watermark are bound.
            {"sid": snapshot.snapshot_id, "watermark": watermark},
        )
        entry_count = inserted.rowcount
        connection.execute(
            text(
                "UPDATE one_referral_leaderboard_snapshots SET entry_count=:count WHERE snapshot_id=:sid"
            ),
            {"count": entry_count, "sid": snapshot.snapshot_id},
        )
        connection.execute(
            text(
                "DELETE FROM one_referral_leaderboard_snapshots WHERE generated_at<NOW()-INTERVAL '1 day' AND snapshot_id<>:sid"
            ),
            {"sid": snapshot.snapshot_id},
        )
    return LeaderboardPublishResult(str(snapshot.snapshot_id), entry_count, snapshot.generated_at)
