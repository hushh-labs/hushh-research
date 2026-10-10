"""Database authority for one request-bound Drive payment.

An order's amount is fixed when the order is created: the owner's price from
an owner Allow, otherwise the default price. Checkout, settlement and refunds
all bind to that stored amount.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_owner_allowed import (
    DEFAULT_PRICE_CENTS,
    owner_allowed_price_cents,
    valid_owner_price_cents,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore


def _request_id(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        raise DriveSharingError("invalid_argument") from None


def _payer_ref(request_id: str, requester_user_id: str) -> str:
    return hashlib.sha256(f"{request_id}:{requester_user_id}".encode()).hexdigest()


def _order_amount_cents(request: Mapping[str, Any], private: Mapping[str, Any]) -> int:
    """An immutable request quote wins over the legacy Allow/default price."""
    if private.get("owner_settlement_required") is True and not valid_owner_price_cents(
        request.get("quoted_amount_cents")
    ):
        raise DriveSharingError("owner_price_required")
    if request.get("quoted_amount_cents") is not None:
        return int(request["quoted_amount_cents"])
    return owner_allowed_price_cents(private) or DEFAULT_PRICE_CENTS


def _quoted_amount_cents(
    request: Mapping[str, Any], order: Mapping[str, Any] | None, private: Mapping[str, Any] | None
) -> int:
    """The stored order amount; before an order exists, the price it would be created at."""
    if order is not None:
        return int(order["amount_cents"])
    if request.get("quoted_amount_cents") is not None:
        return int(request["quoted_amount_cents"])
    if private is None:
        return DEFAULT_PRICE_CENTS
    return _order_amount_cents(request, private)


def _record_new_owner_payout(
    connection,
    *,
    request_id: str,
    owner_user_id: str,
    amount_cents: int,
    quoted_request: bool = False,
) -> None:
    """Enroll only new orders, atomically with their immutable payment price."""
    from hushh_mcp.services.drive_request_owner_payout_service import (
        DriveRequestOwnerPayoutService,
        payout_enabled,
    )

    if quoted_request or payout_enabled():
        if quoted_request:
            if not payout_enabled():
                raise DriveSharingError("payout_unavailable")
            account = (
                connection.execute(
                    text(
                        "SELECT account_ready FROM pkm_owner_payout_accounts WHERE user_id=:owner"
                    ),
                    {"owner": owner_user_id},
                )
                .mappings()
                .first()
            )
            if account is None or account["account_ready"] is not True:
                raise DriveSharingError("owner_payout_required")
        DriveRequestOwnerPayoutService.record_order(
            connection,
            request_id=request_id,
            owner_user_id=owner_user_id,
            amount_cents=amount_cents,
        )


class DriveRequestPaymentStore(ExternalConnectorLifecycleStore):
    async def due_checkout_orders(self, *, limit: int = 20) -> list[dict[str, str]]:
        """Read bounded eligible orders; checkout rechecks all authority under locks."""
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("invalid checkout preparation bound")

        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""SELECT o.request_id::text AS request_id,o.requester_user_id
                      FROM drive_request_payment_orders o
                      JOIN drive_share_requests r ON r.request_id=o.request_id
                      WHERE o.status='awaiting_payment'
                        AND o.stripe_checkout_session_id IS NULL
                        AND r.payment_required=TRUE
                        AND r.status IN ('pending','approved','partial')
                        AND r.expires_at>clock_timestamp()
                        AND r.access_stop_requested_at IS NULL
                        AND (r.status IN ('approved','partial') OR EXISTS (
                          SELECT 1 FROM drive_bulk_shares b
                          JOIN drive_bulk_share_recipients recipient
                            ON recipient.share_id=b.share_id
                          WHERE b.origin_request_id=r.request_id
                            AND b.origin_request_revision=r.revision
                            AND b.user_id=r.user_id
                            AND b.progressive_batch=TRUE
                            AND b.file_count>0 AND b.recipient_count=1
                            AND recipient.recipient_user_id=r.recipient_user_id
                            AND ((b.status='review_ready' AND b.approved_at IS NULL)
                              OR (b.approval_source='owner'
                                AND b.approved_at IS NOT NULL
                                AND b.status IN ('queued','running','completed','partial')))
                        ))
                      ORDER BY o.updated_at,o.request_id LIMIT :limit"""),
                    {"limit": limit},
                )
                .mappings()
                .all()
            ]

        return await self._transaction(operation)

    async def defer_unready_checkout_order(
        self, *, request_id: str, requester_user_id: str
    ) -> None:
        """Move a stale candidate behind newer orders without granting authority."""
        request_id = _request_id(request_id)

        def operation(connection):
            from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

            participant = self._row(
                connection,
                """SELECT user_id,recipient_user_id FROM drive_share_requests
                   WHERE request_id=:request AND recipient_user_id=:requester""",
                {"request": request_id, "requester": requester_user_id},
            )
            if participant is None:
                return
            lock_connection_graph_users(
                connection,
                user_ids=[participant["user_id"], participant["recipient_user_id"]],
            )
            request = self._row(
                connection,
                """SELECT request_id FROM drive_share_requests
                   WHERE request_id=:request AND recipient_user_id=:requester FOR UPDATE""",
                {"request": request_id, "requester": requester_user_id},
            )
            if request is None:
                return
            connection.execute(
                text("""UPDATE drive_request_payment_orders
                   SET updated_at=clock_timestamp()
                   WHERE request_id=:request AND requester_user_id=:requester
                     AND status='awaiting_payment'
                     AND stripe_checkout_session_id IS NULL"""),
                {"request": request_id, "requester": requester_user_id},
            )

        await self._transaction(operation)

    @staticmethod
    def owner_approved_progressive_batch(connection, request) -> bool:
        """A pending request may charge only for an explicit owner-approved batch."""
        return bool(
            connection.execute(
                text("""SELECT EXISTS (
                  SELECT 1 FROM drive_bulk_shares b
                  JOIN drive_bulk_share_recipients r ON r.share_id=b.share_id
                  WHERE b.origin_request_id=:request AND b.user_id=:owner
                    AND b.origin_request_revision=:revision
                    AND b.progressive_batch=TRUE AND b.approval_source='owner'
                    AND b.approved_at IS NOT NULL AND b.file_count>0
                    AND b.recipient_count=1 AND r.recipient_user_id=:requester
                    AND b.status IN ('queued','running','completed','partial')
                )"""),
                {
                    "request": request["request_id"],
                    "owner": request["user_id"],
                    "revision": request["revision"],
                    "requester": request["recipient_user_id"],
                },
            ).scalar_one()
        )

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

    @classmethod
    def ensure_order_for_approved_request(cls, connection, request) -> bool:
        """Create the requester payment order after owner consent commits.

        Non-trusted requests intentionally keep the owner's consent boundary:
        approval creates the order, while the permission worker remains
        blocked until Stripe confirms payment. The ready event is emitted
        only after a Checkout session with a fixed deadline is bound. A request
        the owner allowed keeps the owner's price; a legacy manual approval
        uses the default price.
        """
        if not request["payment_required"]:
            return False
        private = DriveSharingCipher().open(
            request["request_envelope"],
            user_id=request["user_id"],
            resource_id=str(request["request_id"]),
            purpose="request",
        )
        amount_cents = _order_amount_cents(request, private)
        inserted = connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,amount_cents)
              VALUES (:request,:owner,:requester,:amount)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request["request_id"],
                "owner": request["user_id"],
                "requester": request["recipient_user_id"],
                "amount": amount_cents,
            },
        )
        if inserted.rowcount == 1:
            _record_new_owner_payout(
                connection,
                request_id=str(request["request_id"]),
                owner_user_id=request["user_id"],
                amount_cents=amount_cents,
                quoted_request=request.get("quoted_amount_cents") is not None,
            )
        order = (
            connection.execute(
                text("SELECT status FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request["request_id"]},
            )
            .mappings()
            .first()
        )
        return bool(order and order["status"] in {"awaiting_payment", "checkout_open"})

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
        if request["access_stop_requested_at"] is not None:
            return request, existing, False
        if existing is not None and (
            request["status"] not in {"pending", "approved", "partial"}
            or request["expires_at"] <= datetime.now(UTC)
        ):
            return request, existing, False
        from hushh_mcp.services.drive_sharing_store import DriveSharingStore

        private = DriveSharingStore(db=self.db)._open_request(request)
        if request["status"] == "pending" and request["expires_at"] > datetime.now(UTC):
            purpose = private.get("purpose", {})
            if not (purpose.get("periodStart") and purpose.get("periodEnd")):
                # Preserve paid/refunded state for reconciliation, while
                # withholding new checkout and payment-ready authority.
                if existing is not None and existing["status"] == "paid":
                    if not existing["reconciliation_required"]:
                        connection.execute(
                            text("""UPDATE drive_request_payment_orders
                          SET reconciliation_required=TRUE,
                            reconciliation_reason='authority_changed',
                            reconciliation_at=clock_timestamp(),
                            updated_at=clock_timestamp()
                          WHERE request_id=:request AND status='paid'
                            AND reconciliation_required=FALSE"""),
                            {"request": request["request_id"]},
                        )
                        existing = {**existing, "reconciliation_required": True}
                    return request, existing, False
                if existing is not None and existing["status"] == "refunded":
                    return request, existing, False
                raise DriveSharingError("date_range_required")
        if private.get("trusted_auto") is not True:
            raise DriveSharingError("payment_not_ready")
        if existing is not None:
            return request, existing, False
        # This is an explicit worker command for the automatic path: a Trusted
        # request, or one the owner allowed at their price. A manual owner
        # approval creates the non-trusted order in the approval transaction;
        # an unapproved review must never create a payment obligation here.
        batch = self._row(
            connection,
            """SELECT b.share_id FROM drive_bulk_shares b
               JOIN drive_bulk_share_recipients r ON r.share_id=b.share_id
                 AND r.recipient_user_id=:requester
               WHERE b.origin_request_id=:request AND b.user_id=:user
                 AND b.progressive_batch=TRUE
                 AND b.file_count>0 AND b.recipient_count=1
                 AND b.status='review_ready' AND b.approved_at IS NULL
                 AND EXISTS (SELECT 1 FROM drive_bulk_share_files f
                             WHERE f.share_id=b.share_id)
                 AND :request_status IN ('pending','approved','partial')
                 AND :request_expires>clock_timestamp()
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
        amount_cents = _order_amount_cents(request, private)
        inserted = connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,amount_cents)
              VALUES (:request,:owner,:requester,:amount)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request["request_id"],
                "owner": user_id,
                "requester": request["recipient_user_id"],
                "amount": amount_cents,
            },
        )
        if inserted.rowcount == 1:
            _record_new_owner_payout(
                connection,
                request_id=str(request["request_id"]),
                owner_user_id=user_id,
                amount_cents=amount_cents,
                quoted_request=request.get("quoted_amount_cents") is not None,
            )
        order = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request",
            {"request": request["request_id"]},
        )
        return request, order, False

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
                """SELECT *
                   FROM drive_share_requests WHERE request_id=:request
                     AND recipient_user_id=:requester""",
                {"request": _request_id(request_id), "requester": requester_user_id},
            )
            if request is None:
                raise DriveSharingError("request_unavailable")
            if not request["payment_required"]:
                return {"status": "not_required", "amountCents": 0, "currency": "usd"}
            order = self._row(
                connection,
                """SELECT o.*,EXISTS(SELECT 1 FROM drive_request_owner_payouts p
                     WHERE p.request_id=o.request_id) AS payout_enrolled
                   FROM drive_request_payment_orders o
                   WHERE o.request_id=:request AND o.requester_user_id=:requester""",
                {"request": request["request_id"], "requester": requester_user_id},
            )
            payout_enrolled = bool(order and order.get("payout_enrolled"))
            request_expired = (
                request["status"]
                in {
                    "cancelled",
                    "declined",
                    "no_match",
                    "expired",
                }
                or (request["expires_at"] <= datetime.now(UTC))
                or (request["access_stop_requested_at"] is not None)
            )
            missing_dates = False
            approved = False
            private: dict[str, Any] | None = None
            if not request_expired:
                from hushh_mcp.services.drive_sharing_store import DriveSharingStore

                private = DriveSharingStore(db=self.db)._open_request(request)
                purpose = private.get("purpose", {})
                missing_dates = request["status"] == "pending" and not (
                    purpose.get("periodStart") and purpose.get("periodEnd")
                )
                if missing_dates and (order is None or order["status"] not in {"paid", "refunded"}):
                    raise DriveSharingError("date_range_required")
                # An old order produced by the former GET side effect is not
                # actionable unless the owner actually approved a batch.
                approved = (
                    private.get("trusted_auto") is True
                    or request["status"] in {"approved", "partial", "completed"}
                    or self.owner_approved_progressive_batch(connection, request)
                )
            checkout_expired = bool(
                order
                and order["status"] not in {"paid", "refunded"}
                and order.get("stripe_checkout_session_id") is not None
                and (
                    order.get("stripe_checkout_expires_at") is None
                    or order["stripe_checkout_expires_at"] <= datetime.now(UTC)
                )
            )
            if order is None:
                status = "expired" if request_expired else "preparing"
            elif order["status"] not in {"paid", "refunded"} and (
                request_expired or checkout_expired
            ):
                status = "expired"
            elif not approved and order["status"] not in {"paid", "refunded"}:
                status = "preparing"
            else:
                status = order["status"]
            setup = {}
            if private is not None and (
                order is None or order["status"] not in {"paid", "refunded"}
            ):
                setup = DriveSharingStore(db=self.db)._request_setup(connection, request, private)
            elif (
                order is None
                and request.get("quoted_amount_cents") is None
                and request.get("preparation_error_code")
                in {"owner_price_required", "owner_payout_required", "payout_unavailable"}
            ):
                # Expiry does not invent a charge for a request that never had a price.
                setup = {"ownerPriceRequired": True}
            return {
                "status": status,
                "amountCents": None
                if setup.get("ownerPriceRequired")
                else _quoted_amount_cents(request, order, private),
                "currency": order["currency"] if order is not None else "usd",
                "paymentLinkExpired": checkout_expired and not request_expired,
                "checkoutExpiresAt": (
                    order["stripe_checkout_expires_at"].isoformat()
                    if order
                    and order.get("stripe_checkout_session_id") is not None
                    and order.get("stripe_checkout_expires_at") is not None
                    else None
                ),
                "reconciliationRequired": bool(
                    order
                    and (
                        order["reconciliation_required"]
                        or missing_dates
                        or (not approved and not request_expired)
                    )
                    and order["status"] == "paid"
                ),
                # Internal preflight only; get_payment strips these before
                # the requester API response. The owner is not disclosed.
                "_payout_enrolled": payout_enrolled,
                "_payout_owner_user_id": request["user_id"] if payout_enrolled else None,
                **setup,
            }

        return await self._transaction(operation)

    async def repair_paid_request_authority(self, *, limit: int = 64) -> int:
        """Move legacy paid-request correction off the read path.

        Old GETs could make an order before consent. Rotate a bounded set of
        paid orders on each scheduled reconciliation pass, so a valid older
        order cannot starve a malformed one indefinitely.
        """
        if type(limit) is not int or not 1 <= limit <= 256:
            raise ValueError("invalid repair limit")

        def operation(connection):
            from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
            from hushh_mcp.services.drive_sharing_store import DriveSharingStore

            candidates = (
                connection.execute(
                    text("""SELECT r.request_id,r.user_id,r.recipient_user_id
                  FROM drive_request_payment_orders o
                  JOIN drive_share_requests r ON r.request_id=o.request_id
                  WHERE o.status='paid' AND o.reconciliation_required=FALSE
                    AND r.payment_required=TRUE
                    AND r.status IN ('pending','approved','partial')
                  ORDER BY o.updated_at,o.request_id LIMIT :limit"""),
                    {"limit": limit},
                )
                .mappings()
                .all()
            )
            if not candidates:
                return 0
            lock_connection_graph_users(
                connection,
                user_ids=sorted(
                    {
                        user
                        for row in candidates
                        for user in (row["user_id"], row["recipient_user_id"])
                    }
                ),
            )
            sharing = DriveSharingStore(db=self.db)
            repaired = 0
            for candidate in candidates:
                request = self._row(
                    connection,
                    "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
                    {"request": candidate["request_id"]},
                )
                order = self._row(
                    connection,
                    """SELECT * FROM drive_request_payment_orders
                       WHERE request_id=:request FOR UPDATE""",
                    {"request": candidate["request_id"]},
                )
                if (
                    request is None
                    or order is None
                    or order["status"] != "paid"
                    or order["reconciliation_required"]
                ):
                    continue
                private = sharing._open_request(request)
                purpose = private.get("purpose", {})
                # Trusted creation and an owner's Allow both seal trusted_auto.
                authorized = (
                    private.get("trusted_auto") is True
                    or request["status"] in {"approved", "partial"}
                    or self.owner_approved_progressive_batch(connection, request)
                )
                invalid = (
                    request["status"] == "pending"
                    and not (purpose.get("periodStart") and purpose.get("periodEnd"))
                ) or not authorized
                if invalid:
                    connection.execute(
                        text("""UPDATE drive_request_payment_orders
                          SET reconciliation_required=TRUE,
                            reconciliation_reason='authority_changed',
                            reconciliation_at=clock_timestamp(),updated_at=clock_timestamp()
                          WHERE request_id=:request AND status='paid'
                            AND reconciliation_required=FALSE"""),
                        {"request": request["request_id"]},
                    )
                    repaired += 1
                else:
                    # Existing updated_at is a durable, indexed enough
                    # rotation cursor for this small bounded repair pass.
                    connection.execute(
                        text("""UPDATE drive_request_payment_orders
                          SET updated_at=clock_timestamp() WHERE request_id=:request"""),
                        {"request": request["request_id"]},
                    )
            return repaired

        return await self._transaction(operation)
