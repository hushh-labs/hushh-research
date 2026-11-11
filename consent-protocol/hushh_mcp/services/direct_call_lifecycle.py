"""Transaction-owned call expiration and erasure, independent of admission flags."""

from sqlalchemy import text


def clear_call(conn, call_id: str) -> None:
    params = {"id": call_id}
    conn.execute(
        text("DELETE FROM direct_call_voip_outbox WHERE call_id=CAST(:id AS UUID)"), params
    )
    conn.execute(text("DELETE FROM direct_call_signals WHERE call_id=CAST(:id AS UUID)"), params)
    conn.execute(text("DELETE FROM direct_call_slots WHERE call_id=CAST(:id AS UUID)"), params)
    conn.execute(
        text(
            "UPDATE direct_calls SET offers='[]',caller_proof='{}',"
            "caller_seen_at=NULL,callee_seen_at=NULL WHERE id=CAST(:id AS UUID)"
        ),
        params,
    )


def expire_call(conn, row: dict) -> dict:
    """Caller holds the call lock and commits this terminal result, not an error."""
    updated = dict(
        conn.execute(
            text("""UPDATE direct_calls SET state=CASE WHEN state IN
          ('preparing','ringing','connecting','active') THEN 'expired' ELSE state END,
          expires_at=LEAST(expires_at,clock_timestamp()),revision=revision+1
          WHERE id=CAST(:id AS UUID) RETURNING *"""),
            {"id": str(row["id"])},
        )
        .mappings()
        .one()
    )
    clear_call(conn, str(row["id"]))
    updated.update(
        offers=[],
        caller_proof={},
        caller_seen_at=None,
        callee_seen_at=None,
        peer_display_name=row.get("peer_display_name"),
    )
    return updated
