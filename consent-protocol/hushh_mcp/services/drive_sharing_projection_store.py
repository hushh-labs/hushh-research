"""Bounded participant projections; private suggestions never cross to B."""

from collections import Counter
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import bulk_outcome_summary
from hushh_mcp.services.drive_live_query_store import STALE_CLAIM_SECONDS
from hushh_mcp.services.drive_revocation_store import DriveRevocationStore
from hushh_mcp.services.drive_sharing_contract import MAX_FILES, DriveSharingError
from hushh_mcp.services.google_drive_adapter import FILE_ID
from hushh_mcp.services.requester_identity import label_from_identity_row


class DriveSharingProjectionStore(DriveRevocationStore):
    @staticmethod
    def _chat_request_status(row, *, now: datetime) -> str:
        if row["request_type"] == "files":
            return DriveSharingProjectionStore._summary(row, recipient=True)["status"]
        status = row["status"]
        if status == "pending" and row["expires_at"] <= now:
            return "expired"
        if status == "running":
            if (
                row["expires_at"] <= now
                and row["decided_at"] is not None
                and (now - row["decided_at"]).total_seconds() > STALE_CLAIM_SECONDS
            ):
                return "expired"
            return "pending"
        return status

    async def list_outgoing_for_chat(self, *, user_id: str, limit: int = 20) -> dict:
        """Recent requester-owned file requests and Drive questions, metadata only.

        The requester already sees these statuses in Consent Center. Chat only
        needs a human counterpart label and a timestamp; it must not receive a
        Drive request id that could be mistaken for an information-bundle cancel
        handle, or the owner's private preparation failure.
        """
        if not user_id or type(limit) is not int or not 1 <= limit <= 50:
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            # The question table arrived after file requests. Older deployments
            # can still report their file requests while that schema rolls out.
            queries_installed = bool(
                connection.execute(
                    text("SELECT to_regclass('drive_live_query_requests') IS NOT NULL")
                ).scalar_one()
            )
            question_rows = (
                """
                UNION ALL
                SELECT request_id,status,revision,created_at,expires_at,decided_at,
                       user_id AS owner_user_id,'question'::text AS request_type
                FROM drive_live_query_requests WHERE requester_user_id=:user
                """
                if queries_installed
                else ""
            )
            rows = (
                connection.execute(
                    text(f"""
                    SELECT request.*,owner.user_id,owner.display_name,owner.email
                    FROM (
                      SELECT request_id,status,revision,created_at,expires_at,
                             NULL::timestamptz AS decided_at,user_id AS owner_user_id,
                             'files'::text AS request_type
                      FROM drive_share_requests WHERE recipient_user_id=:user
                      {question_rows}
                    ) request
                    LEFT JOIN actor_identity_cache owner ON owner.user_id=request.owner_user_id
                    ORDER BY request.created_at DESC,request.request_id DESC
                    LIMIT :limit
                    """),  # nosec B608 -- optional SQL fragment is a static literal
                    {"user": user_id, "limit": limit + 1},
                )
                .mappings()
                .all()
            )
            now = datetime.now(UTC)
            return {
                "items": [
                    {
                        "person": label_from_identity_row(row, allow_email_handle=True) or None,
                        "requestType": row["request_type"],
                        "status": self._chat_request_status(row, now=now),
                        "sentAt": row["created_at"].isoformat(),
                    }
                    for row in rows[:limit]
                ],
                "hasMore": len(rows) > limit,
            }

        return await self._transaction(operation)

    async def list_requests(self, *, user_id, direction, limit=20, offset=0):
        if (
            direction not in {"incoming", "outgoing"}
            or type(limit) is not int
            or not 1 <= limit <= 50
            or type(offset) is not int
            or not 0 <= offset <= 10000
        ):
            raise DriveSharingError("invalid_argument")

        def operation(connection):
            rows = (
                connection.execute(
                    text("""
                SELECT request_id,status,revision,created_at,expires_at FROM drive_share_requests
                WHERE (:outgoing=TRUE AND recipient_user_id=:user)
                   OR (:outgoing=FALSE AND user_id=:user)
                UNION ALL
                SELECT request_id,'management_only',revocation_revision,created_at,NULL
                FROM drive_share_management_contexts
                WHERE :outgoing=FALSE AND user_id=:user AND private_request_erased_at IS NOT NULL
                ORDER BY created_at DESC,request_id DESC LIMIT :limit OFFSET :offset
                """),
                    {
                        "user": user_id,
                        "outgoing": direction == "outgoing",
                        "limit": limit + 1,
                        "offset": offset,
                    },
                )
                .mappings()
                .all()
            )
            return {
                "items": [
                    {
                        **self._summary(row, recipient=direction == "outgoing"),
                        "createdAt": row["created_at"].isoformat(),
                        "direction": direction,
                        **(
                            self._payment_metadata(connection, row["request_id"])
                            if direction == "outgoing"
                            else {}
                        ),
                    }
                    for row in rows[:limit]
                ],
                "hasMore": len(rows) > limit,
            }

        return await self._transaction(operation)

    async def delivery_snapshot(self, *, user_id, request_id):
        """Internal only: the service verifies recipient identity before release.

        The request and exact receipts are read under one lock. Status is the
        recorded provider outcome, never a promise about Google's current ACL.
        """
        request_id = str(UUID(request_id))

        def operation(connection):
            request = self._row(
                connection,
                """
                SELECT * FROM drive_share_requests WHERE request_id=:id
                  AND (user_id=:user OR recipient_user_id=:user) FOR SHARE
                """,
                {"id": request_id, "user": user_id},
            )
            if not request:
                context = self._row(
                    connection,
                    """
                    SELECT request_id,user_id,revocation_revision FROM drive_share_management_contexts
                    WHERE request_id=:id AND user_id=:user AND private_request_erased_at IS NOT NULL FOR SHARE
                """,
                    {"id": request_id, "user": user_id},
                )
                if not context:
                    raise DriveSharingError("request_unavailable")
                request = {
                    **context,
                    "status": "management_only",
                    "revision": context["revocation_revision"],
                    "recipient_user_id": None,
                }
            recipient = request["recipient_user_id"] == user_id
            payment = self._payment_metadata(connection, request_id) if recipient else {}
            private = self._open_request(request) if request.get("request_envelope") else None
            grants = (
                connection.execute(
                    text("""
                SELECT g.*, r.state AS revoke_state FROM drive_share_permission_operations g
                LEFT JOIN LATERAL (
                  SELECT state FROM drive_share_permission_operations r
                  WHERE r.parent_operation_id=g.operation_id AND r.kind='revoke'
                  ORDER BY created_at DESC,operation_id DESC LIMIT 1
                ) r ON TRUE
                WHERE g.request_id=:request AND g.kind='grant'
                ORDER BY g.created_at,g.operation_id LIMIT :limit
                """),
                    {"request": request_id, "limit": MAX_FILES + 1},
                )
                .mappings()
                .all()
            )
            if len(grants) > MAX_FILES:
                raise DriveSharingError("sharing_storage_unavailable")
            bulks = (
                connection.execute(
                    text("""SELECT share_id,status,file_count,progressive_batch
                FROM drive_bulk_shares WHERE origin_request_id=:request
                  AND user_id=:owner AND approved_at IS NOT NULL
                  AND expires_at>clock_timestamp()
                ORDER BY created_at,share_id"""),
                    {"request": request_id, "owner": request["user_id"]},
                )
                .mappings()
                .all()
                if request.get("user_id")
                else []
            )
            if (
                recipient
                and request.get("payment_required")
                and payment.get("paymentStatus") != "paid"
            ):
                bulks = []
            bulk_shared = 0
            bulk_summary = None
            bulk_file_count = 0
            if bulks:
                counts = Counter()
                issues = Counter()
                for bulk in bulks:
                    active_request = request_id if bulk["progressive_batch"] else None
                    total = (
                        connection.execute(
                            text("""SELECT count(*) FROM drive_bulk_share_files
                            WHERE share_id=:share AND origin_request_id=:request"""),
                            {"share": bulk["share_id"], "request": request_id},
                        ).scalar_one()
                        if active_request is not None
                        else bulk["file_count"]
                    )
                    bulk_file_count += total
                    summary = bulk_outcome_summary(
                        connection,
                        share_id=bulk["share_id"],
                        total=total,
                        recipient_user_id=request["recipient_user_id"],
                        active_request_id=active_request,
                    )
                    counts.update(summary["counts"])
                    issues.update({item["reasonCode"]: item["count"] for item in summary["issues"]})
                bulk_summary = {
                    "counts": dict(counts),
                    "issues": [
                        {"reasonCode": reason, "count": count}
                        for reason, count in sorted(issues.items())
                    ],
                }
                bulk_shared = (
                    bulk_summary["counts"]["shared"] + bulk_summary["counts"]["alreadyShared"]
                )
            files = []
            for row in grants:
                removed = row["revoke_state"] in {"succeeded", "absent"}
                delivered = row["state"] in {"succeeded", "preexisting", "present_unattributed"}
                # B sees no private candidates or failed/uncertain file names.
                if recipient and (not delivered or removed):
                    continue
                if (
                    recipient
                    and request.get("payment_required")
                    and payment.get("paymentStatus") != "paid"
                ):
                    continue
                plan = self._plan(row)
                file_id = plan["file_id"]
                if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                    raise DriveSharingError("sharing_storage_unavailable")
                item = {
                    "name": plan["file_name"],
                    "status": "removed" if removed else row["state"],
                    "revocationStatus": row["revoke_state"],
                    "otherAccessMayRemain": bool(row["revoke_state"]),
                }
                if delivered and not removed:
                    # Construct an approved original-file link, never a retrieved URL.
                    item["openUrl"] = f"https://drive.google.com/file/d/{file_id}/view"
                if not recipient:
                    receipt = self._receipt(row) if row["receipt_envelope"] else {}
                    item.update(
                        {
                            "grantId": str(row["operation_id"]),
                            "manageInGoogle": row["safe_error_code"]
                            == "permission_requires_google_management",
                            "managed": row["state"] == "succeeded"
                            and receipt.get("managed") is True,
                        }
                    )
                files.append(item)
            return {
                "recipient": private["recipient"] if recipient and private else None,
                "result": {
                    **self._summary(request, recipient=recipient),
                    **payment,
                    "files": [] if bulks else files,
                    **(
                        {
                            "bulkShareId": str(bulks[-1]["share_id"]),
                            "progressiveBatch": any(bulk["progressive_batch"] for bulk in bulks),
                            "batchCount": len(bulks),
                            "fileCount": bulk_file_count,
                            "sharedCount": bulk_shared,
                            "sharingStatus": "running"
                            if request["status"] == "pending"
                            else "completed"
                            if request["status"] == "completed"
                            else "partial"
                            if request["status"] == "partial"
                            else bulks[-1]["status"],
                            "bulkStatus": bulks[-1]["status"]
                            if not any(bulk["progressive_batch"] for bulk in bulks)
                            else "running"
                            if request["status"] == "pending"
                            else "completed"
                            if request["status"] == "completed"
                            else "partial"
                            if request["status"] == "partial"
                            else bulks[-1]["status"],
                            **bulk_summary,
                            "nextCursor": None,
                        }
                        if bulks
                        else {}
                    ),
                    "recordedOutcomeOnly": True,
                    "disconnectDoesNotRevoke": True,
                    "otherAccessMayRemain": True,
                },
            }

        return await self._transaction(operation)
