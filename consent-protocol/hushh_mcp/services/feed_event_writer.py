"""Existing Feed event persistence port; no source workflow or report mutation."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger("hushh_mcp.services.feed_service")


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
