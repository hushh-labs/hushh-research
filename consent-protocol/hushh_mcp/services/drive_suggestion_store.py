"""Short-lived background authority from requests and per-file owner consent."""

from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH


class DriveSuggestionStore(DriveSharingProjectionStore):
    async def due_preparations(self, limit=8):
        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""
                WITH due AS (SELECT r.request_id FROM drive_share_requests r
                JOIN user_external_connector_connections c ON c.user_id=r.user_id
                  AND c.connector_id='google_drive' AND c.status='connected'
                  AND c.validation_state='verified'
                WHERE r.status IN ('pending','preparing') AND r.expires_at>clock_timestamp()
                  AND (r.preparation_attempts<3 OR r.status='preparing')
                  AND r.preparation_next_at<=clock_timestamp()
                  AND (r.preparation_lease_id IS NULL OR r.preparation_lease_expires_at<=clock_timestamp())
                ORDER BY r.preparation_inspected_at,r.created_at,r.request_id
                LIMIT :limit FOR UPDATE OF r SKIP LOCKED)
                UPDATE drive_share_requests r SET preparation_inspected_at=clock_timestamp()
                FROM due WHERE r.request_id=due.request_id RETURNING r.user_id,r.request_id
            """),
                    {"limit": min(max(limit, 1), 100)},
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim_preparation(
        self, *, user_id, request_id, foreground=False, owner_selected=False
    ):
        self._sharing_admission(user_id)
        request_id = str(UUID(request_id))

        def operation(connection):
            self._participant_gate(connection, user_id, request_id)
            current = self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            generation = current["connection_generation"]
            live = current["verified_policy_hash"] == LIVE_POLICY_HASH
            if live:
                self._live_preparation_access(
                    connection, user_id=user_id, generation=generation, foreground=foreground
                )
            else:
                self._active(connection, user_id, generation)
                self._selection_policy(connection, user_id, feature="drive_document_sharing")
            row = self._related_request(connection, user_id, request_id)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["status"] not in {"pending", "preparing"}
                or row["expires_at"] <= now
                or (row["preparation_next_at"] > now and not (foreground and owner_selected))
                or row["preparation_lease_expires_at"]
                and row["preparation_lease_expires_at"] > now
            ):
                return None
            if row["preparation_attempts"] >= 3:
                updated = self._row(
                    connection,
                    """
                    UPDATE drive_share_requests SET status='review_ready',preparation_lease_id=NULL,
                      preparation_lease_expires_at=NULL,preparation_error_code='preparation_unavailable',
                      updated_at=clock_timestamp() WHERE request_id=:request RETURNING *
                """,
                    {"request": request_id},
                )
                self._event(connection, updated, user_id, "document_share_review_ready")
                return None
            lease = str(uuid4())
            connection.execute(
                text("""
                UPDATE drive_share_requests SET status='preparing',preparation_attempts=preparation_attempts+1,
                  preparation_lease_id=:lease,preparation_lease_expires_at=clock_timestamp()+INTERVAL '180 seconds',
                  preparation_error_code=NULL,updated_at=clock_timestamp()
                WHERE request_id=:request
            """),
                {"lease": lease, "request": request_id},
            )
            return {
                "user_id": user_id,
                "request_id": request_id,
                "revision": row["revision"],
                "generation": generation,
                "lease_id": lease,
                "purpose": self._open_request(row)["purpose"],
                "requested_at": row["created_at"],
                "live": live,
                "foreground": foreground,
            }

        return await self._transaction(operation)

    def _preparation_current(self, connection, job):
        self._participant_gate(connection, job["user_id"], job["request_id"])
        if job.get("live"):
            self._live_preparation_access(
                connection,
                user_id=job["user_id"],
                generation=job["generation"],
                foreground=job.get("foreground", False),
            )
        else:
            self._active(connection, job["user_id"], job["generation"])
            self._selection_policy(connection, job["user_id"], feature="drive_document_sharing")
        row = self._related_request(connection, job["user_id"], job["request_id"])
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            row["status"] != "preparing"
            or row["revision"] != job["revision"]
            or str(row["preparation_lease_id"]) != job["lease_id"]
            or row["preparation_lease_expires_at"] is None
            or row["preparation_lease_expires_at"] <= now
            or row["expires_at"] <= now
        ):
            raise DriveSharingError("preparation_superseded")
        return row

    async def require_preparation_current(self, job):
        await self._transaction(lambda connection: self._preparation_current(connection, job))

    async def indexing_pending(self, job) -> bool:
        """Defer an empty review only while consented selected files can still become ready."""
        if job.get("live"):
            return False

        def operation(connection):
            self._preparation_current(connection, job)
            return (
                connection.execute(
                    text("""
                    SELECT 1 FROM connected_documents
                    WHERE user_id=:user AND connection_generation=:generation
                      AND processing_enabled AND processing_disclosure_version=:disclosure
                      AND status IN ('queued','fetching','parsing','indexing','failed_retryable','stale')
                    LIMIT 1
                    """),
                    {
                        "user": job["user_id"],
                        "generation": job["generation"],
                        "disclosure": PROCESSING_DISCLOSURE_VERSION,
                    },
                ).first()
                is not None
            )

        return await self._transaction(operation)

    async def fail_preparation(self, job, *, code, retryable=False):
        allowed = {
            "preparation_unavailable",
            "narrow_selection_required",
            "no_ready_files",
            "no_relevant_files",
            "source_changed",
        }
        code = code if code in allowed else "preparation_unavailable"

        def operation(connection):
            self._participant_gate(connection, job["user_id"], job["request_id"])
            row = self._request(connection, job["user_id"], job["request_id"])
            if row["status"] != "preparing" or str(row["preparation_lease_id"]) != job["lease_id"]:
                return
            retry = retryable and row["preparation_attempts"] < 3
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET status=:status,preparation_lease_id=NULL,
                  preparation_lease_expires_at=NULL,preparation_error_code=:code,
                  preparation_next_at=clock_timestamp()+INTERVAL '5 minutes',updated_at=clock_timestamp()
                WHERE request_id=:request RETURNING *
            """,
                {
                    "status": "pending" if retry else "review_ready",
                    "code": code,
                    "request": job["request_id"],
                },
            )
            if not retry:
                self._event(connection, updated, job["user_id"], "document_share_review_ready")

        await self._transaction(operation)

    async def retry_preparation(self, *, user_id, request_id, revision):
        """Explicit owner refresh; never consumes old review authority."""
        self._sharing_admission(user_id)

        def operation(connection):
            self._participant_gate(connection, user_id, request_id)
            row = self._related_request(connection, user_id, request_id)
            if (
                row["status"] not in {"pending", "preparing", "review_ready"}
                or row["revision"] != revision
            ):
                raise DriveSharingError("review_changed")
            if (
                row["expires_at"]
                <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            ):
                raise DriveSharingError("request_changed")
            connection.execute(
                text("""
                UPDATE one_action_directive_ledger SET state='cancelled',settled_at=clock_timestamp(),
                  settlement_status='cancelled',settlement_reason_code='document_review_refreshed'
                WHERE channel='document_review' AND user_id=:user AND document_request_id=:request
                  AND state IN ('issued','confirmed')
            """),
                {"user": user_id, "request": request_id},
            )
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET status='pending',revision=revision+1,preparation_attempts=0,
                  preparation_next_at=clock_timestamp(),preparation_error_code=NULL,
                  preparation_lease_id=NULL,preparation_lease_expires_at=NULL,updated_at=clock_timestamp()
                WHERE request_id=:request RETURNING *
            """,
                {"request": request_id},
            )
            return self._summary(updated)

        return await self._transaction(operation)
