"""Durable per-file grant dispatch; uncertain effects are never blindly replayed."""

from __future__ import annotations

import json
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError, SharingApproval
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DrivePermissionStore(DriveSharingStore):
    def _settlement_gate(self, connection, user_id, request_id):
        # Live private requests can publish a recipient event. Acquire both
        # graph gates before context/operation locks, including 201's insert
        # guard, so B cleanup never waits on us while we wait on B.
        from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

        private = self._row(
            connection,
            """
            SELECT recipient_user_id FROM drive_share_requests WHERE request_id=:id AND user_id=:user
        """,
            {"id": request_id, "user": user_id},
        )
        lock_connection_graph_users(
            connection, user_ids=[user_id, private["recipient_user_id"]] if private else [user_id]
        )
        return self._management_context(connection, user_id, request_id)

    def _permission(self, connection, user_id, operation_id, *, lock=False):
        sql = (
            "SELECT * FROM drive_share_permission_operations WHERE user_id=:user AND operation_id=:id FOR UPDATE"
            if lock
            else "SELECT * FROM drive_share_permission_operations WHERE user_id=:user AND operation_id=:id"
        )
        return self._row(
            connection,
            sql,
            {"user": user_id, "id": str(UUID(operation_id))},
        )

    def _plan(self, row):
        return self.sharing_cipher.open(
            row["plan_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["operation_id"]),
            purpose="permission-plan",
        )

    def _grant_authority(self, connection, initial):
        self._participant_gate(connection, initial["user_id"], str(initial["request_id"]))
        self._active(connection, initial["user_id"], initial["connection_generation"])
        self._selection_policy(connection, initial["user_id"], feature="drive_document_sharing")
        request = self._related_request(connection, initial["user_id"], str(initial["request_id"]))
        context = self._management_context(connection, initial["user_id"], initial["request_id"])
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            context["private_request_erased_at"] is not None
            or request["status"] not in {"approved", "partial"}
            or request["approval_invalidated_at"] is not None
            or request["revision"] != initial["review_revision"]
            or request["expires_at"] <= now
            or (now - initial["created_at"]).total_seconds() > 300
        ):
            raise DriveSharingError("approval_superseded")
        plan = self._plan(initial)
        approval = SharingApproval.model_validate(plan["approval"])
        sources = self._sources(
            connection,
            user_id=initial["user_id"],
            generation=initial["connection_generation"],
            document_ids=[str(item.document_id) for item in approval.sources],
        )
        current = SharingApproval.model_validate(
            {
                **approval.model_dump(),
                "recipient_binding": request["recipient_binding"],
                "recipient_user_id": request["recipient_user_id"],
                "sources": [self._source_terms(item) for item in sources],
            }
        )
        if current.authority_binding() != approval.authority_binding():
            raise DriveSharingError("approval_superseded")
        return plan

    async def claim_grant(self, *, user_id: str, operation_id: str) -> dict | None:
        """Only queued work can dispatch. Expired dispatching work must reconcile."""
        return cast(
            dict | None,
            await self._claim_queued(user_id=user_id, operation_id=operation_id, kind="grant"),
        )

    async def _claim_queued(self, *, user_id: str, operation_id: str, kind: str):

        def operation(connection):
            initial = self._permission(connection, user_id, operation_id)
            if not initial or initial["kind"] != kind or initial["state"] != "queued":
                return None
            self._grant_authority(connection, initial)
            row = self._permission(connection, user_id, operation_id, lock=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["state"] != "queued"
                or row["lease_expires_at"]
                and row["lease_expires_at"] > now
            ):
                return None
            claimed = self._row(
                connection,
                """
                INSERT INTO drive_share_file_claims(file_lock_hmac,operation_id)
                VALUES (:lock,:id) ON CONFLICT (file_lock_hmac) DO UPDATE
                  SET operation_id=drive_share_file_claims.operation_id
                  WHERE drive_share_file_claims.operation_id=EXCLUDED.operation_id
                RETURNING operation_id
            """,
                {"lock": row["file_lock_hmac"], "id": operation_id},
            )
            if not claimed:
                fence = self._row(
                    connection,
                    """
                    SELECT operation_id,erased_at FROM drive_share_file_claims WHERE file_lock_hmac=:lock
                """,
                    {"lock": row["file_lock_hmac"]},
                )
                if fence and fence["operation_id"] is None and fence["erased_at"] is not None:
                    raise DriveSharingError("permission_requires_google_management")
                return None
            return self._row(
                connection,
                """
                UPDATE drive_share_permission_operations SET lease_id=:lease,
                  lease_expires_at=clock_timestamp()+INTERVAL '90 seconds',updated_at=clock_timestamp()
                WHERE operation_id=:id RETURNING *
            """,
                {"id": operation_id, "lease": str(uuid4())},
            )

        try:
            return cast(dict | None, await self._transaction(operation))
        except DriveReadError as error:
            await self.retire_undispatched(
                user_id=user_id,
                operation_id=operation_id,
                safe_error_code="permission_requires_google_management"
                if str(error) == "permission_requires_google_management"
                else "approval_superseded",
            )
            raise

    async def retire_undispatched(
        self, *, user_id, operation_id, safe_error_code="approval_superseded"
    ):
        """Only an expired, provably unposted claim can be released without Google."""

        def operation(connection):
            initial = self._permission(connection, user_id, operation_id)
            if not initial:
                return
            self._settlement_gate(connection, user_id, initial["request_id"])
            row = self._permission(connection, user_id, operation_id, lock=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                not row
                or row["state"] != "queued"
                or row["dispatched_at"] is not None
                or row["lease_expires_at"]
                and row["lease_expires_at"] > now
            ):
                return
            connection.execute(
                text("""
                UPDATE drive_share_permission_operations SET state='not_dispatched',
                  safe_error_code=:code,settled_at=clock_timestamp(),updated_at=clock_timestamp()
                WHERE operation_id=:id
            """),
                {"id": operation_id, "code": safe_error_code},
            )
            connection.execute(
                text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
                {"id": operation_id},
            )
            self._finish_batch(connection, row)

        await self._transaction(operation)

    def _current(self, connection, job):
        self._grant_authority(connection, job)
        row = self._permission(connection, job["user_id"], str(job["operation_id"]), lock=True)
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            not row
            or row["state"] not in {"queued", "dispatching"}
            or row["lease_id"] != job["lease_id"]
            or row["lease_expires_at"] <= now
        ):
            raise DriveSharingError("permission_job_superseded")
        return row

    async def require_current(self, job):
        await self._transaction(lambda connection: self._current(connection, job))

    async def reconciliation_target(self, *, user_id, operation_id):
        return await self._transaction(
            lambda connection: self._permission(connection, user_id, operation_id)
        )

    async def claim_reconciliation(
        self, *, user_id: str, operation_id: str, generation: int, issuer: dict
    ) -> dict | None:
        def operation(connection):
            initial = self._permission(connection, user_id, operation_id)
            if not initial or initial["state"] not in {"dispatching", "unknown"}:
                return None
            self._owner_gate(connection, user_id)
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature="google_drive_connection")
            self._management_context(connection, user_id, initial["request_id"])
            row = self._permission(connection, user_id, operation_id, lock=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["state"] not in {"dispatching", "unknown"}
                or row["lease_expires_at"]
                and row["lease_expires_at"] > now
            ):
                return None
            receipt = (
                self.sharing_cipher.open(
                    row["receipt_envelope"],
                    user_id=user_id,
                    resource_id=operation_id,
                    purpose="permission-receipt",
                )
                if row["receipt_envelope"]
                else {}
            )
            if not issuer or receipt.get("issuer") != issuer:
                raise DriveSharingError("reconnect_original_account")
            # It stays unknown: new leases authorize GET-only reconciliation.
            updated = self._row(
                connection,
                """
                UPDATE drive_share_permission_operations SET state='unknown',lease_id=:lease,
                  lease_expires_at=clock_timestamp()+INTERVAL '45 seconds',updated_at=clock_timestamp()
                WHERE operation_id=:id RETURNING *
            """,
                {"id": operation_id, "lease": str(uuid4())},
            )
            return {**updated, "reconciliation_generation": generation}

        return cast(dict | None, await self._transaction(operation))

    async def require_reconciliation_current(self, job):
        def operation(connection):
            self._owner_gate(connection, job["user_id"])
            self._active(connection, job["user_id"], job["reconciliation_generation"])
            self._selection_policy(connection, job["user_id"], feature="google_drive_connection")
            self._management_context(connection, job["user_id"], job["request_id"])
            row = self._permission(connection, job["user_id"], str(job["operation_id"]), lock=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                not row
                or row["state"] != "unknown"
                or row["lease_id"] != job["lease_id"]
                or row["lease_expires_at"] <= now
            ):
                raise DriveSharingError("permission_job_superseded")

        await self._transaction(operation)

    async def mark_dispatching(self, job, *, before: list[dict], issuer: dict):
        def operation(connection):
            row = self._current(connection, job)
            if row["state"] != "queued":
                raise DriveSharingError("permission_job_superseded")
            context = self._management_context(connection, job["user_id"], job["request_id"])
            receipt = {"before": before, "issuer": issuer}
            if context["private_request_erased_at"] is not None:
                from hushh_mcp.services.drive_sharing_retention import minimal_receipt

                receipt = minimal_receipt(receipt)
            envelope = self.sharing_cipher.seal(
                receipt,
                user_id=job["user_id"],
                resource_id=str(job["operation_id"]),
                purpose="permission-receipt",
            )
            connection.execute(
                text("""
                UPDATE drive_share_permission_operations SET state='dispatching',dispatched_at=clock_timestamp(),
                  receipt_envelope=CAST(:receipt AS jsonb),updated_at=clock_timestamp()
                WHERE operation_id=:id
            """),
                {"id": job["operation_id"], "receipt": json.dumps(envelope)},
            )

        await self._transaction(operation)

    async def settle(self, job, *, state: str, evidence: dict, safe_error_code=None):
        if state not in {
            "succeeded",
            "preexisting",
            "rejected",
            "not_dispatched",
            "unknown",
            "present_unattributed",
            "absent",
            "needs_review",
        }:
            raise DriveSharingError("invalid_permission_outcome")

        def operation(connection):
            # Do NOT check connection/selection/feature here: late successes and
            # uncertain outcomes must survive disconnect or execution disablement.
            # Match dispatch lock order and serialize aggregate batch settlement.
            context = self._settlement_gate(connection, job["user_id"], job["request_id"])
            row = self._permission(connection, job["user_id"], str(job["operation_id"]), lock=True)
            if (
                not row
                or row["lease_id"] != job["lease_id"]
                or row["state"] not in {"queued", "dispatching", "unknown"}
            ):
                raise DriveSharingError("permission_job_superseded")
            if state == "succeeded" and row["state"] != "dispatching":
                raise DriveSharingError("invalid_permission_outcome")
            if state == "not_dispatched" and row["state"] != "queued":
                raise DriveSharingError("invalid_permission_outcome")
            prior = (
                self.sharing_cipher.open(
                    row["receipt_envelope"],
                    user_id=job["user_id"],
                    resource_id=str(job["operation_id"]),
                    purpose="permission-receipt",
                )
                if row["receipt_envelope"]
                else {}
            )
            receipt = {**prior, **evidence}
            if context["private_request_erased_at"] is not None:
                from hushh_mcp.services.drive_sharing_retention import minimal_receipt

                receipt = minimal_receipt(receipt)
            envelope = self.sharing_cipher.seal(
                receipt,
                user_id=job["user_id"],
                resource_id=str(job["operation_id"]),
                purpose="permission-receipt",
            )
            connection.execute(
                text("""
                UPDATE drive_share_permission_operations SET state=:state,receipt_envelope=CAST(:receipt AS jsonb),
                  safe_error_code=:code,updated_at=clock_timestamp(),settled_at=clock_timestamp()
                WHERE operation_id=:id
            """),
                {
                    "id": job["operation_id"],
                    "state": state,
                    "receipt": json.dumps(envelope),
                    "code": safe_error_code,
                },
            )
            if state != "unknown":
                connection.execute(
                    text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
                    {"id": job["operation_id"]},
                )
            self._finish_batch(connection, row, safe_error_code=safe_error_code)

        await self._transaction(operation)

    def _finish_batch(self, connection, job, *, safe_error_code=None):
        context = self._management_context(connection, job["user_id"], job["request_id"])
        if context["private_request_erased_at"] is not None:
            # The owner's receipt remains manageable. No erased request,
            # recipient link or private notification may be reconstructed.
            return
        if job["kind"] == "revoke":
            # Revocation outcomes are independent of the original sharing
            # result. A removed direct ACL does not prove all access ended.
            batch = (
                connection.execute(
                    text("""
                SELECT bool_and(state NOT IN ('queued','dispatching','unknown')) AS terminal,
                  bool_and(state IN ('succeeded','absent')) AS removed
                FROM drive_share_permission_operations WHERE user_id=:user AND batch_id=:batch AND kind='revoke'
            """),
                    {"user": job["user_id"], "batch": job["batch_id"]},
                )
                .mappings()
                .one()
            )
            if batch["terminal"]:
                request = self._request(connection, job["user_id"], str(job["request_id"]))
                request = {**request, "revision": self._plan(job)["revocation_revision"]}
                event = (
                    "document_share_revoked"
                    if batch["removed"]
                    else "document_share_revocation_outcome"
                )
                self._event(connection, request, request["user_id"], event)
                self._event(connection, request, request["recipient_user_id"], event)
            return
        if safe_error_code in {
            "source_changed",
            "source_not_shareable",
            "recipient_changed",
            "connection_changed",
            "approval_superseded",
            "permission_target_unavailable",
        }:
            connection.execute(
                text("""
                UPDATE drive_share_requests SET approval_invalidated_at=clock_timestamp()
                WHERE request_id=:request
            """),
                {"request": job["request_id"]},
            )
            # Known invalidation fences every later POST in the batch. In-
            # flight calls retain their durable receipts and settle honestly.
            retired = (
                connection.execute(
                    text("""
                UPDATE drive_share_permission_operations SET state='not_dispatched',
                  safe_error_code='approval_superseded',settled_at=clock_timestamp(),updated_at=clock_timestamp()
                WHERE request_id=:request AND review_revision=:revision AND kind='grant' AND state='queued'
                RETURNING operation_id
            """),
                    {"request": job["request_id"], "revision": job["review_revision"]},
                )
                .scalars()
                .all()
            )
            for identifier in retired:
                connection.execute(
                    text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
                    {"id": identifier},
                )
        # Keep the batch pending until every exact per-file outcome is known.
        unresolved = connection.execute(
            text("""
            SELECT EXISTS(SELECT 1 FROM drive_share_permission_operations WHERE request_id=:request
              AND review_revision=:revision AND kind='grant' AND state IN ('queued','dispatching','unknown'))
        """),
            {"request": job["request_id"], "revision": job["review_revision"]},
        ).scalar_one()
        if not unresolved:
            all_shared = connection.execute(
                text("""
                SELECT bool_and(state IN ('succeeded','preexisting')) FROM drive_share_permission_operations
                WHERE request_id=:request AND review_revision=:revision AND kind='grant'
            """),
                {"request": job["request_id"], "revision": job["review_revision"]},
            ).scalar_one()
            request = self._row(
                connection,
                """
                UPDATE drive_share_requests SET status=:status,updated_at=clock_timestamp()
                WHERE request_id=:id AND revision=:revision AND status IN ('approved','partial') RETURNING *
            """,
                {
                    "id": job["request_id"],
                    "revision": job["review_revision"],
                    "status": "completed" if all_shared else "partial",
                },
            )
            if request:
                self._event(connection, request, request["user_id"], "document_share_outcome")
                self._event(
                    connection, request, request["recipient_user_id"], "document_share_outcome"
                )
