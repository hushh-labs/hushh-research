"""Database authority for one request-bound Drive payment."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore


def _request_id(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        raise DriveSharingError("invalid_argument") from None


def _payer_ref(request_id: str, requester_user_id: str) -> str:
    return hashlib.sha256(f"{request_id}:{requester_user_id}".encode()).hexdigest()


class DriveRequestPaymentStore(ExternalConnectorLifecycleStore):
    @staticmethod
    def require_paid_if_required(connection, request_row) -> None:
        """Call inside every grant transaction, after locking the request."""
        if not request_row["payment_required"]:
            return
        row = (
            connection.execute(
                text("""SELECT status,paid_at,reconciliation_required FROM drive_request_payment_orders
                 WHERE request_id=:request FOR SHARE"""),
                {"request": request_row["request_id"]},
            )
            .mappings()
            .first()
        )
        if (
            row is None
            or row["status"] != "paid"
            or row["paid_at"] is None
            or row["reconciliation_required"]
        ):
            raise DriveSharingError("payment_required")

    @staticmethod
    def _event(connection, request, event_type: str) -> bool:
        result = connection.execute(
            text("""INSERT INTO drive_share_events
              (event_id,request_id,user_id,revision,event_type)
              VALUES (:event,:request,:user,:revision,:type)
              ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
            {
                "event": str(uuid4()),
                "request": request["request_id"],
                "user": request["recipient_user_id"],
                "revision": request["revision"],
                "type": event_type,
            },
        )
        return result.rowcount == 1

    def _ensure_ready(self, connection, *, user_id: str, request_id: str, share_id: str | None):
        from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

        request_id = _request_id(request_id)
        participant = self._row(
            connection,
            """SELECT user_id,recipient_user_id FROM drive_share_requests
               WHERE request_id=:request AND user_id=:user""",
            {"request": request_id, "user": user_id},
        )
        if participant is None:
            raise DriveSharingError("request_unavailable")
        # Payment order and Feed event inserts use the participant identity
        # guard. Take its graph gates before the request row, as erasure does.
        lock_connection_graph_users(
            connection, user_ids=[participant["user_id"], participant["recipient_user_id"]]
        )
        request = self._row(
            connection,
            """SELECT * FROM drive_share_requests WHERE request_id=:request
               AND user_id=:user FOR UPDATE""",
            {"request": request_id, "user": user_id},
        )
        if request is None:
            raise DriveSharingError("request_unavailable")
        if not request["payment_required"]:
            return request, None, False
        existing = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request",
            {"request": request["request_id"]},
        )
        if existing is not None:
            notified = False
            if (
                existing["status"] in {"awaiting_payment", "checkout_open"}
                and request["status"] == "pending"
                and request["expires_at"] > datetime.now(UTC)
            ):
                notified = self._event(connection, request, "document_share_payment_ready")
            return request, existing, notified
        batch = self._row(
            connection,
            """SELECT b.share_id FROM drive_bulk_shares b
               JOIN drive_bulk_share_recipients r ON r.share_id=b.share_id
                 AND r.recipient_user_id=:requester
               WHERE b.origin_request_id=:request AND b.user_id=:user
                 AND b.progressive_batch=TRUE
                 AND b.file_count>0 AND b.recipient_count=1
                 AND b.status IN ('review_ready','queued','running','completed','partial')
                 AND EXISTS (SELECT 1 FROM drive_bulk_share_files f
                             WHERE f.share_id=b.share_id)
                 AND :request_status='pending' AND :request_expires>clock_timestamp()
                 AND (CAST(:share AS uuid) IS NULL OR b.share_id=CAST(:share AS uuid))
               ORDER BY b.created_at LIMIT 1""",
            {
                "request": request["request_id"],
                "user": user_id,
                "requester": request["recipient_user_id"],
                "request_status": request["status"],
                "request_expires": request["expires_at"],
                "share": _request_id(share_id) if share_id else None,
            },
        )
        if batch is None:
            return request, None, False
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id)
              VALUES (:request,:owner,:requester)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request["request_id"],
                "owner": user_id,
                "requester": request["recipient_user_id"],
            },
        )
        order = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request",
            {"request": request["request_id"]},
        )
        notified = False
        if order and order["status"] in {"awaiting_payment", "checkout_open"}:
            notified = self._event(connection, request, "document_share_payment_ready")
        return request, order, notified

    async def ensure_payment_for_frozen_batch(
        self, user_id: str, request_id: str, share_id: str
    ) -> dict:
        def operation(connection):
            request, order, notified = self._ensure_ready(
                connection, user_id=user_id, request_id=request_id, share_id=share_id
            )
            if not request["payment_required"]:
                return {"status": "paid"}
            if order is None:
                raise DriveSharingError("payment_not_ready")
            status = (
                "reconciliation_required"
                if order["reconciliation_required"]
                else "paid"
                if order["status"] == "paid"
                else "awaiting_payment"
            )
            return {"status": status, "notificationQueued": notified}

        return await self._transaction(operation)

    async def payment_state(self, *, requester_user_id: str, request_id: str) -> dict:
        def operation(connection):
            request = self._row(
                connection,
                """SELECT request_id,user_id,recipient_user_id,payment_required,status,expires_at
                   FROM drive_share_requests WHERE request_id=:request
                     AND recipient_user_id=:requester""",
                {"request": _request_id(request_id), "requester": requester_user_id},
            )
            if request is None:
                raise DriveSharingError("request_unavailable")
            if not request["payment_required"]:
                return {"status": "not_required", "amountCents": 0, "currency": "usd"}
            _, order, notified = self._ensure_ready(
                connection, user_id=request["user_id"], request_id=request_id, share_id=None
            )
            if order is None and (
                request["status"] in {"cancelled", "declined", "expired"}
                or request["expires_at"] <= datetime.now(UTC)
            ):
                status = "expired"
            elif order is None:
                status = "preparing"
            elif order["status"] not in {"paid", "refunded"} and (
                request["status"] in {"cancelled", "declined", "expired"}
                or request["expires_at"] <= datetime.now(UTC)
            ):
                status = "expired"
            else:
                status = order["status"]
            return {
                "status": status,
                "amountCents": 1000,
                "currency": "usd",
                "reconciliationRequired": bool(
                    order and order["reconciliation_required"] and order["status"] != "refunded"
                ),
                "_notificationQueued": notified,
            }

        result = await self._transaction(operation)
        if result.pop("_notificationQueued", False):
            await wake_drive_work("sharing")
        return result
