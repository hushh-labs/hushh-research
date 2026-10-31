"""Find retained attempt matches before reading live registered identities.

The index selects candidates only. The audience reader still applies current
identity, deletion, reporting, generation, action-contract and status checks.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from types import SimpleNamespace

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool
from hushh_mcp.services.plg_audience_identity import captured_records
from hushh_mcp.services.plg_catalog import activity_catalog

SEGMENTS = frozenset(
    {"failed", "blocked", "cancelled", "returned", "possible_incomplete", "in_progress"}
)
PREFIX = "attempts:"

CANDIDATES_SQL = """
WITH attempts AS (
  SELECT o.user_id COLLATE "C" AS user_id,
    MIN(o.observed_at) FILTER (WHERE o.phase='started') AS started_at,
    (ARRAY_AGG(o.phase ORDER BY o.observed_at DESC,o.phase)
      FILTER (WHERE o.phase<>'started'))[1] AS terminal
  FROM one_product_activity_observations o
  JOIN one_product_activity_epochs e
    ON e.user_id=o.user_id AND e.generation=o.generation
  JOIN UNNEST($6::text[],$7::text[]) AS allowed(action_id,source)
    ON allowed.action_id=o.action_id AND allowed.source=o.source
  WHERE o.agent_id=$1 AND o.observed_at >= $2 AND o.observed_at <= $3
    AND o.expires_at > $3 AND o.user_id COLLATE "C" > $4 COLLATE "C"
    AND o.operation_key IS NOT NULL
  GROUP BY o.user_id,o.action_id,o.source,o.operation_key
)
SELECT DISTINCT user_id FROM attempts
WHERE CASE $8::text
  WHEN 'possible_incomplete' THEN terminal IS NULL AND started_at <= $5
  WHEN 'in_progress' THEN terminal IS NULL AND started_at > $5
  ELSE terminal=$8 END
ORDER BY user_id LIMIT $9
"""


def registered_records(ids: list[str]):
    from firebase_admin import auth

    app = get_firebase_auth_app()
    if app is None or app.project_id != "hushh-pda":
        raise RuntimeError("audience identity source unavailable")

    def lookup(identities):
        return auth.get_users([auth.UidIdentifier(uid) for uid in identities], app=app).users

    return captured_records(ids, lookup)


async def source_page(request, page: str | None, at, size: int):
    """Bound each indexed read and preserve continuation through excluded rows."""
    if request.segment not in SEGMENTS or not 1 <= size <= 25:
        raise ValueError("unsupported attempt search")
    if page is not None and (
        not page.startswith(PREFIX) or not 1 <= len(page.removeprefix(PREFIX)) <= 128
    ):
        raise ValueError("refresh the activity search after a source change")
    actions = [
        action
        for action in activity_catalog()["actions"]
        if action["agentId"] == request.agentId and action["kind"] != "tool"
    ]
    if not actions:
        return SimpleNamespace(users=[], next_page_token=None)
    pool = await get_pool()
    async with pool.acquire(timeout=3) as conn, conn.transaction(readonly=True):
        await conn.execute("SET LOCAL statement_timeout='5s'")
        rows = await conn.fetch(
            CANDIDATES_SQL,
            request.agentId,
            at - timedelta(days=7),
            at,
            page.removeprefix(PREFIX) if page else "",
            at - timedelta(minutes=request.graceMinutes),
            [action["id"] for action in actions],
            [action["proof"] for action in actions],
            request.segment,
            size + 1,
            timeout=5,
        )
    ids = [row["user_id"] for row in rows]
    if (
        len(ids) > size + 1
        or ids != sorted(set(ids))
        or any(not isinstance(uid, str) or not 1 <= len(uid) <= 128 for uid in ids)
    ):
        raise ValueError("invalid attempt search result")
    selected = ids[:size]
    records = (
        await asyncio.wait_for(asyncio.to_thread(registered_records, selected), timeout=6)
        if selected
        else []
    )
    if len(records) > len(selected) or any(row.uid not in selected for row in records):
        raise ValueError("invalid registered identity result")
    return SimpleNamespace(
        users=records,
        scanned=len(selected),
        next_page_token=PREFIX + selected[-1] if len(ids) > size else None,
    )
