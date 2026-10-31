"""Document delivery activity: operations over the owning store transaction port."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    Activity,
    DeliveryError,
)

from .state import iso


def _enqueue_cleanup(connection, request_id, *, artifact_id=None, generation=None):
    connection.execute(
        text("""INSERT INTO document_delivery_cleanup
      (cleanup_id,request_id,bucket_identity,object_key,object_generation,upload_session_envelope,
       session_observed_at,write_dispatched_at,write_settled_at,ciphertext_bytes)
      SELECT gen_random_uuid(),request_id,bucket_identity,object_key,COALESCE(:generation,object_generation),
       upload_session_envelope,session_observed_at,write_dispatched_at,write_settled_at,(descriptor->>'ciphertextBytes')::int
      FROM document_delivery_artifacts WHERE request_id=:request
        AND (CAST(:artifact AS uuid) IS NULL OR artifact_id=CAST(:artifact AS uuid))
      ON CONFLICT(object_key) DO UPDATE SET
        object_generation=COALESCE(document_delivery_cleanup.object_generation,EXCLUDED.object_generation),
        upload_session_envelope=COALESCE(document_delivery_cleanup.upload_session_envelope,EXCLUDED.upload_session_envelope),
        session_observed_at=COALESCE(document_delivery_cleanup.session_observed_at,EXCLUDED.session_observed_at),
        write_dispatched_at=COALESCE(document_delivery_cleanup.write_dispatched_at,EXCLUDED.write_dispatched_at),
        write_settled_at=COALESCE(EXCLUDED.write_settled_at,document_delivery_cleanup.write_settled_at),
        status=CASE WHEN document_delivery_cleanup.status='removed' THEN 'pending' ELSE document_delivery_cleanup.status END,
        next_attempt_at=clock_timestamp()"""),
        {"request": request_id, "artifact": artifact_id, "generation": generation},
    )


def _audit(
    connection,
    *,
    request_id,
    actor,
    kind,
    artifact_id=None,
    interaction_id=None,
    event_id=None,
    outcome="success",
    provenance="server",
):
    interaction_id = interaction_id or str(uuid4())
    connection.execute(
        text("""INSERT INTO document_delivery_activity
      (request_id,interaction_id,event_id,artifact_id,provenance,kind,outcome,actor_user_id)
      VALUES(:request,:interaction,:event,:artifact,:provenance,:kind,:outcome,:actor)
      ON CONFLICT(request_id,event_id) DO NOTHING"""),
        {
            "request": request_id,
            "interaction": interaction_id,
            "event": event_id or str(uuid4()),
            "artifact": artifact_id,
            "provenance": provenance,
            "kind": kind,
            "outcome": outcome,
            "actor": actor,
        },
    )
    return interaction_id


async def record_activity(self, *, request_id, actor, body: Activity):
    def operation(connection):
        request, contract = self._locked(connection, request_id=request_id, actor=actor)
        if actor != contract["recipient_user_id"]:
            raise DeliveryError("recipient_required", 403)
        self._paid(connection, request, contract)
        interaction = self._row(
            connection,
            """SELECT 1 FROM document_delivery_activity WHERE request_id=:request
          AND interaction_id=:interaction AND actor_user_id=:actor AND kind='package_released'
          AND created_at>clock_timestamp()-INTERVAL '1 hour'""",
            {"request": request_id, "interaction": body.interactionId, "actor": actor},
        )
        artifact = self._row(
            connection,
            """SELECT file_ref FROM document_delivery_artifacts WHERE request_id=:request
          AND artifact_id=:artifact AND generation_id=:generation AND state='finalized'""",
            {
                "request": request_id,
                "artifact": body.artifactId,
                "generation": contract["generation_id"],
            },
        )
        if interaction is None or artifact is None:
            raise DeliveryError("activity_context_invalid", 422)
        self._audit(
            connection,
            request_id=request_id,
            actor=actor,
            kind=body.kind,
            artifact_id=body.artifactId,
            interaction_id=body.interactionId,
            event_id=body.eventId,
            outcome=body.outcome,
            provenance="client",
        )
        return {"recorded": True}

    return await self._transaction(operation)


async def activities(self, *, request_id, actor, cursor=0):
    def operation(connection):
        self._locked(connection, request_id=request_id, actor=actor)
        rows = (
            connection.execute(
                text("""SELECT * FROM document_delivery_activity WHERE request_id=:request
          AND sequence>:cursor AND created_at>clock_timestamp()-INTERVAL '90 days'
          ORDER BY sequence LIMIT 51"""),
                {"request": request_id, "cursor": cursor},
            )
            .mappings()
            .all()
        )
        return {
            "items": [
                {
                    "sequence": row["sequence"],
                    "interactionId": str(row["interaction_id"]),
                    "artifactId": str(row["artifact_id"]) if row["artifact_id"] else None,
                    "kind": row["kind"],
                    "provenance": row["provenance"],
                    "outcome": row["outcome"],
                    "actorUserId": row["actor_user_id"],
                    "createdAt": iso(row["created_at"]),
                }
                for row in rows[:50]
            ],
            "nextCursor": str(rows[49]["sequence"]) if len(rows) > 50 else None,
        }

    return await self._transaction(operation)


async def revoke(self, *, request_id, actor, body):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        replay = self._idempotent(
            connection, request_id, body.idempotencyKey, "revoke", body.wire()
        )
        if replay is not None:
            return replay
        self._revision(contract, body.expectedRevision)
        if body.scope in {"drive", "both"} and contract["receive_through"] != "both":
            raise DeliveryError("drive_channel_not_present", 422)
        if body.scope in {"one", "both"}:
            connection.execute(
                text("""UPDATE document_delivery_contracts SET status='revoked',
              hosted_revoked_at=COALESCE(hosted_revoked_at,clock_timestamp()),revision=revision+1,
              updated_at=clock_timestamp() WHERE request_id=:request"""),
                {"request": request_id},
            )
            self._enqueue_cleanup(connection, request_id)
            self._audit(connection, request_id=request_id, actor=actor, kind="hosted_revoked")
        if body.scope in {"drive", "both"}:
            # Removal requires exact managed provider receipts. This pending
            # state never claims Google access was removed by a local revoke.
            connection.execute(
                text(
                    "UPDATE document_delivery_contracts SET drive_revoke_status='pending' WHERE request_id=:request"
                ),
                {"request": request_id},
            )
            connection.execute(
                text("""UPDATE drive_share_requests SET
              access_stop_requested_at=COALESCE(access_stop_requested_at,clock_timestamp()),
              revocation_revision=revocation_revision+1,updated_at=clock_timestamp() WHERE request_id=:request"""),
                {"request": request_id},
            )
            connection.execute(
                text("""UPDATE drive_share_management_contexts SET
              revocation_revision=(SELECT revocation_revision FROM drive_share_requests WHERE request_id=:request)
              WHERE request_id=:request"""),
                {"request": request_id},
            )
            if body.scope == "drive":
                connection.execute(
                    text(
                        "UPDATE document_delivery_contracts SET revision=revision+1 WHERE request_id=:request"
                    ),
                    {"request": request_id},
                )
        request, current = self._locked(connection, request_id=request_id, actor=actor)
        self._notify_setup_changed(connection, request)
        return self._result(
            connection,
            request_id,
            body.idempotencyKey,
            self._projection(connection, request, current, actor),
        )

    return await self._transaction(operation)
