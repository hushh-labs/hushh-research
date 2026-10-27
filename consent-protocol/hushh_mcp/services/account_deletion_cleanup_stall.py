"""Stall observability for the account-deletion cleanup drain.

Read-only: it reports a paused drain and the age of due work, and owns no
lifecycle authority. A release pause must never look like an idle queue.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from sqlalchemy import text

from db.db_client import get_db_connection

logger = logging.getLogger(__name__)

# Runbook "Required monitoring": a due tombstone older than ten minutes.
CLEANUP_STALL_ALERT_SECONDS = 10 * 60
_BACKLOG_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class AccountDeletionDrainReport:
    settled: int
    # Enumerated, non-sensitive label when the provider stage could not run.
    paused_reason: str | None = None


def _provider_cleanup_backlog() -> tuple[int, int | None]:
    """Work claim_due would take; a plain MVCC read that takes no row locks."""
    with get_db_connection() as conn:
        conn.execute(
            text(
                "SELECT set_config('statement_timeout', '2000ms', TRUE),"
                " set_config('lock_timeout', '500ms', TRUE)"
            )
        )
        row = conn.execute(
            text(
                """
                SELECT count(*),
                       EXTRACT(EPOCH FROM now() - min(provider_cleanup_next_attempt_at))::bigint
                FROM account_deletion_tombstones
                WHERE erasure_phase = 'provider_cleanup'
                  AND provider_cleanup_next_attempt_at <= now()
                  AND (cleanup_status IN ('pending', 'retry_pending')
                    OR (cleanup_status = 'running'
                      AND cleanup_claimed_at < now() - interval '5 minutes'))
                """
            )
        ).first()
    if row is None:
        return 0, None
    return int(row[0]), None if row[1] is None else int(row[1])


async def report_paused_drain(paused_reason: str) -> None:
    """Make a paused drain observable; escalate when a due deletion is waiting.

    Called once per scheduler delivery, not from each instance's loop, so the
    stall alert counts deliveries rather than instances. Never raises.
    """
    try:
        due, oldest_due_age_s = await asyncio.wait_for(
            asyncio.to_thread(_provider_cleanup_backlog),
            timeout=_BACKLOG_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning(
            "account_deletion.cleanup_paused reason=%s backlog_unavailable=%s",
            paused_reason,
            type(exc).__name__,
        )
        return
    if due == 0:
        logger.info("account_deletion.cleanup_paused reason=%s due=0", paused_reason)
        return
    stalled = oldest_due_age_s is not None and oldest_due_age_s >= CLEANUP_STALL_ALERT_SECONDS
    (logger.error if stalled else logger.warning)(
        "account_deletion.%s reason=%s due=%s oldest_due_age_s=%s",
        "cleanup_stalled" if stalled else "cleanup_paused",
        paused_reason,
        due,
        oldest_due_age_s,
    )
