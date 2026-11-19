"""Exact active KYC metadata read; no classification, reply or delivery authority."""

from collections.abc import Awaitable, Callable
from typing import Any


async def public_active_workflow(
    *,
    user_id: str,
    workflow_id: str,
    load_pool: Callable[[], Awaitable[Any]],
    project: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any] | None:
    pool = await load_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT workflow_id, status, gmail_thread_id, received_at,
                   classification_confidence, requested_field_labels,
                   candidate_scopes, attachment_review_required, created_at, updated_at
            FROM gmail_personal_information_requests
            WHERE user_id = $1 AND workflow_id = $2 AND status = 'detected'
            """,
            user_id,
            workflow_id,
        )
    return project(dict(row)) if row else None


async def public_terminal_workflow(
    *,
    user_id: str,
    workflow_id: str,
    load_pool: Callable[[], Awaitable[Any]],
    project: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any] | None:
    """Read a dated outcome; never make a closed request actionable again."""
    pool = await load_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT workflow_id,status,gmail_thread_id,received_at,classification_confidence,
                requested_field_labels,candidate_scopes,attachment_review_required,created_at,updated_at
                FROM gmail_personal_information_requests
                WHERE user_id=$1 AND workflow_id=$2 AND status IN ('sent','ignored','blocked')""",
            user_id,
            workflow_id,
        )
    return project(dict(row)) if row else None
