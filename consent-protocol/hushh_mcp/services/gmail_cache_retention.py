"""Bounded owner-scoped maintenance of rebuildable Gmail cache artifacts.

This is manual maintenance, not a scheduler or an information authority. PostgreSQL
owns the cutoff and transaction; callers must offload this synchronous service.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

GMAIL_TERMINAL_RUN_RETENTION_DAYS = 30
GMAIL_PREVIEW_RETENTION_DAYS = 7
MAX_RETENTION_BATCH = 1000

# Keep read expiry and compaction on these same clocks. updated_at is only the
# conservative fallback for legacy terminal runs without a completion timestamp.
_SYNC_CANDIDATES = """
    SELECT run_id FROM public.kai_gmail_sync_runs
    WHERE user_id = :user_id
      AND status IN ('completed', 'failed', 'canceled')
      AND COALESCE(completed_at, updated_at) <= :cutoff
    ORDER BY COALESCE(completed_at, updated_at), run_id
    LIMIT :limit
"""
_PREVIEW_CANDIDATES = """
    SELECT artifact_id FROM public.kai_receipt_memory_artifacts
    WHERE user_id = :user_id AND created_at <= :cutoff
    ORDER BY created_at, artifact_id
    LIMIT :limit
"""
_SYNC_DELETE = """
    WITH candidates AS (
        SELECT run_id FROM public.kai_gmail_sync_runs
        WHERE user_id = :user_id
          AND status IN ('completed', 'failed', 'canceled')
          AND COALESCE(completed_at, updated_at) <= :cutoff
        ORDER BY COALESCE(completed_at, updated_at), run_id
        LIMIT :limit FOR UPDATE SKIP LOCKED
    ), deleted AS (
        DELETE FROM public.kai_gmail_sync_runs AS runs USING candidates
        WHERE runs.run_id = candidates.run_id AND runs.user_id = :user_id
          AND runs.status IN ('completed', 'failed', 'canceled')
          AND COALESCE(runs.completed_at, runs.updated_at) <= :cutoff
        RETURNING 1
    ) SELECT count(*) FROM deleted
"""
_PREVIEW_DELETE = """
    WITH candidates AS (
        SELECT artifact_id FROM public.kai_receipt_memory_artifacts
        WHERE user_id = :user_id AND created_at <= :cutoff
        ORDER BY created_at, artifact_id
        LIMIT :limit FOR UPDATE SKIP LOCKED
    ), deleted AS (
        DELETE FROM public.kai_receipt_memory_artifacts AS artifacts USING candidates
        WHERE artifacts.artifact_id = candidates.artifact_id
          AND artifacts.user_id = :user_id AND artifacts.created_at <= :cutoff
        RETURNING 1
    ) SELECT count(*) FROM deleted
"""
_SYNC_UNDATED = """
    SELECT 1 FROM public.kai_gmail_sync_runs
    WHERE user_id = :user_id AND status IN ('completed', 'failed', 'canceled')
      AND completed_at IS NULL AND updated_at IS NULL
    LIMIT :limit
"""
_PREVIEW_UNDATED = """
    SELECT 1 FROM public.kai_receipt_memory_artifacts
    WHERE user_id = :user_id AND created_at IS NULL LIMIT :limit
"""


def maintain_gmail_cache(
    engine: Engine, *, user_id: str, apply: bool = False, batch_limit: int = 200
) -> dict[str, Any]:
    """Report or delete one bounded batch per family for exactly one owner.

    Missing optional tables remain visibly unavailable. Permission failures and
    timeouts roll back the whole batch. No retries after uncertain commit: a manual
    repeat is idempotent, but the lost acknowledgement must not be reported as success.
    No provider credentials, rows, or owner identifiers are returned.
    """
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError("An explicit owner is required.")
    if type(batch_limit) is not int or not 1 <= batch_limit <= MAX_RETENTION_BATCH:
        raise ValueError("Retention batch limit must be between 1 and 1000.")
    if engine.dialect.name != "postgresql":
        raise ValueError("Gmail retention requires PostgreSQL.")
    families = (
        (
            "sync_runs",
            "public.kai_gmail_sync_runs",
            GMAIL_TERMINAL_RUN_RETENTION_DAYS,
            _SYNC_CANDIDATES,
            _SYNC_DELETE,
            _SYNC_UNDATED,
        ),
        (
            "preview_artifacts",
            "public.kai_receipt_memory_artifacts",
            GMAIL_PREVIEW_RETENTION_DAYS,
            _PREVIEW_CANDIDATES,
            _PREVIEW_DELETE,
            _PREVIEW_UNDATED,
        ),
    )
    results: dict[str, Any] = {}
    with engine.begin() as connection:
        connection.execute(text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
        if not apply:
            connection.execute(text("SET TRANSACTION READ ONLY"))
        connection.execute(text("SET LOCAL statement_timeout = '5000ms'"))
        connection.execute(text("SET LOCAL lock_timeout = '1000ms'"))
        connection.execute(text("SET LOCAL idle_in_transaction_session_timeout = '15000ms'"))
        connection.execute(text("SET LOCAL row_security = off"))
        connection.execute(text("SET LOCAL search_path = pg_catalog"))
        observed_at = connection.execute(text("SELECT CURRENT_TIMESTAMP")).scalar_one()
        for family, table, days, candidates, delete, undated in families:
            exists = connection.execute(
                text("SELECT to_regclass(:table) IS NOT NULL"), {"table": table}
            ).scalar_one()
            if not exists:
                results[family] = {"status": "unavailable", "reason": "table_missing"}
                continue
            cutoff = connection.execute(
                text("SELECT CURRENT_TIMESTAMP - make_interval(days => :days)"), {"days": days}
            ).scalar_one()
            params = {"user_id": user_id, "cutoff": cutoff, "limit": batch_limit}
            deleted = int(connection.execute(text(delete), params).scalar_one()) if apply else 0
            # Observe without SKIP LOCKED so an in-flight row cannot look erased.
            params["limit"] = batch_limit + 1
            remaining = len(connection.execute(text(candidates), params).fetchall())
            unresolved = len(connection.execute(text(undated), params).fetchall())
            results[family] = {
                "status": "observed",
                "retention_days": days,
                "cutoff": cutoff.isoformat(),
                "deleted": deleted,
                "expired_rows_observed": remaining,
                "expired_count_capped": remaining > batch_limit,
                "undated_rows_observed": unresolved,
                "undated_count_capped": unresolved > batch_limit,
            }
    return {
        "mode": "apply" if apply else "report",
        "scope": "one_owner_live_cache_only",
        "observed_at": observed_at.isoformat(),
        "batch_limit": batch_limit,
        "families": results,
        "scope_drained": all(
            result["status"] == "observed"
            and result["expired_rows_observed"] == 0
            and result["undated_rows_observed"] == 0
            for result in results.values()
        ),
        "limitations": "READ COMMITTED observations, not an atomic snapshot or write fence; not provider, PKM, backup, or account-erasure evidence.",
    }
