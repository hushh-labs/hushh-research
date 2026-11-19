"""Optimistic Feed receipts: acknowledge only the material state actually fetched.

Time and a maximum ID alone cannot fence a transaction that started before the
fetch but committed afterwards. Content versions also survive mutable same-ID
producer updates, without persisting a second activity store.
"""

from datetime import datetime, timezone
from typing import Any


def row_version_sql(alias: str) -> str:
    if alias not in {"f", "item"}:
        raise ValueError("Invalid Feed snapshot alias")
    return f"""md5(jsonb_build_array({alias}.id,{alias}.source_domain,{alias}.event_type,
      {alias}.actor_label,{alias}.source_row_id,EXTRACT(EPOCH FROM {alias}.created_at),
      {alias}.metadata)::text)"""


SNAPSHOT_FINGERPRINT_SQL = f"""(SELECT md5(COALESCE(string_agg({row_version_sql("f")},'' ORDER BY f.id),''))
  FROM feed_events f WHERE f.user_id=:user_id)"""


def guarded_acknowledgment_sql(*, clear: bool) -> str:
    """The per-row comparison also catches a writer committing during UPDATE's wait."""
    assignment = "read_at=COALESCE(item.read_at,clock_timestamp())"
    if clear:
        assignment += ",dismissed_at=clock_timestamp(),dismissal_token=:dismissal_token"
    return f"""WITH observed AS MATERIALIZED (
      SELECT f.id,{row_version_sql("f")} AS version FROM feed_events f
      WHERE f.user_id=:user_id AND (f.id<=:up_to_id OR f.id=ANY(CAST(:surfacing_ids AS BIGINT[])))
    ), valid AS (
      SELECT md5(COALESCE(string_agg(version,'' ORDER BY id) FILTER(WHERE id<=:up_to_id),''))
        =:snapshot_fingerprint AS matches FROM observed
    ) UPDATE feed_events item SET {assignment} FROM observed,valid
      WHERE valid.matches AND item.user_id=:user_id AND item.id=observed.id
        AND {row_version_sql("item")}=observed.version
        AND (CAST(:through_time AS timestamptz) IS NULL OR item.created_at<=:through_time)
      RETURNING CAST(EXTRACT(EPOCH FROM item.dismissed_at)*1000000 AS BIGINT)::text AS clear_version"""


def mark_read_snapshot(
    db: Any,
    user_id: str,
    *,
    up_to_id: int,
    through_time: datetime | None = None,
    snapshot_fingerprint: str | None = None,
) -> dict[str, Any]:
    """Acknowledge a fetched state; older clients retain their bounded time fence."""
    if snapshot_fingerprint is not None:
        db.execute_raw(
            guarded_acknowledgment_sql(clear=False),
            {
                "user_id": user_id,
                "up_to_id": up_to_id,
                "through_time": through_time,
                "snapshot_fingerprint": snapshot_fingerprint,
                "surfacing_ids": [],
            },
        )
        return {"status": "ok"}
    now_iso = datetime.now(tz=timezone.utc).isoformat()
    query = (
        db.table("feed_events")
        .update({"read_at": now_iso})
        .eq("user_id", user_id)
        .is_("read_at", None)
    )
    query = query.lte("id", up_to_id)
    if through_time is not None:
        # An existing source row can receive a newer material update after
        # the viewer's fetch. Never acknowledge that unseen revision.
        query = query.lte("created_at", through_time.isoformat())
    query.execute()
    return {"status": "ok"}
