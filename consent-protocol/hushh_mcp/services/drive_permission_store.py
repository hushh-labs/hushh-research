"""Durable per-file grant dispatch; uncertain effects are never blindly replayed."""

from __future__ import annotations

import json
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery import drive_bridge
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, SharingApproval
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.google_drive_adapter import DriveReadError

# The serialized queue may dispatch 25 exact-file grants at one job per minute.
# Keep a finite batch window; every claim still rechecks live owner/source authority.
GRANT_AUTHORITY_WINDOW_SECONDS = 2 * 60 * 60
# A create Google answered with invalidSharingRequest whose exact requested
# grant read-only reconciliation then found. Only this evidence may record
# success for an operation that is no longer "dispatching".
RECONCILED_CREATE_PROVENANCE = "reconciled_create_after_complete_absence_check"
# Waits after each sharingRateLimitExceeded refusal. A fifth refusal settles.
RATE_LIMIT_DELAYS_SECONDS = (5 * 60, 10 * 60, 20 * 60, 40 * 60)


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

    def _reconciliation_connection(self, connection, *, user_id, generation, row):
        if self._plan(row).get("source_kind") == "live":
            DriveLivePreferences(db=self.db).live_active(
                connection, user_id=user_id, generation=generation, management=True
            )
        else:
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature="google_drive_connection")

    def _grant_authority(self, connection, initial):
        request, plan, hosted_contract = drive_bridge.grant_context(
            self, connection, initial, GRANT_AUTHORITY_WINDOW_SECONDS
        )
        if hosted_contract:
            from hushh_mcp.services.document_delivery.contracts import DeliveryError
            from hushh_mcp.services.document_delivery.drive_bridge import grant_authority

            try:
                return grant_authority(
                    self, connection, request=request, initial=initial, plan=plan
                )
            except DeliveryError:
                raise DriveSharingError("approval_superseded") from None
        approval = SharingApproval.model_validate(plan["approval"])
        self._admit_sources(
            connection,
            user_id=initial["user_id"],
            generation=initial["connection_generation"],
            sources=approval.sources,
        )
        sources = self._sources(
            connection,
            user_id=initial["user_id"],
            generation=initial["connection_generation"],
            document_ids=[str(item.document_id) for item in approval.sources],
            request_id=str(initial["request_id"]),
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
        if plan.get("rule_id"):
            rule = self._row(
                connection,
                """SELECT * FROM drive_document_rules WHERE rule_id=:id AND user_id=:user FOR SHARE""",
                {"id": str(UUID(plan["rule_id"])), "user": initial["user_id"]},
            )
            if (
                not rule
                or not rule["active"]
                or rule["version"] != plan.get("rule_version")
                or rule["recipient_user_id"] != request["recipient_user_id"]
                or rule["recipient_binding"] != request["recipient_binding"]
                or rule["connection_generation"] != initial["connection_generation"]
            ):
                raise DriveSharingError("approval_superseded")
            boundary = self.sharing_cipher.open(
                rule["boundary_envelope"],
                user_id=initial["user_id"],
                resource_id=str(rule["rule_id"]),
                purpose="document-rule",
            )
            if not self._rule_covers_boundary(boundary, request=request, sources=sources):
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
            from hushh_mcp.services.drive_permission_file_claims import claim_file

            if not claim_file(connection, row["file_lock_hmac"], operation=operation_id):
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
            # An unpaid request cannot dispatch yet, but a later signed payment
            # may make this same queued grant eligible. Keep the operation queued.
            if isinstance(error, DriveSharingError) and str(error) == "payment_required":
                raise
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
        from hushh_mcp.services.drive_permission_file_claims import require_file_claim

        require_file_claim(connection, row["file_lock_hmac"], operation=str(row["operation_id"]))
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
            self._reconciliation_connection(
                connection, user_id=user_id, generation=generation, row=initial
            )
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
            self._reconciliation_connection(
                connection,
                user_id=job["user_id"],
                generation=job["reconciliation_generation"],
                row=job,
            )
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
            from hushh_mcp.services.drive_permission_file_claims import require_file_claim

            require_file_claim(
                connection, row["file_lock_hmac"], operation=str(row["operation_id"])
            )

        await self._transaction(operation)

    def _open_receipt(self, row) -> dict:
        if not row.get("receipt_envelope"):
            return {}
        return self.sharing_cipher.open(
            row["receipt_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["operation_id"]),
            purpose="permission-receipt",
        )

    @staticmethod
    def _rate_limited_count(receipt: dict) -> int:
        count = receipt.get("rate_limited")
        return count if type(count) is int and 0 <= count <= len(RATE_LIMIT_DELAYS_SECONDS) else 0

    async def defer_rate_limited(self, job) -> bool:
        """Requeue a create Google refused for its sharing rate limit.

        Nothing was shared, so the operation returns to queued behind a timer
        lease (5, 10, 20, then 40 minutes) and loses its dispatch marker. It
        also releases its file claim: nothing is in flight, so a confirmed
        Stop's removal or another grant of the same file never waits on the
        timer. The next claim takes the file again, rechecks authority and
        repeats the complete absence check before any POST. False once the
        waits are used up: the caller settles.
        """

        def operation(connection):
            context = self._settlement_gate(connection, job["user_id"], job["request_id"])
            row = self._permission(connection, job["user_id"], str(job["operation_id"]), lock=True)
            if not row or row["lease_id"] != job["lease_id"] or row["state"] != "dispatching":
                raise DriveSharingError("permission_job_superseded")
            receipt = self._open_receipt(row)
            count = self._rate_limited_count(receipt)
            if count >= len(RATE_LIMIT_DELAYS_SECONDS):
                return False
            receipt = {**receipt, "rate_limited": count + 1}
            if context["private_request_erased_at"] is not None:
                from hushh_mcp.services.drive_sharing_retention import minimal_receipt

                # The erased request cannot keep the counter; its 2-hour grant
                # authority window still bounds every later attempt.
                receipt = minimal_receipt(receipt)
            envelope = self.sharing_cipher.seal(
                receipt,
                user_id=job["user_id"],
                resource_id=str(job["operation_id"]),
                purpose="permission-receipt",
            )
            connection.execute(
                text("""
                UPDATE drive_share_permission_operations SET state='queued',dispatched_at=NULL,
                  lease_id=:lease,
                  lease_expires_at=clock_timestamp()+(:delay * INTERVAL '1 second'),
                  safe_error_code='sharing_rate_limited',receipt_envelope=CAST(:receipt AS jsonb),
                  updated_at=clock_timestamp()
                WHERE operation_id=:id
            """),
                {
                    "id": job["operation_id"],
                    "lease": str(uuid4()),
                    "delay": RATE_LIMIT_DELAYS_SECONDS[count],
                    "receipt": json.dumps(envelope),
                },
            )
            connection.execute(
                text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
                {"id": job["operation_id"]},
            )
            return True

        return cast(bool, await self._transaction(operation))

    async def mark_dispatching(self, job, *, before: list[dict], issuer: dict):
        def operation(connection):
            row = self._current(connection, job)
            if row["state"] != "queued":
                raise DriveSharingError("permission_job_superseded")
            context = self._management_context(connection, job["user_id"], job["request_id"])
            receipt = {"before": before, "issuer": issuer}
            # A requeued refusal keeps its count, so the waits stay bounded.
            rate_limited = self._rate_limited_count(self._open_receipt(row))
            if rate_limited:
                receipt["rate_limited"] = rate_limited
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
            if state == "succeeded" and not (
                row["state"] == "dispatching"
                or row["state"] == "unknown"
                and evidence.get("provenance") == RECONCILED_CREATE_PROVENANCE
                and evidence.get("managed") is True
            ):
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
        if drive_bridge.finish_hosted_or_erased(self, connection, job):
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
