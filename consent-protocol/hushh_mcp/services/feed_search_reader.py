"""Read-only ranked search over the existing grouped Feed authority."""

import json
from datetime import datetime
from typing import TYPE_CHECKING, Any

from hushh_mcp.services.feed_search_contract import (
    FeedSearchError,
    criteria_key,
    decode_cursor,
    encode_cursor,
    normalized,
    typo_suggestion,
)
from hushh_mcp.services.feed_search_query import search_sql, suggestion_sql

if TYPE_CHECKING:
    from hushh_mcp.services.feed_activity_reader import FeedActivityReader


def search_history(
    reader: "FeedActivityReader",
    user_id: str,
    *,
    query: str = "",
    person: str = "",
    agent: str | None = None,
    scope: str | None = None,
    persona: str = "investor",
    from_at: datetime | None = None,
    before_at: datetime | None = None,
    cursor: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    values = {
        "query": normalized(query),
        "person": normalized(person),
        "agent": agent,
        "scope": scope,
        "persona": persona,
        "from_at": from_at,
        "before_at": before_at,
    }
    if query.strip() and not values["query"]:
        return {"items": [], "next_cursor": None, "top_hit": None, "suggestion": None}
    key = criteria_key(user_id, values)
    boundary = decode_cursor(cursor, key)
    maximum = reader._db.execute_raw(
        "SELECT COALESCE(max(id),0) AS id FROM feed_events WHERE user_id=:user_id",
        {"user_id": user_id},
    ).data
    snapshot = boundary["snapshot"] if boundary else int(maximum[0]["id"])
    size = max(1, min(limit, reader._max_limit))
    params = {
        **values,
        "user_id": user_id,
        "snapshot_id": snapshot,
        "terms": json.dumps(values["query"].split()),
        "page_size": size + 1,
        "after_rank": boundary["rank"] if boundary else None,
        "after_time": boundary["at"] if boundary else None,
        "after_id": boundary["id"] if boundary else None,
    }
    result = reader._db.execute_raw(search_sql(reader._cte), params).data or []
    if boundary and result and result[0]["search_revision"] != boundary["revision"]:
        raise FeedSearchError("Activity changed. Start again.")
    rows = [row for row in result if row.get("id") is not None]
    more = len(rows) > size
    page = rows[:size]
    shown = reader._present(user_id, page)
    items = [reader._item(row, user_id) for row in shown]
    top = (
        items[0]
        if cursor is None
        and page
        and page[0]["search_rank"] >= 100
        and (len(rows) == 1 or rows[1]["search_rank"] < page[0]["search_rank"])
        else None
    )
    suggestion = None
    if not rows and values["query"] and not cursor:
        labels = reader._db.execute_raw(suggestion_sql(reader._cte), params).data or []
        suggestion = typo_suggestion(query, [str(row["label"]) for row in labels])
    return {
        "items": items,
        "next_cursor": encode_cursor(page[-1], key, snapshot) if more else None,
        "top_hit": {"kind": "activity", "item": top} if top else None,
        "suggestion": suggestion,
    }
