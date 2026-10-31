"""Retired ciphertext and metadata reconciliation through the existing store port."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text


def _retire_contracts(self, connection, limit):
    contracts = (
        connection.execute(
            text("""SELECT request_id,owner_user_id,recipient_user_id FROM document_delivery_contracts
      WHERE (access_expires_at<=clock_timestamp() AND status NOT IN ('expired','erasing','revoked'))
        OR (status IN ('expired','erasing','revoked') AND
          (current_package_id IS NOT NULL OR selection_envelope IS NOT NULL OR EXISTS(
            SELECT 1 FROM document_delivery_idempotency i WHERE i.request_id=document_delivery_contracts.request_id)))
      ORDER BY access_expires_at LIMIT :limit"""),
            {"limit": limit},
        )
        .mappings()
        .all()
    )
    from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

    lock_connection_graph_users(
        connection,
        user_ids=sorted(
            {row[key] for row in contracts for key in ("owner_user_id", "recipient_user_id")}
        ),
    )
    for item in contracts:
        request, contract = self.store._locked(
            connection,
            request_id=str(item["request_id"]),
            actor=item["owner_user_id"],
            owner_only=True,
        )
        if contract["access_expires_at"] > datetime.now(UTC) and contract["status"] not in {
            "expired",
            "erasing",
            "revoked",
        }:
            continue
        self.store._enqueue_cleanup(connection, str(item["request_id"]))
        connection.execute(
            text(
                "UPDATE document_delivery_contracts SET status=CASE WHEN status IN ('revoked','erasing') THEN status ELSE 'expired' END, current_package_id=NULL,selection_envelope=NULL,source_selection_digest=NULL,preparation_digest=NULL WHERE request_id=:request"
            ),
            {"request": item["request_id"]},
        )
        for statement in (
            "DELETE FROM document_delivery_packages WHERE request_id=:request",
            "DELETE FROM document_delivery_key_challenges WHERE request_id=:request",
            "DELETE FROM document_delivery_idempotency WHERE request_id=:request",
        ):
            connection.execute(
                text(statement),
                {"request": item["request_id"]},
            )


def _claim_cleanup(self, connection, limit):
    connection.execute(
        text(
            "DELETE FROM document_delivery_activity WHERE sequence IN (SELECT sequence FROM document_delivery_activity WHERE created_at<clock_timestamp()-INTERVAL '90 days' ORDER BY sequence LIMIT 500)"
        )
    )
    connection.execute(
        text(
            "DELETE FROM document_delivery_key_challenges WHERE challenge_id IN (SELECT challenge_id FROM document_delivery_key_challenges WHERE expires_at<clock_timestamp()-INTERVAL '1 day' ORDER BY expires_at LIMIT 100)"
        )
    )
    _retire_contracts(self, connection, limit)
    # Superseded and incomplete generations are also reconciled.
    orphaned = (
        connection.execute(
            text("""SELECT a.artifact_id,a.request_id
      FROM document_delivery_artifacts a JOIN document_delivery_contracts c ON c.request_id=a.request_id
      WHERE a.expires_at<=clock_timestamp() AND (a.state<>'finalized' OR a.generation_id<>c.generation_id)
      AND a.state<>'deleted' ORDER BY a.expires_at LIMIT :limit"""),
            {"limit": limit},
        )
        .mappings()
        .all()
    )
    for artifact in orphaned:
        self.store._enqueue_cleanup(
            connection,
            str(artifact["request_id"]),
            artifact_id=str(artifact["artifact_id"]),
        )
    return [
        dict(row)
        for row in connection.execute(
            text("""WITH due AS (
      SELECT cleanup_id FROM document_delivery_cleanup WHERE status IN ('pending','unknown')
      AND next_attempt_at<=clock_timestamp() AND NOT COALESCE((to_jsonb(document_delivery_cleanup)->>'held_by_background')::boolean,FALSE) ORDER BY next_attempt_at LIMIT :limit FOR UPDATE SKIP LOCKED)
      UPDATE document_delivery_cleanup c SET attempts=attempts+1,status='unknown',
      next_attempt_at=clock_timestamp()+INTERVAL '2 minutes' FROM due
      WHERE c.cleanup_id=due.cleanup_id RETURNING c.*"""),
            {"limit": limit},
        ).mappings()
    ]


async def cleanup(self, *, limit=10):
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("invalid cleanup bound")

    rows = await self.store._transaction(lambda connection: _claim_cleanup(self, connection, limit))
    removed = 0
    for row in rows:
        if row["bucket_identity"] != self.objects.identity:
            continue
        try:
            if row["write_dispatched_at"] is not None and row["write_settled_at"] is None:
                session = self.store.upload_session(row)
                if session is None or not await self.objects.session_terminal(
                    session,
                    row["object_key"],
                    row["ciphertext_bytes"],
                    row["session_observed_at"],
                ):
                    continue
            await self.objects.remove(row["object_key"], row["object_generation"])
        except Exception:
            continue

        def finish(connection, row=row):
            connection.execute(
                text("""UPDATE document_delivery_cleanup SET status='removed',removed_at=clock_timestamp()
              WHERE cleanup_id=:id AND status='unknown'"""),
                {"id": row["cleanup_id"]},
            )
            connection.execute(
                text(
                    "UPDATE document_delivery_artifacts SET state='deleted' WHERE object_key=:key"
                ),
                {"key": row["object_key"]},
            )

        await self.store._transaction(finish)
        removed += 1
    return {
        "schema_version": "document.delivery.cleanup.v1",
        "outcomes": {"removed": removed, "pending": len(rows) - removed},
    }
