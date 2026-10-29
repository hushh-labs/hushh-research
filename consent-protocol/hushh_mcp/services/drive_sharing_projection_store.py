"""Bounded participant projections; private suggestions never cross to B."""

from collections import Counter
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.document_delivery.background_consent import summary as copy_summary
from hushh_mcp.services.drive_bulk_share_store import bulk_outcome_summary, issue_list
from hushh_mcp.services.drive_live_query_store import STALE_CLAIM_SECONDS
from hushh_mcp.services.drive_request_recovery_view import (
    RECOVERY_REQUEST_STATUSES,
    owner_review_request_view,
)
from hushh_mcp.services.drive_request_requester_store import recovery_for
from hushh_mcp.services.drive_revocation_store import DriveRevocationStore
from hushh_mcp.services.drive_sharing_contract import MAX_FILES, DriveSharingError
from hushh_mcp.services.google_drive_adapter import FILE_ID
from hushh_mcp.services.requester_identity import label_from_identity_row
from hushh_mcp.services.stripe_mode import configured_stripe_mode


class DriveSharingProjectionStore(DriveRevocationStore):
    async def calendar_request_snapshot(
        self, *, user_id: str, account_id: str, occurrence_id: str
    ) -> list[dict]:
        """Internal requester-only exact-file associations from existing receipts.

        The service rechecks each sealed Calendar recipient before releasing this
        result. No candidate or uncertain operation enters the file list.
        """
        client_ids = [
            str(
                self.sharing_cipher.calendar_client_id(
                    user_id,
                    account_id,
                    occurrence_id,
                    types,
                )
            )
            for types in (("recording",), ("notes",), ("recording", "notes"))
        ]

        def operation(connection):
            rows = list(
                connection.execute(
                    text("""SELECT * FROM drive_share_requests
                WHERE recipient_user_id=:user AND client_request_id IN (:one,:two,:both)"""),
                    {
                        "user": user_id,
                        "one": client_ids[0],
                        "two": client_ids[1],
                        "both": client_ids[2],
                    },
                ).mappings()
            )
            result = []
            for row in rows:
                private = self._open_request(row)
                calendar = private.get("calendar")
                if (
                    private.get("request_type") != "calendar_meeting"
                    or not isinstance(calendar, dict)
                    or calendar.get("account_id") != account_id
                    or calendar.get("occurrence_id") != occurrence_id
                ):
                    continue
                files = []
                if row.get("access_stop_requested_at") is None:
                    grants = list(
                        connection.execute(
                            text("""SELECT g.*,
                        (SELECT r.state FROM drive_share_permission_operations r
                         WHERE r.parent_operation_id=g.operation_id AND r.kind='revoke'
                         ORDER BY r.created_at DESC,r.operation_id DESC LIMIT 1) AS revoke_state
                        FROM drive_share_permission_operations g
                        WHERE g.request_id=:request AND g.kind='grant'
                        ORDER BY g.created_at,g.operation_id LIMIT :limit"""),
                            {"request": row["request_id"], "limit": MAX_FILES + 1},
                        ).mappings()
                    )
                    if len(grants) > MAX_FILES:
                        raise DriveSharingError("sharing_storage_unavailable")
                    for grant in grants:
                        if grant["state"] not in {
                            "succeeded",
                            "preexisting",
                            "present_unattributed",
                        }:
                            continue
                        if grant["revoke_state"] in {"succeeded", "absent"}:
                            continue
                        plan = self._plan(grant)
                        if (
                            plan.get("request_type") == "calendar_meeting"
                            and plan.get("artifact_kind") in calendar["requested_types"]
                            and isinstance(plan.get("file_id"), str)
                            and FILE_ID.fullmatch(plan["file_id"])
                        ):
                            files.append(
                                {"file_id": plan["file_id"], "kind": plan["artifact_kind"]}
                            )
                result.append(
                    {
                        **self._summary(row, recipient=True),
                        "requestedTypes": calendar["requested_types"],
                        "recipient": private["recipient"],
                        "files": files,
                    }
                )
            return result

        return await self._transaction(operation)

    @staticmethod
    def _access_stop_status(connection, request_id):
        """One request-wide verdict; only verified owned removals count as done."""
        bulk = (
            connection.execute(
                text("""SELECT
              count(*) FILTER (WHERE e.state IN ('queued','dispatching','unknown')
                OR e.state='succeeded' AND e.receipt_envelope IS NOT NULL
                  AND (removal.removal_id IS NULL
                    OR removal.state IN ('queued','dispatching','unknown'))) AS pending,
              count(*) FILTER (WHERE e.state IN ('preexisting','present_unattributed')
                OR e.state='succeeded' AND e.receipt_envelope IS NULL
                OR removal.state IN ('needs_review','unavailable')) AS attention
              FROM drive_bulk_share_effects e
              JOIN drive_bulk_shares b ON b.share_id=e.share_id
              LEFT JOIN drive_request_bulk_removals removal
                ON removal.share_id=e.share_id AND removal.position=e.position
                  AND removal.recipient_user_id=e.recipient_user_id
              WHERE b.origin_request_id=:request"""),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        legacy = (
            connection.execute(
                text("""SELECT
              count(*) FILTER (WHERE grant_operation.state IN ('queued','dispatching','unknown')
                OR grant_operation.state='succeeded' AND (removal.operation_id IS NULL
                  OR removal.state IN ('queued','dispatching','unknown'))) AS pending,
              count(*) FILTER (WHERE grant_operation.state IN ('preexisting','present_unattributed')
                OR removal.state IN ('needs_review','not_dispatched','rejected')) AS attention
              FROM drive_share_permission_operations grant_operation
              LEFT JOIN LATERAL (SELECT operation_id,state
                FROM drive_share_permission_operations removal
                WHERE removal.parent_operation_id=grant_operation.operation_id
                  AND removal.kind='revoke'
                ORDER BY created_at DESC,operation_id DESC LIMIT 1) removal ON TRUE
              WHERE grant_operation.request_id=:request AND grant_operation.kind='grant'"""),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        if bulk["pending"] or legacy["pending"]:
            return "pending"
        return "needs_attention" if bulk["attention"] or legacy["attention"] else "removed"

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
                SELECT r.request_id,r.status,r.revision,r.created_at,r.expires_at,
                       r.payment_required,r.quoted_amount_cents,r.quote_version,
                       p.status AS owner_payout_status,
                       CASE WHEN r.payment_required=TRUE AND r.settlement_method<>'hashcoins' AND
                         ((r.status IN ('pending','preparing','review_ready','approved','partial')
                           AND r.expires_at>clock_timestamp())
                          OR p.status IN ('awaiting_account','due','awaiting_delivery',
                            'awaiting_fee','awaiting_refund'))
                         THEN (COALESCE(account.details_submitted,FALSE)
                           AND COALESCE(account.payouts_enabled,FALSE))
                       END AS owner_payout_account_ready,
                       r.initial_quote_cents,r.owner_allowed_at,
                       o.amount_cents AS order_amount_cents
                FROM drive_share_requests r
                LEFT JOIN drive_request_owner_payouts p ON p.request_id=r.request_id
                  AND p.erased_at IS NULL
                LEFT JOIN stripe_owner_payout_accounts account ON account.user_id=r.user_id
                  AND account.stripe_mode=:stripe_mode
                LEFT JOIN drive_request_payment_orders o ON o.request_id=r.request_id
                WHERE (:outgoing=TRUE AND r.recipient_user_id=:user)
                   OR (:outgoing=FALSE AND r.user_id=:user)
                UNION ALL
                SELECT request_id,'management_only',revocation_revision,created_at,NULL,
                       NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
                FROM drive_share_management_contexts
                WHERE :outgoing=FALSE AND user_id=:user AND private_request_erased_at IS NOT NULL
                ORDER BY created_at DESC,request_id DESC LIMIT :limit OFFSET :offset
                """),
                    {
                        "user": user_id,
                        "outgoing": direction == "outgoing",
                        "stripe_mode": configured_stripe_mode(),
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
                            {"ownerPayoutStatus": row["owner_payout_status"]}
                            if direction == "incoming" and row["owner_payout_status"] is not None
                            else {}
                        ),
                        **(
                            {"ownerPayoutAccountReady": row["owner_payout_account_ready"] is True}
                            if direction == "incoming"
                            and row["owner_payout_account_ready"] is not None
                            else {}
                        ),
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

    async def delivery_snapshot(self, *, user_id, request_id, views=False):
        """Internal only: the service verifies recipient identity before release.

        The request and exact receipts are read under one lock. Status is the
        recorded provider outcome, never a promise about Google's current ACL.
        ``views`` (GET /delivery only) adds the requester's price and recovery,
        or the owner's review-request notice; file pages skip those reads.
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
            stop_requested = request.get("access_stop_requested_at") is not None
            access_stop_status = (
                self._access_stop_status(connection, request_id) if stop_requested else None
            )
            can_stop_access = (
                not recipient
                and not stop_requested
                and self._paid_frozen_batch(connection, user_id=user_id, request_id=request_id)
            )
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
                details = Counter()
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
                    details.update(
                        {
                            item["reasonCode"]: item["count"]
                            for item in summary.get("issueDetails", summary["issues"])
                        }
                    )
                bulk_summary = {
                    "counts": dict(counts),
                    # Codes released clients parse; exact newer codes are additive.
                    "issues": issue_list(issues),
                    **({"issueDetails": issue_list(details)} if details != issues else {}),
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
                if delivered and not removed and not stop_requested:
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
            # The legacy paymentAmountCents is the order amount, present only
            # once an order exists; the requester's price view reads it as final.
            summary_row = (
                {**request, "order_amount_cents": payment.get("paymentAmountCents")}
                if views and recipient
                else request
            )
            recovery = (
                recovery_for(connection, request)
                if views
                and request.get("recipient_user_id")
                and (
                    request["status"] in RECOVERY_REQUEST_STATUSES
                    or request.get("review_requested_at") is not None
                )
                else None
            )
            notice = (
                None
                if recipient
                else owner_review_request_view(
                    recovery, review_request_count=int(request.get("review_request_count") or 0)
                )
            )
            return {
                "recipient": private["recipient"] if recipient and private else None,
                "result": {
                    **copy_summary(self, summary_row, recipient, private),
                    **payment,
                    **(
                        {"noChargeReason": "existing_access"}
                        if private
                        and private.get("existing_access_delivery")
                        and request["status"] == "completed"
                        and not request["payment_required"]
                        and payment.get("paymentStatus") not in {"paid", "refunded"}
                        else {}
                    ),
                    **({"recovery": recovery} if recipient and recovery else {}),
                    **({"reviewRequest": notice} if notice else {}),
                    "accessStopStatus": access_stop_status,
                    "canStopAccess": can_stop_access,
                    "files": [] if bulks else files,
                    **(
                        {
                            "bulkShareId": str(bulks[-1]["share_id"]),
                            "progressiveBatch": any(bulk["progressive_batch"] for bulk in bulks),
                            "batchCount": len(bulks),
                            "fileCount": bulk_file_count,
                            "sharedCount": 0 if recipient and stop_requested else bulk_shared,
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
