"""Feed persistence port: ordinary projections are best effort, acknowledgements strict."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

logger = logging.getLogger("hushh_mcp.services.feed_service")


def completed_analysis_source(get_db: Callable[[], Any], user_id: str, run_id: str) -> str | None:
    """Retained server completion metadata; never a client-provided ticker or report."""
    rows = (
        get_db()
        .execute_raw(
            """SELECT metadata->>'ticker' AS ticker FROM feed_events
           WHERE user_id=:user_id AND source_domain='kai'
             AND event_type='kai_analysis_completed' AND source_row_id=:run_id
             AND metadata->>'run_id'=:run_id ORDER BY id DESC LIMIT 1""",
            {"user_id": user_id, "run_id": run_id},
        )
        .data
        or []
    )
    ticker = rows[0].get("ticker") if rows else None
    return ticker if isinstance(ticker, str) and 0 < len(ticker) <= 64 else None


@asynccontextmanager
async def _analysis_transaction(load_pool: Callable, held_connection: Any = None):
    if held_connection is not None:
        # Shared Files already holds the owner library transaction. Never acquire a
        # second connection while holding one: even a one-connection pool must work.
        yield held_connection
        return
    pool = await load_pool()
    async with pool.acquire() as connection, connection.transaction():
        yield connection


async def mark_analysis_viewed(
    load_pool: Callable,
    user_id: str,
    run_id: str,
    completed_ticker: str | None = None,
    *,
    connection: Any = None,
) -> None:
    async with _analysis_transaction(load_pool, connection) as connection:
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            user_id + ":finance-analysis:" + run_id,
        )
        if completed_ticker is not None:
            await connection.execute(
                """INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,metadata,source_row_id)
                VALUES($1,'kai','kai_analysis_completed','Kai',$3::jsonb,$2)
                ON CONFLICT(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL
                DO NOTHING""",
                user_id,
                run_id,
                json.dumps({"run_id": run_id, "ticker": completed_ticker}),
            )
        await connection.execute(
            """UPDATE feed_events SET metadata=metadata || '{"finance_result_viewed":true}'::jsonb
               WHERE user_id=$1 AND source_domain='kai' AND event_type='kai_analysis_completed' AND source_row_id=$2""",
            user_id,
            run_id,
        )
        await connection.execute(
            """UPDATE feed_events SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND source_domain='kai'
               AND event_type='kai_analysis_saved' AND source_row_id=$2""",
            user_id,
            run_id,
        )


async def record_saved_analysis(
    load_pool: Callable, user_id: str, run_id: str, ticker: str, *, connection: Any = None
) -> None:
    """Read after acquiring the lock: a waiting statement's old snapshot is insufficient."""
    async with _analysis_transaction(load_pool, connection) as connection:
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            user_id + ":finance-analysis:" + run_id,
        )
        await connection.execute(
            """INSERT INTO feed_events(user_id,source_domain,event_type,actor_label,metadata,source_row_id,read_at)
               VALUES($1,'kai','kai_analysis_saved','Kai',$3::jsonb,$2,
                 CASE WHEN EXISTS(SELECT 1 FROM feed_events s WHERE s.user_id=$1 AND s.source_domain='kai'
                   AND s.event_type='kai_analysis_completed' AND s.source_row_id=$2
                   AND s.metadata->'finance_result_viewed'='true'::jsonb) THEN now() ELSE NULL END)
               ON CONFLICT(user_id,source_domain,event_type,source_row_id) WHERE source_row_id IS NOT NULL
               DO UPDATE SET read_at=COALESCE(feed_events.read_at,EXCLUDED.read_at)""",
            user_id,
            run_id,
            json.dumps({"run_id": run_id, "ticker": ticker}),
        )


def write_feed_event(
    *,
    get_db: Callable[[], Any],
    user_id: str,
    source_domain: str,
    event_type: str,
    actor_label: str | None,
    metadata: dict[str, Any],
    source_row_id: str | None,
    require_confirmation: bool,
) -> None:
    try:
        db = get_db()
        values = {
            "user_id": user_id,
            "source_domain": source_domain,
            "event_type": event_type,
            "actor_label": actor_label,
        }
        if source_row_id:
            db.execute_raw(
                """
                INSERT INTO feed_events (
                  user_id, source_domain, event_type, actor_label, metadata, source_row_id
                ) VALUES (
                  :user_id, :source_domain, :event_type, :actor_label,
                  CAST(:metadata_json AS JSONB), :source_row_id
                ) ON CONFLICT DO NOTHING
                """,
                {**values, "metadata_json": json.dumps(metadata), "source_row_id": source_row_id},
            )
        else:
            db.table("feed_events").insert({**values, "metadata": metadata}).execute()
    except Exception:
        logger.exception(
            "feed.record_event_failed domain=%s event_type=%s", source_domain, event_type
        )
        if require_confirmation:
            raise
