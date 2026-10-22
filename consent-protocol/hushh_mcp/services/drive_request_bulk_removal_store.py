"""Request-wide removal of direct Drive ACLs created by bulk sharing.

The confirmed stop flag is the authority. The original successful creation
receipt is the provenance; a matching Google ACL alone is never sufficient.
Late grant receipts are picked up by the next bounded materialization sweep.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import (
    RECONCILED_CREATE_PROVENANCE,
    DriveBulkShareStore,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import FILE_ID

# A confirmed create, or the exact requested grant that read-only
# reconciliation found after Google answered the create with
# invalidSharingRequest (which can follow a real share). Nothing else is One's.
MANAGED_CREATE_PROVENANCES = frozenset(
    {"successful_create_after_absence_check", RECONCILED_CREATE_PROVENANCE}
)
# Sealed inside a removal plan when the owner removed access to one file from
# their shared-files list. That explicit owner action, not a request-wide Stop,
# is the removal's authority. Only server code can write a sealed plan.
OWNER_FILE_REMOVAL_SCOPE = "owner_file"


def managed_bulk_plan(*, receipt: dict, file: dict, recipient: dict) -> dict | None:
    """Return a delete plan only for an authenticated successful create receipt."""
    issuer = receipt.get("issuer")
    permission_id = receipt.get("permission_id")
    email = receipt.get("email")
    if (
        receipt.get("managed") is not True
        or receipt.get("provenance") not in MANAGED_CREATE_PROVENANCES
        or not isinstance(issuer, dict)
        or not isinstance(issuer.get("subject"), str)
        or not isinstance(issuer.get("oauthClientId"), str)
        or not issuer["subject"]
        or not issuer["oauthClientId"]
        or not isinstance(permission_id, str)
        or not FILE_ID.fullmatch(permission_id)
        or not isinstance(email, str)
        or not isinstance(recipient.get("email"), str)
        or email.casefold() != recipient.get("email", "").casefold()
        or not isinstance(file.get("id"), str)
        or not FILE_ID.fullmatch(file["id"])
    ):
        return None
    return {
        "file_id": file["id"],
        "resource_key": file.get("resourceKey"),
        "permission_id": permission_id,
        "recipient_email": email,
        "issuer": issuer,
        **(
            {"expiration_time": receipt["expiration_time"]}
            if receipt.get("expiration_time")
            else {}
        ),
    }


class DriveRequestBulkRemovalStore(DriveBulkShareStore):
    @staticmethod
    def _expire_due(connection, *, limit: int, v1_only: bool = False) -> None:
        # Google expires each granted ACL natively. Recovery also closes local
        # authority and records removal/absence through the same provenance-safe
        # queue used by an owner's earlier Stop. No unauthenticated ACL is deleted.
        connection.execute(
            text("""WITH due AS (
            SELECT request_id FROM drive_share_requests
            WHERE access_expires_at<=clock_timestamp() AND access_stop_requested_at IS NULL
              AND (:v1_only=FALSE OR v1_live_request=TRUE)
            ORDER BY access_expires_at,request_id LIMIT :limit FOR UPDATE SKIP LOCKED
          ) UPDATE drive_share_requests r SET access_stop_requested_at=clock_timestamp(),
              status=CASE WHEN r.status IN ('pending','approved') THEN 'partial' ELSE r.status END,
              updated_at=clock_timestamp()
            FROM due WHERE r.request_id=due.request_id"""),
            {"limit": limit, "v1_only": v1_only},
        )

    def _materialize(self, connection, *, limit: int, v1_only: bool = False) -> int:
        # The source effect is locked while its successful receipt is copied.
        # No private Drive identifier or email enters the queue in plaintext.
        rows = connection.execute(
            text("""SELECT e.*, f.metadata_envelope, f.source_job_id,
                 f.source_position, r.identity_envelope, b.origin_request_id,
                 b.v1_statement_search
              FROM drive_bulk_share_effects e
              JOIN drive_bulk_shares b ON b.share_id=e.share_id
              JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
              JOIN drive_bulk_share_recipients r ON r.share_id=e.share_id
                AND r.recipient_user_id=e.recipient_user_id
              JOIN drive_share_requests request ON request.request_id=b.origin_request_id
              WHERE request.access_stop_requested_at IS NOT NULL
                AND request.user_id=e.user_id AND e.state='succeeded'
                AND e.receipt_envelope IS NOT NULL
                AND (:v1_only = FALSE OR (
                  b.v1_statement_search=TRUE
                  AND b.origin_request_id IS NOT NULL
                  AND b.progressive_batch=TRUE
                  AND b.approval_source IN ('owner','trusted_auto') AND b.approved_at IS NOT NULL))
                AND NOT EXISTS (SELECT 1 FROM drive_request_bulk_removals removal
                  WHERE removal.share_id=e.share_id AND removal.position=e.position
                    AND removal.recipient_user_id=e.recipient_user_id)
              ORDER BY e.updated_at,e.share_id,e.position
              LIMIT :limit FOR UPDATE OF e SKIP LOCKED"""),
            {"limit": limit, "v1_only": v1_only},
        ).mappings()
        count = 0
        for row in rows:
            item = dict(row)
            share_id = str(item["share_id"])
            recipient_id = item["recipient_user_id"]
            try:
                receipt = self._open(
                    item["receipt_envelope"],
                    user_id=item["user_id"],
                    resource_id=f"{share_id}:{item['position']}:{recipient_id}",
                    purpose="bulk-share-receipt",
                )
                file = self._file(item, item["user_id"])
                recipient = self._open(
                    item["identity_envelope"],
                    user_id=item["user_id"],
                    resource_id=f"{share_id}:{recipient_id}",
                    purpose="bulk-share-recipient",
                )
                plan = managed_bulk_plan(receipt=receipt, file=file, recipient=recipient)
            except (DriveSharingError, TypeError, ValueError):
                plan = None
            # An unattributed receipt never authorizes deletion, but recording
            # its terminal review state keeps Stop from appearing to hang.
            state = "queued" if plan is not None else "needs_review"
            removal_id = str(uuid4())
            envelope = self.cipher.seal(
                plan or {},
                user_id=item["user_id"],
                resource_id=removal_id,
                purpose="bulk-removal-plan",
            )
            connection.execute(
                text("""INSERT INTO drive_request_bulk_removals
                  (removal_id,request_id,user_id,share_id,position,recipient_user_id,
                   plan_envelope,state,v1_statement_search)
                  VALUES (:id,:request,:user,:share,:position,:recipient,
                    CAST(:plan AS jsonb),:state,:v1)
                  ON CONFLICT (share_id,position,recipient_user_id) DO NOTHING"""),
                {
                    "id": removal_id,
                    "request": item["origin_request_id"],
                    "user": item["user_id"],
                    "share": item["share_id"],
                    "position": item["position"],
                    "recipient": recipient_id,
                    "plan": json.dumps(envelope),
                    "state": state,
                    "v1": item["v1_statement_search"],
                },
            )
            count += 1
        return count

    async def materialize(self, *, limit: int = 100, v1_only: bool = False) -> int:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("invalid bulk removal limit")
        if type(v1_only) is not bool:
            raise ValueError("invalid bulk removal mode")
        # Release request expiry locks before locking effects (settle takes
        # effect then request); retries can safely resume between transactions.
        await self._transaction(
            lambda connection: self._expire_due(connection, limit=limit, v1_only=v1_only)
        )
        return await self._transaction(
            lambda connection: self._materialize(connection, limit=limit, v1_only=v1_only)
        )

    def _plan(self, row):
        return self.cipher.open(
            row["plan_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["removal_id"]),
            purpose="bulk-removal-plan",
        )

    async def due(self, *, limit: int = 20, v1_only: bool = False) -> list[dict]:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("invalid bulk removal limit")
        if type(v1_only) is not bool:
            raise ValueError("invalid bulk removal mode")

        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""SELECT removal_id,user_id,state FROM drive_request_bulk_removals
                      WHERE state IN ('queued','dispatching','unknown')
                        AND (:v1_only = FALSE OR v1_statement_search=TRUE)
                        AND next_at<=clock_timestamp()
                        AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
                      ORDER BY next_at,created_at,removal_id LIMIT :limit"""),
                    {"limit": limit, "v1_only": v1_only},
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim(self, *, user_id: str, removal_id: str, v1_only: bool = False) -> dict | None:
        identifier = str(UUID(removal_id))
        if type(v1_only) is not bool:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            row = self._row(
                connection,
                """SELECT * FROM drive_request_bulk_removals
                  WHERE removal_id=:id AND user_id=:user
                    AND (:v1_only = FALSE OR v1_statement_search=TRUE) FOR UPDATE""",
                {"id": identifier, "user": user_id, "v1_only": v1_only},
            )
            if row is None or row["state"] not in {"queued", "dispatching", "unknown"}:
                return None
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if row["next_at"] > now or row["lease_expires_at"] and row["lease_expires_at"] > now:
                return None
            request = self._row(
                connection,
                """SELECT access_stop_requested_at FROM drive_share_requests
                  WHERE request_id=:request AND user_id=:user""",
                {"request": row["request_id"], "user": user_id},
            )
            if (
                request is not None
                and request["access_stop_requested_at"] is None
                and self._plan(row).get("scope") != OWNER_FILE_REMOVAL_SCOPE
            ):
                raise DriveSharingError("approval_superseded")
            lease = str(uuid4())
            state = "queued" if row["state"] == "queued" else "unknown"
            updated = self._row(
                connection,
                """UPDATE drive_request_bulk_removals SET state=:state,lease_id=:lease,
                  lease_expires_at=clock_timestamp()+INTERVAL '90 seconds',
                  attempts=LEAST(attempts+1,5),updated_at=clock_timestamp()
                  WHERE removal_id=:id RETURNING *""",
                {"state": state, "lease": lease, "id": identifier},
            )
            return {**updated, "plan": self._plan(updated)}

        return await self._transaction(operation)

    async def require_current(self, job: dict, *, v1_only: bool = False) -> None:
        if type(v1_only) is not bool:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            row = self._row(
                connection,
                """SELECT state,lease_id,lease_expires_at,v1_statement_search
                   FROM drive_request_bulk_removals
                   WHERE removal_id=:id AND user_id=:user""",
                {"id": job["removal_id"], "user": job["user_id"]},
            )
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row is None
                or (v1_only and row["v1_statement_search"] is not True)
                or row["lease_id"] != job["lease_id"]
                or row["lease_expires_at"] <= now
                or row["state"] not in {"queued", "dispatching", "unknown"}
            ):
                raise DriveSharingError("permission_job_superseded")

        await self._transaction(operation)

    async def mark_dispatching(self, job: dict, *, v1_only: bool = False) -> None:
        if type(v1_only) is not bool:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            changed = connection.execute(
                text("""UPDATE drive_request_bulk_removals SET state='dispatching',
                   updated_at=clock_timestamp()
                   WHERE removal_id=:id AND user_id=:user AND lease_id=:lease
                     AND state='queued'
                     AND (:v1_only = FALSE OR v1_statement_search=TRUE)"""),
                {
                    "id": job["removal_id"],
                    "user": job["user_id"],
                    "lease": job["lease_id"],
                    "v1_only": v1_only,
                },
            ).rowcount
            if changed != 1:
                raise DriveSharingError("permission_job_superseded")

        await self._transaction(operation)

    async def settle(
        self, job: dict, *, state: str, code: str | None = None, v1_only: bool = False
    ) -> None:
        if state not in {"removed", "absent", "needs_review", "unavailable", "unknown", "queued"}:
            raise ValueError("invalid bulk removal outcome")
        if type(v1_only) is not bool:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            current = self._row(
                connection,
                """SELECT state,lease_id FROM drive_request_bulk_removals
                  WHERE removal_id=:id AND user_id=:user
                    AND (:v1_only = FALSE OR v1_statement_search=TRUE) FOR UPDATE""",
                {"id": job["removal_id"], "user": job["user_id"], "v1_only": v1_only},
            )
            if current is None or current["lease_id"] != job["lease_id"]:
                raise DriveSharingError("permission_job_superseded")
            connection.execute(
                text("""UPDATE drive_request_bulk_removals SET state=:state,
                  safe_error_code=:code,lease_id=NULL,lease_expires_at=NULL,
                  next_at=CASE WHEN :state='queued' THEN clock_timestamp()+INTERVAL '60 seconds'
                    ELSE clock_timestamp() END,updated_at=clock_timestamp()
                  WHERE removal_id=:id"""),
                {"id": job["removal_id"], "state": state, "code": code},
            )

        await self._transaction(operation)
