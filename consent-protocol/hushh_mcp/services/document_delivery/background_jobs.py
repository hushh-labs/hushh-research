"""Durable bounded job/chunk custody over the background store authority port."""

import json
import secrets
from uuid import UUID, uuid4, uuid5

from sqlalchemy import text

from hushh_mcp.services.document_delivery.background_consent import VERSION
from hushh_mcp.services.document_delivery.contracts import DeliveryError, digest
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content
from hushh_mcp.services.stripe_mode import configured_stripe_mode


def candidates(connection, limit):
    # Scheduling preselection only. Locked authority() remains the publication,
    # consent and payment decision; terminal old rows cannot consume every slot.
    return (
        connection.execute(
            text("""SELECT r.user_id,r.request_id,b.share_id,f.position
          FROM document_delivery_background_requests c JOIN drive_share_requests r USING(request_id)
          JOIN user_external_connector_connections g ON g.user_id=r.user_id
            AND g.connector_id='google_drive' AND g.status='connected'
            AND g.connection_generation=c.connection_generation
          JOIN drive_bulk_shares b ON b.origin_request_id=r.request_id AND b.approved_at IS NOT NULL
            AND b.stopped_at IS NULL AND b.connection_generation=c.connection_generation
          JOIN drive_bulk_share_files f ON f.share_id=b.share_id
          JOIN drive_bulk_share_effects e ON e.share_id=f.share_id AND e.position=f.position
            AND e.recipient_user_id=r.recipient_user_id AND e.state IN ('succeeded','preexisting')
          WHERE c.revoked_at IS NULL AND c.consent_version=:version
            AND r.access_stop_requested_at IS NULL AND r.approval_invalidated_at IS NULL
            AND (r.access_expires_at IS NULL OR r.access_expires_at>clock_timestamp())
            AND r.status NOT IN ('cancelled','declined','expired','no_match')
            AND EXISTS(SELECT 1 FROM connections pair WHERE pair.status='active'
              AND ((pair.user_a_id=r.user_id AND pair.user_b_id=r.recipient_user_id)
                OR (pair.user_b_id=r.user_id AND pair.user_a_id=r.recipient_user_id)))
            AND (NOT r.payment_required OR EXISTS(SELECT 1 FROM drive_request_payment_orders o
              WHERE o.request_id=r.request_id AND o.status='paid' AND o.paid_at IS NOT NULL
                AND NOT o.reconciliation_required AND o.stripe_mode=:stripe_mode))
            AND NOT EXISTS(SELECT 1 FROM drive_request_payment_refunds refund
              WHERE refund.request_id=r.request_id AND refund.status NOT IN ('failed','cancelled'))
            AND NOT EXISTS(SELECT 1 FROM document_delivery_background_files x
              WHERE x.request_id=r.request_id AND x.share_id=b.share_id AND x.position=f.position)
          ORDER BY r.created_at,b.created_at,f.position LIMIT :limit"""),
            {"limit": limit, "version": VERSION, "stripe_mode": configured_stripe_mode()},
        )
        .mappings()
        .all()
    )


class BackgroundCopyJobs:
    async def enroll(self, limit):
        def operation(connection):
            if not self.ready(connection):
                return
            rows = candidates(connection, limit)
            for item in rows:
                try:
                    with connection.begin_nested():
                        request, contract = self.authority(
                            connection, str(item["request_id"]), item["user_id"]
                        )
                        source = self._row(
                            connection,
                            "SELECT * FROM drive_bulk_share_files WHERE share_id=:share AND position=:position",
                            {"share": item["share_id"], "position": item["position"]},
                        )
                        metadata = DriveBulkShareStore(
                            db=self.db, cipher=self.sharing_cipher
                        )._file(source, item["user_id"])
                        ref = str(
                            uuid5(
                                UUID(str(item["request_id"])),
                                f"background-v2:{item['share_id']}:{item['position']}",
                            )
                        )

                        def seal(value, purpose, owner=item["user_id"], identity=ref):
                            return json.dumps(
                                self.sharing_cipher.seal(
                                    value, user_id=owner, resource_id=identity, purpose=purpose
                                )
                            )

                        connection.execute(
                            text("""INSERT INTO document_delivery_background_files
                          (file_ref,request_id,share_id,position,connection_generation,source_digest,source_envelope,key_envelope)
                          VALUES(:ref,:request,:share,:position,:generation,:digest,CAST(:source AS jsonb),CAST(:key AS jsonb))
                          ON CONFLICT(request_id,share_id,position) DO NOTHING"""),
                            {
                                "ref": ref,
                                "request": item["request_id"],
                                "share": item["share_id"],
                                "position": item["position"],
                                "generation": contract["connection_generation"],
                                "digest": digest(metadata),
                                "source": seal(metadata, "background-copy-source-v2"),
                                "key": seal(
                                    {"key": secrets.token_hex(32)}, "background-copy-key-v2"
                                ),
                            },
                        )
                except (DeliveryError, DriveReadError, PermissionError):
                    continue

        await self._transaction(operation)

    async def claim(self):
        def operation(connection):
            row = self._row(
                connection,
                """WITH due AS (SELECT file_ref FROM document_delivery_background_files
              WHERE state='preparing' AND next_at<=clock_timestamp()
                AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
              ORDER BY next_at,file_ref LIMIT 1 FOR UPDATE SKIP LOCKED)
              UPDATE document_delivery_background_files f SET lease_id=:lease,
                lease_expires_at=clock_timestamp()+INTERVAL '90 seconds',next_at=clock_timestamp()+INTERVAL '2 minutes'
              FROM due WHERE f.file_ref=due.file_ref RETURNING f.*, (SELECT user_id FROM drive_share_requests r WHERE r.request_id=f.request_id) AS owner_user_id""",
                {"lease": str(uuid4())},
            )
            return row

        return await self._transaction(operation)

    async def chunks(self, row):
        return await self._transaction(
            lambda c: [
                dict(x)
                for x in c.execute(
                    text(
                        "SELECT * FROM document_delivery_background_chunks WHERE file_ref=:ref ORDER BY ordinal"
                    ),
                    {"ref": row["file_ref"]},
                ).mappings()
            ]
        )

    async def begin_verification(self, row):
        def operation(connection):
            self.file_authority(connection, row, self.owner(row), lease=True)
            result = self._row(
                connection,
                """UPDATE document_delivery_background_files
              SET verification_attempts=verification_attempts+1 WHERE file_ref=:ref AND verification_attempts<3
              RETURNING verification_attempts""",
                {"ref": row["file_ref"]},
            )
            if result is None:
                raise DeliveryError("verification_budget_exhausted")
            return result["verification_attempts"]

        return await self._transaction(operation)

    async def finish(self, row, *, result=None, reason=None, retry=False):
        def operation(connection):
            request, current = self.file_authority(connection, row, self.owner(row), lease=True)
            state = (
                "ready"
                if result
                else "preparing"
                if retry and current["failures"] < 3
                else "unavailable"
            )
            envelope = (
                self.sharing_cipher.seal(
                    result,
                    user_id=self.owner(row),
                    resource_id=str(row["file_ref"]),
                    purpose="background-copy-result-v2",
                )
                if result
                else None
            )
            connection.execute(
                text("""UPDATE document_delivery_background_files SET state=:state,reason=:reason,
              result_envelope=CAST(:result AS jsonb),lease_id=NULL,lease_expires_at=NULL,failures=failures+:failure,
              next_at=clock_timestamp()+INTERVAL '1 minute' WHERE file_ref=:ref"""),
                {
                    "ref": row["file_ref"],
                    "state": state,
                    "reason": reason,
                    "result": json.dumps(envelope) if envelope else None,
                    "failure": int(reason is not None),
                },
            )
            if state == "unavailable":
                self.retire(connection, row["file_ref"])
            if result:
                self.audit(connection, request, self.owner(row), "copy_ready", row["file_ref"])

        await admit_hub_content(self.owner(row), "drive_one_copy")
        await self._transaction(operation)

    @staticmethod
    def retire(connection, ref):
        connection.execute(
            text("""UPDATE document_delivery_cleanup SET status='pending',held_by_background=FALSE,next_attempt_at=clock_timestamp()
          WHERE object_key IN (SELECT object_key FROM document_delivery_background_chunks WHERE file_ref=:ref)
          AND status<>'removed'"""),
            {"ref": ref},
        )

    @staticmethod
    def audit(connection, request, actor, kind, ref=None):
        connection.execute(
            text("""INSERT INTO document_delivery_background_activity(request_id,file_ref,actor_user_id,kind)
          VALUES(:request,:ref,:actor,:kind)"""),
            {"request": request["request_id"], "ref": ref, "actor": actor, "kind": kind},
        )
