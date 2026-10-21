"""Finish an approved packet from observed buyer access without creating a grant.

The full frozen file set and fresh recipient ACL receipts commit together. An
unreserved payment order may be closed, but paid/in-flight checkout is never
rewritten. Existing ACL receipts are explicitly unmanaged.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_allowed import (
    automatic_recipient_current,
    autoshare_request,
    package_allow_marker,
)
from hushh_mcp.services.drive_package_access_preflight import (
    ACCESS_EVIDENCE_MAX_AGE_SECONDS,
    PackageAccessResult,
    _expiration,
)
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError


class DrivePackageExistingAccessStore(DriveBulkShareStore):
    async def complete(self, *, user_id, request_id, result: PackageAccessResult):
        request_id = str(UUID(request_id))
        if (
            not isinstance(result, PackageAccessResult)
            or result.status != "all_existing"
            or result.user_id != user_id
            or result.request_id != request_id
            or not 1 <= len(result.files) <= 120
        ):
            raise DriveSharingError("package_existing_access_changed")

        def operation(connection):
            self._gate_graph_for_request(connection, user_id=user_id, request_id=request_id)
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            shares = list(
                connection.execute(
                    text("""SELECT * FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                ORDER BY share_id FOR UPDATE"""),
                    {"user": user_id, "request": request_id},
                ).mappings()
            )
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests
                WHERE user_id=:user AND request_id=:request FOR UPDATE""",
                {"user": user_id, "request": request_id},
            )
            if request is None:
                raise DriveSharingError("request_unavailable")
            private = self._open(
                request["request_envelope"],
                user_id=user_id,
                resource_id=request_id,
                purpose="request",
            )
            if (
                request["status"] == "completed"
                and not request["payment_required"]
                and private.get("existing_access_delivery")
            ):
                return {"requestId": request_id, "existingAccess": True}
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            age = (now - result.checked_at).total_seconds()
            if (
                not 0 <= age <= ACCESS_EVIDENCE_MAX_AGE_SECONDS
                or request["status"] != "pending"
                or request["revision"] != result.request_revision
                or request["expires_at"] <= now
                or request["access_stop_requested_at"] is not None
                or request["recipient_user_id"] != result.recipient.get("user_id")
                or any(
                    private["recipient"].get(key, "google_provider" if key == "kind" else None)
                    != result.recipient.get(key, "google_provider" if key == "kind" else None)
                    for key in ("subject", "email", "kind")
                )
            ):
                raise DriveSharingError("package_existing_access_changed")
            marker = package_allow_marker(private)
            if marker is None or not shares or not self._owner_grants_enabled(user_id):
                raise DriveSharingError("package_not_allowed")
            active = self.live_active(connection, user_id=user_id)
            self.background_current(
                connection, user_id=user_id, generation=active["connection_generation"]
            )
            marker = self._package_allow(
                connection,
                request,
                search_job_id=marker["search_job_id"],
                generation=active["connection_generation"],
            )
            if any(
                share["status"] != "review_ready"
                or not share["progressive_batch"]
                or share["recipient_count"] != 1
                or share["approved_at"] is not None
                or share["origin_request_revision"] != request["revision"]
                or str(share["search_job_id"]) != marker["search_job_id"]
                or share["connection_generation"] != marker["connection_generation"]
                or share["expires_at"] <= now
                for share in shares
            ):
                raise DriveSharingError("package_existing_access_changed")
            for share in shares:
                recipients = self._recipients(connection, share)
                if len(recipients) != 1 or any(
                    recipients[0].get(key, "google_provider" if key == "kind" else None)
                    != result.recipient.get(key, "google_provider" if key == "kind" else None)
                    for key in ("user_id", "subject", "email", "kind")
                ):
                    raise DriveSharingError("recipient_changed")
            files = list(
                connection.execute(
                    text("""SELECT f.* FROM drive_bulk_share_files f
                JOIN drive_bulk_shares b ON b.share_id=f.share_id
                WHERE b.user_id=:user AND b.origin_request_id=:request
                ORDER BY f.source_position FOR UPDATE OF f"""),
                    {"user": user_id, "request": request_id},
                ).mappings()
            )
            approved = {item["position"]: item for item in marker["selected_sources"]}
            evidence = {item["id"]: item for item in result.files}
            if (
                len(evidence) != len(result.files)
                or len(files) != len(approved)
                or len(files) != len(result.files)
                or {item["source_position"] for item in files} != set(approved)
            ):
                raise DriveSharingError("package_existing_access_changed")
            receipts = []
            for item in files:
                metadata = self._file(item, user_id)
                proof = evidence.get(metadata["id"])
                bound = approved[item["source_position"]]
                if bound.get("indexed_evidence"):
                    from hushh_mcp.services.drive_document_facts_store import (
                        DriveDocumentFactsStore,
                    )

                    DriveDocumentFactsStore(db=self.db)._current_document(
                        connection, owner_user_id=user_id, **bound["indexed_evidence"]
                    )
                if (
                    proof is None
                    or proof["access"] != "present"
                    or not proof["permission"]
                    or not _expiration(proof["permission"], now)
                    or proof["generation"] != marker["connection_generation"]
                    or proof["sourceVersion"] != metadata.get("sourceVersion")
                    or proof["sourceVersion"] != bound["source_version"]
                    or proof["contentFingerprint"] != metadata.get("contentFingerprint")
                    or proof["contentFingerprint"] != bound["content_fingerprint"]
                    or item["file_digest"] != bound["file_digest"]
                    or metadata.get("evidenceDigest") != bound["evidence_digest"]
                    or metadata.get("packageDigest") != marker["package_digest"]
                ):
                    raise DriveSharingError("package_existing_access_changed")
                receipts.append(
                    (
                        item,
                        {
                            "managed": False,
                            "permission_id": proof["permission"]["id"],
                            "permission_type": proof["permission"]["type"],
                            "permission_role": proof["permission"]["role"],
                            "provenance": "existing_acl_before_checkout",
                            "observed_at": result.checked_at.isoformat(),
                        },
                    )
                )
            if connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_bulk_share_effects e
                JOIN drive_bulk_shares b ON b.share_id=e.share_id
                WHERE b.user_id=:user AND b.origin_request_id=:request)"""),
                {"user": user_id, "request": request_id},
            ).scalar_one():
                raise DriveSharingError("package_existing_access_changed")
            return self._finish_existing_locked(
                connection,
                user_id=user_id,
                request_id=request_id,
                request=request,
                private=private,
                shares=shares,
                receipts=receipts,
                delivery={
                    "package_digest": marker["package_digest"],
                    "observed_at": result.checked_at.isoformat(),
                    "document_count": len(receipts),
                },
            )

        return await self._transaction(operation)

    async def complete_autoshare(self, *, user_id, request_id, result, retired=None):
        """Publish a final ordinary selection from fresh ACLs, without a new grant."""
        request_id = str(UUID(request_id))
        if (
            not isinstance(result, PackageAccessResult)
            or result.status != "all_existing"
            or result.user_id != user_id
            or result.request_id != request_id
            or not 1 <= len(result.files) <= 120
        ):
            raise DriveSharingError("package_existing_access_changed")

        def operation(connection):
            self._gate_graph_for_request(connection, user_id=user_id, request_id=request_id)
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            shares = list(
                connection.execute(
                    text("""SELECT * FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request
                ORDER BY share_id FOR UPDATE"""),
                    {"user": user_id, "request": request_id},
                ).mappings()
            )
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests
                WHERE user_id=:user AND request_id=:request FOR UPDATE""",
                {"user": user_id, "request": request_id},
            )
            if request is None:
                raise DriveSharingError("request_unavailable")
            private = self._open(
                request["request_envelope"],
                user_id=user_id,
                resource_id=request_id,
                purpose="request",
            )
            if (
                request["status"] == "completed"
                and not request["payment_required"]
                and private.get("existing_access_delivery")
            ):
                return {"requestId": request_id, "existingAccess": True}
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                not 0
                <= (now - result.checked_at).total_seconds()
                <= ACCESS_EVIDENCE_MAX_AGE_SECONDS
                or private.get("agent_package_required") is True
                or private.get("trusted_auto") is not True
                or not autoshare_request(private)
                or request["revision"] != result.request_revision
                or request["recipient_user_id"] != result.recipient.get("user_id")
                or not self._owner_grants_enabled(user_id)
                or any(
                    private["recipient"].get(k, "google_provider" if k == "kind" else None)
                    != result.recipient.get(k, "google_provider" if k == "kind" else None)
                    for k in ("subject", "email", "kind")
                )
                or not automatic_recipient_current(
                    connection,
                    user_id,
                    request["recipient_user_id"],
                    private,
                    request_id=request_id,
                )
            ):
                raise DriveSharingError("package_existing_access_changed")
            active = self.live_active(connection, user_id=user_id)
            self.background_current(
                connection, user_id=user_id, generation=active["connection_generation"]
            )
            final = self._autoshare_checkout_sources_locked(
                connection, user_id=user_id, request_id=request_id
            )
            evidence = {f["id"]: f for f in result.files}
            if (
                not final["complete"]
                or not shares
                or len(evidence) != len(result.files)
                or {f["id"] for f in final["files"]} != set(evidence)
                or any(s["expires_at"] <= now or s["recipient_count"] != 1 for s in shares)
            ):
                raise DriveSharingError("package_existing_access_changed")
            for share in shares:
                recipients = self._recipients(connection, share)
                if len(recipients) != 1 or any(
                    recipients[0].get(k, "google_provider" if k == "kind" else None)
                    != result.recipient.get(k, "google_provider" if k == "kind" else None)
                    for k in ("user_id", "subject", "email", "kind")
                ):
                    raise DriveSharingError("recipient_changed")
            files = list(
                connection.execute(
                    text("""SELECT f.* FROM drive_bulk_share_files f
                JOIN drive_bulk_shares b ON b.share_id=f.share_id AND b.user_id=f.user_id
                WHERE b.user_id=:user AND b.origin_request_id=:request
                ORDER BY f.source_position FOR UPDATE OF f"""),
                    {"user": user_id, "request": request_id},
                ).mappings()
            )
            if (
                len(files) != len(evidence)
                or connection.execute(
                    text("""SELECT EXISTS(
                SELECT 1 FROM drive_bulk_share_effects e JOIN drive_bulk_shares b
                ON b.share_id=e.share_id AND b.user_id=e.user_id
                WHERE b.user_id=:user AND b.origin_request_id=:request)"""),
                    {"user": user_id, "request": request_id},
                ).scalar_one()
            ):
                raise DriveSharingError("package_existing_access_changed")
            receipts = []
            for item in files:
                metadata = self._file(item, user_id)
                proof = evidence.get(metadata["id"])
                if (
                    proof is None
                    or proof.get("access") != "present"
                    or not proof.get("permission")
                    or not _expiration(proof["permission"], now)
                    or proof.get("generation") != active["connection_generation"]
                    or any(
                        proof.get(k) != metadata.get(k)
                        for k in ("sourceVersion", "modifiedTime", "name", "contentFingerprint")
                    )
                ):
                    raise DriveSharingError("package_existing_access_changed")
                receipts.append(
                    (
                        item,
                        {
                            "managed": False,
                            "permission_id": proof["permission"]["id"],
                            "permission_type": proof["permission"]["type"],
                            "permission_role": proof["permission"]["role"],
                            "provenance": "existing_acl_before_checkout",
                            "observed_at": result.checked_at.isoformat(),
                        },
                    )
                )
            delivery = {
                "basis": "ordinary_existing_access_v1",
                "observed_at": result.checked_at.isoformat(),
                "document_count": len(receipts),
            }
            if retired is not None:
                delivery["retired_checkout"] = {
                    "session_id": retired.session_id,
                    "attempt_id": retired.attempt_id,
                    "stripe_mode": retired.stripe_mode,
                }
            return self._finish_existing_locked(
                connection,
                user_id=user_id,
                request_id=request_id,
                request=request,
                private=private,
                shares=shares,
                receipts=receipts,
                delivery=delivery,
                retired=retired,
            )

        return await self._transaction(operation)

    def _finish_existing_locked(
        self,
        connection,
        *,
        user_id,
        request_id,
        request,
        private,
        shares,
        receipts,
        delivery,
        retired=None,
    ):
        DriveRequestPaymentStore.settle_existing_access_nocharge_locked(
            connection, request, retired
        )
        private["existing_access_delivery"] = delivery
        connection.execute(
            text("""UPDATE drive_share_requests SET payment_required=FALSE,
            existing_access_waived_at=clock_timestamp(),
            request_envelope=CAST(:envelope AS jsonb),updated_at=clock_timestamp()
            WHERE request_id=:request"""),
            {
                "request": request_id,
                "envelope": self._seal(
                    private, user_id=user_id, resource_id=request_id, purpose="request"
                ),
            },
        )
        for item, receipt in receipts:
            connection.execute(
                text("""INSERT INTO drive_bulk_share_effects
                (share_id,user_id,position,recipient_user_id,state,receipt_envelope)
                VALUES(:share,:user,:position,:recipient,'preexisting',CAST(:receipt AS jsonb))"""),
                {
                    "share": item["share_id"],
                    "user": user_id,
                    "position": item["position"],
                    "recipient": request["recipient_user_id"],
                    "receipt": self._seal(
                        receipt,
                        user_id=user_id,
                        resource_id=f"{item['share_id']}:{item['position']}:{request['recipient_user_id']}",
                        purpose="bulk-share-receipt",
                    ),
                },
            )
        for share in shares:
            connection.execute(
                text("""UPDATE drive_bulk_shares SET status='queued',
                approved_at=clock_timestamp(),approval_source='trusted_auto',revision=revision+1,
                expires_at=GREATEST(expires_at,clock_timestamp()+interval '7 days'),updated_at=clock_timestamp()
                WHERE share_id=:share"""),
                {"share": share["share_id"]},
            )
        for share in shares:
            self._finalize(connection, share["share_id"])
        status = connection.execute(
            text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
        if status != "completed":
            raise DriveSharingError("package_existing_access_changed")
        return {"requestId": request_id, "existingAccess": True}
