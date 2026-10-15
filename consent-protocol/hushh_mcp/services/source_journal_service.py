"""Owner-scoped replay of committed source change hints.

This stream contains no connector credentials or values. A caller must reread
the authoritative connector overview before updating encrypted owner memory.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db

MAX_PAGE_SIZE = 100
_STREAM_QUERY = {
    "connector": text("""SELECT last_sequence, first_retained_sequence
        FROM public.live_memory_connector_streams WHERE owner_hash=:owner_hash"""),
    "source": text("""SELECT last_sequence, first_retained_sequence
        FROM public.live_memory_source_streams WHERE owner_hash=:owner_hash"""),
}
_EVENT_QUERY = {
    "connector": text("""SELECT sequence, event_id, source_id, operation,
            schema_version, occurred_at FROM public.live_memory_connector_events
        WHERE owner_hash=:owner_hash AND sequence>:after AND sequence<=:head
        ORDER BY sequence LIMIT :limit"""),
    "source": text("""SELECT sequence, event_id, source_kind, operation,
            schema_version, occurred_at FROM public.live_memory_source_events
        WHERE owner_hash=:owner_hash AND sequence>:after AND sequence<=:head
        ORDER BY sequence LIMIT :limit"""),
}


class SourceJournalUnavailable(RuntimeError):
    """Storage could not establish a complete owner-scoped journal page."""


class SourceJournalService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def connector_events(
        self, *, user_id: str, after: int, limit: int = MAX_PAGE_SIZE
    ) -> dict[str, Any]:
        return await self._replay(user_id=user_id, after=after, limit=limit, family="connector")

    async def events(
        self, *, user_id: str, after: int, limit: int = MAX_PAGE_SIZE
    ) -> dict[str, Any]:
        return await self._replay(user_id=user_id, after=after, limit=limit, family="source")

    async def _replay(self, *, user_id: str, after: int, limit: int, family: str) -> dict[str, Any]:
        if not user_id or not 0 <= after <= 2**63 - 1 or not 1 <= limit <= MAX_PAGE_SIZE:
            raise ValueError("invalid source journal query")
        owner_hash = "sha256:" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()

        def read() -> dict[str, Any]:
            with self.db.engine.begin() as connection:
                # Head, floor and page must come from one committed snapshot.
                connection.execute(
                    text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                )
                connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                head = (
                    connection.execute(_STREAM_QUERY[family], {"owner_hash": owner_hash})
                    .mappings()
                    .first()
                )
                last = int(head["last_sequence"]) if head else 0
                first = int(head["first_retained_sequence"]) if head else 1
                earliest = first - 1

                def reset() -> dict[str, Any]:
                    return {
                        "events": [],
                        "nextCursor": str(after),
                        "headCursor": str(last),
                        "earliestCursor": str(earliest),
                        "resetRequired": True,
                        "hasMore": False,
                    }

                if after < earliest or after > last:
                    return reset()
                rows = (
                    connection.execute(
                        _EVENT_QUERY[family],
                        {
                            "owner_hash": owner_hash,
                            "after": after,
                            "head": last,
                            "limit": limit + 1,
                        },
                    )
                    .mappings()
                    .all()
                )
                page = rows[:limit]
                expected = after + 1
                for row in page:
                    if int(row["sequence"]) != expected:
                        return reset()
                    expected += 1
                # A short page before the captured head, or a gap at the next
                # row, must force a snapshot instead of silently advancing.
                if len(rows) > limit:
                    if int(rows[limit]["sequence"]) != expected:
                        return reset()
                elif expected - 1 != last:
                    return reset()
                events = [
                    {
                        "sequence": str(row["sequence"]),
                        "eventId": str(row["event_id"]),
                        ("sourceId" if family == "connector" else "sourceKind"): row[
                            "source_id" if family == "connector" else "source_kind"
                        ],
                        "operation": row["operation"],
                        "schemaVersion": row["schema_version"],
                        "occurredAt": row["occurred_at"].isoformat(),
                    }
                    for row in page
                ]
                return {
                    "events": events,
                    "nextCursor": events[-1]["sequence"] if events else str(after),
                    "headCursor": str(last),
                    "earliestCursor": str(earliest),
                    "resetRequired": False,
                    "hasMore": bool(len(rows) > limit),
                }

        try:
            return await asyncio.to_thread(read)
        except SQLAlchemyError:
            raise SourceJournalUnavailable("source journal unavailable") from None
