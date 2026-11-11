"""Existing-request copy custody. Never creates orders or provider grants."""

from datetime import UTC, datetime

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.document_delivery.background_consent import VERSION, requested
from hushh_mcp.services.document_delivery.background_jobs import BackgroundCopyJobs
from hushh_mcp.services.document_delivery.contracts import DeliveryError, digest
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.owner_placement_guard import admit_hub_content


class BackgroundCopyStore(BackgroundCopyJobs, DriveSharingStore):
    @staticmethod
    def ready(connection):
        return connection.execute(
            text("SELECT to_regclass('document_delivery_background_requests') IS NOT NULL")
        ).scalar()

    def authority(self, connection, request_id, actor, *, owner_only=False, paid=True):
        initial = self._row(
            connection,
            """SELECT * FROM drive_share_requests WHERE request_id=:request
          AND (user_id=:actor OR recipient_user_id=:actor)""",
            {"request": request_id, "actor": actor},
        )
        if initial is None or owner_only and initial["user_id"] != actor:
            raise DeliveryError("request_unavailable", 404)
        lock_connection_graph_users(
            connection, user_ids=[initial["user_id"], initial["recipient_user_id"]]
        )
        current = self._share(
            connection, {"user_id": initial["user_id"], "connector_id": "google_drive"}
        )
        request = self._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        contract = self._row(
            connection,
            "SELECT * FROM document_delivery_background_requests WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if request is None or contract is None:
            raise DeliveryError("one_copy_unavailable", 404)
        private = self._open_request(request)
        for user in (request["user_id"], request["recipient_user_id"]):
            self._sharing_admission(user)
        self._relationship(connection, request["user_id"], request["recipient_user_id"])
        now = datetime.now(UTC)
        if (
            not requested(private)
            or contract["consent_version"] != VERSION
            or contract["revoked_at"]
            or request["access_stop_requested_at"]
            or request["approval_invalidated_at"]
            or request.get("access_expires_at")
            and request["access_expires_at"] <= now
            or request["status"] in {"cancelled", "declined", "expired", "no_match"}
            or current is None
            or current["status"] != "connected"
            or current["connection_generation"] != contract["connection_generation"]
        ):
            raise DeliveryError("one_copy_revoked")
        if paid:
            DriveRequestPaymentStore.require_paid_if_required(connection, request)
            refund = self._row(
                connection,
                "SELECT status FROM drive_request_payment_refunds WHERE request_id=:request",
                {"request": request_id},
            )
            if refund and refund["status"] not in {"failed", "cancelled"}:
                raise DeliveryError("payment_required", 402)
        return request, contract

    def file_authority(self, connection, row, actor, *, lease=False):
        request, contract = self.authority(connection, str(row["request_id"]), actor)
        source = self._row(
            connection,
            """SELECT b.*,e.state AS effect_state,f.metadata_envelope,
          f.source_job_id,f.source_position FROM drive_bulk_shares b
          JOIN drive_bulk_share_files f ON f.share_id=b.share_id AND f.position=:position
          JOIN drive_bulk_share_effects e ON e.share_id=f.share_id AND e.position=f.position
            AND e.recipient_user_id=:recipient WHERE b.share_id=:share""",
            {
                "position": row["position"],
                "share": row["share_id"],
                "recipient": request["recipient_user_id"],
            },
        )
        if (
            source is None
            or str(source["origin_request_id"]) != str(row["request_id"])
            or source["approved_at"] is None
            or source["stopped_at"] is not None
            or source["connection_generation"] != contract["connection_generation"]
            or source["effect_state"] not in {"succeeded", "preexisting"}
        ):
            raise DeliveryError("one_copy_revoked")
        metadata = DriveBulkShareStore(db=self.db, cipher=self.sharing_cipher)._file(
            source, request["user_id"]
        )
        if digest(metadata) != row["source_digest"]:
            raise DeliveryError("source_selection_changed")
        current = self._row(
            connection,
            "SELECT * FROM document_delivery_background_files WHERE file_ref=:ref FOR UPDATE",
            {"ref": row["file_ref"]},
        )
        if (
            current is None
            or current["state"] == "revoked"
            or not lease
            and current["state"] != "ready"
        ):
            raise DeliveryError("one_copy_revoked")
        if lease and (
            current["state"] != "preparing"
            or str(current["lease_id"]) != str(row["lease_id"])
            or current["lease_expires_at"] <= datetime.now(UTC)
        ):
            raise DeliveryError("copy_lease_ended")
        return request, current

    def production_paused(self, row):
        from hushh_mcp.services.drive_owner_allowed import activity_union_paused

        return (
            activity_union_paused()
            and self.open(row, "source_envelope", "background-copy-source-v2")
            .get("discoveryEvidence", {})
            .get("policy")
            == "drive_activity_union_v1"
        )

    async def current(self, row):
        if self.production_paused(row):
            from datetime import timedelta

            from hushh_mcp.services.drive_rest_admission import DriveRestDeferred

            raise DriveRestDeferred(datetime.now(UTC) + timedelta(minutes=1))
        await admit_hub_content(self.owner(row), "drive_one_copy")
        result = await self._transaction(
            lambda c: self.file_authority(c, row, self.owner(row), lease=True)
        )
        await admit_hub_content(self.owner(row), "drive_one_copy")
        return result

    def owner(self, row):
        # The wrapped envelope is owner-bound; the durable job explicitly carries its owner.
        return row["owner_user_id"]

    def open(self, row, field, purpose):
        return self.sharing_cipher.open(
            row[field], user_id=self.owner(row), resource_id=str(row["file_ref"]), purpose=purpose
        )
