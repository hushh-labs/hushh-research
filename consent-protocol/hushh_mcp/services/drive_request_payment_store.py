"""Database authority for one request-bound Drive payment.

An order's amount is fixed when the order is created: the owner's price from
an owner Allow, otherwise the default price. Checkout, settlement and refunds
all bind to that stored amount.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.payment_integration import optional_payment_state
from hushh_mcp.services.drive_owner_allowed import (
    DEFAULT_PRICE_CENTS,
    autoshare_owner_allow_authority,
    owner_allowed_price_cents,
    request_has_document_scope,
    valid_owner_price_cents,
)
from hushh_mcp.services.drive_request_payment_view import (
    order_view_input,
    requester_payment_view,
)
from hushh_mcp.services.drive_request_review_policy import request_requires_owner_review
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.stripe_mode import configured_stripe_mode


@dataclass(frozen=True)
class RetiredCheckout:
    """Server-observed terminal unpaid session; never accepted from a client."""

    session_id: str
    attempt_id: str
    stripe_mode: str
    observed_at: datetime


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
    settlement_method: str = "stripe_transfer",
) -> None:
    """Enroll only new orders, atomically with their immutable payment price."""
    from hushh_mcp.services.document_delivery.finance import payout_admitted
    from hushh_mcp.services.drive_request_owner_payout_service import (
        DriveRequestOwnerPayoutService,
        payout_enabled,
    )

    if quoted_request or payout_enabled():
        if quoted_request:
            if not payout_enabled() and not payout_admitted(
                connection,
                request_id=request_id,
                owner_user_id=owner_user_id,
                amount_cents=amount_cents,
            ):
                raise DriveSharingError("payout_unavailable")
            account = None
            if settlement_method != "hashcoins":
                account = (
                    connection.execute(
                        text(
                            "SELECT account_ready FROM stripe_owner_payout_accounts WHERE user_id=:owner AND stripe_mode=:stripe_mode"
                        ),
                        {"owner": owner_user_id, "stripe_mode": configured_stripe_mode()},
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
            settlement_method=settlement_method,
        )


def _search_exists(connection, request: Mapping[str, Any]) -> bool:
    """Whether this request's own search job exists yet; reads no results."""
    return bool(
        connection.execute(
            text("""SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs
              WHERE user_id=:owner AND client_request_id=:request)"""),
            {"owner": request["user_id"], "request": str(request["request_id"])},
        ).scalar_one()
    )


# Checkout verifies the live, exact owner-approved batch. Refunds use the
# durable obligation marker after request, search and share retention.
_V1_APPROVED_BATCH_REQUEST_SQL = text("""SELECT EXISTS (
  SELECT 1 FROM drive_share_requests r
  WHERE r.request_id=:request AND r.recipient_user_id=:requester
    AND r.user_id=COALESCE(:owner,r.user_id)
    AND r.revision=COALESCE(:revision,r.revision)
    AND EXISTS (
      SELECT 1 FROM drive_bulk_shares b
      JOIN drive_owner_search_jobs j
        ON j.job_id=b.search_job_id AND j.user_id=b.user_id
      JOIN drive_bulk_share_recipients recipient ON recipient.share_id=b.share_id
      WHERE b.origin_request_id=r.request_id
        AND b.origin_request_revision=r.revision
        AND b.user_id=r.user_id
        AND j.v1_statement_search=TRUE
        AND j.expires_at>clock_timestamp()
        AND b.progressive_batch=TRUE
        AND b.approval_source='owner' AND b.approved_at IS NOT NULL
        AND b.status IN ('queued','running','completed','partial')
        AND b.expires_at>clock_timestamp()
        AND b.file_count>0 AND b.recipient_count=1
        AND recipient.recipient_user_id=r.recipient_user_id
    )
)""")


class DriveRequestPaymentStore(ExternalConnectorLifecycleStore):
    @staticmethod
    def settle_existing_access_nocharge_locked(connection, request, retired=None) -> None:
        """Void only provably undispatched money authority in the caller's transaction.

        The caller holds graph, frozen-share and request locks and has verified
        exact recipient access. An allocated attempt can already be executing
        outside a transaction, even if its provider session is not bound yet.
        """
        identity = {"request": request["request_id"]}
        locked = {}
        statements = (
            (
                "orders",
                "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
            ),
            (
                "obligations",
                "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
            ),
            (
                "refunds",
                "SELECT * FROM drive_request_payment_refunds WHERE request_id=:request FOR UPDATE",
            ),
            (
                "owner_payouts",
                "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            ),
        )
        for name, statement in statements:
            locked[name] = connection.execute(text(statement), identity).mappings().first()
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        retired_current = isinstance(retired, RetiredCheckout) and (
            0 <= (now - retired.observed_at).total_seconds() <= 60
            and retired.stripe_mode == configured_stripe_mode()
        )
        if retired is not None and (
            not retired_current or locked["orders"] is None or locked["obligations"] is None
        ):
            raise DriveSharingError("payment_not_ready")
        for name in ("orders", "obligations"):
            row = locked[name]
            bound_retired = bool(
                retired_current
                and row is not None
                and row["stripe_checkout_session_id"] == retired.session_id
                and str(row["checkout_attempt_id"]) == retired.attempt_id
                and row["stripe_mode"] == retired.stripe_mode
            )
            if row is not None and (
                row["status"]
                not in (
                    {"awaiting_payment", "checkout_open", "expired"}
                    if bound_retired
                    else {"awaiting_payment", "expired"}
                )
                or row["paid_at"] is not None
                or row["checkout_attempt_id"] is not None
                and not bound_retired
                or row["stripe_checkout_session_id"] is not None
                and not bound_retired
                or row["stripe_payment_intent_id"] is not None
                or row["reconciliation_required"]
            ):
                raise DriveSharingError("payment_not_ready")
        if retired_current:
            if any(
                locked[name] is None
                or locked[name]["stripe_checkout_session_id"] != retired.session_id
                or str(locked[name]["checkout_attempt_id"]) != retired.attempt_id
                or locked[name]["stripe_mode"] != retired.stripe_mode
                for name in ("orders", "obligations")
            ):
                raise DriveSharingError("payment_not_ready")
        payout = locked["owner_payouts"]
        if (
            locked["refunds"] is not None
            or payout is not None
            and (
                payout["status"] not in {"awaiting_delivery", "void"}
                or payout["finalized_at"] is not None
                or payout["transfer_attempt_id"] is not None
            )
        ):
            raise DriveSharingError("payment_not_ready")
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='expired',
          stripe_checkout_url=NULL,updated_at=clock_timestamp()
          WHERE request_id=:request AND status IN ('awaiting_payment','checkout_open','expired')"""),
            identity,
        )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET status='void',
          next_check_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE request_id=:request AND status='awaiting_delivery' AND finalized_at IS NULL"""),
            identity,
        )
        if retired_current:
            connection.execute(
                text("""UPDATE drive_request_payment_obligations
                SET existing_access_waived_at=clock_timestamp()
                WHERE request_id=:request"""),
                identity,
            )

    async def due_checkout_orders(
        self, *, limit: int = 20, v1_only: bool = False
    ) -> list[dict[str, str]]:
        """Read bounded eligible orders; checkout rechecks all authority under locks."""
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("invalid checkout preparation bound")
        if type(v1_only) is not bool:
            raise ValueError("invalid checkout preparation mode")

        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""SELECT o.request_id::text AS request_id,o.requester_user_id
                      FROM drive_request_payment_orders o
                      JOIN drive_share_requests r ON r.request_id=o.request_id
                      WHERE o.status='awaiting_payment' AND o.stripe_mode=:stripe_mode
                        AND o.stripe_checkout_session_id IS NULL
                        AND r.payment_required=TRUE
                        AND r.status IN ('pending','approved','partial')
                        AND r.expires_at>clock_timestamp()
                        AND r.access_stop_requested_at IS NULL
                        AND (r.status IN ('approved','partial')
                          OR (r.owner_allowed_at IS NOT NULL
                            AND r.agent_package_required IS NOT TRUE)
                          OR EXISTS (
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
                        AND (NOT :v1_only OR EXISTS (
                          SELECT 1 FROM drive_bulk_shares v1_batch
                          JOIN drive_owner_search_jobs v1_search
                            ON v1_search.job_id=v1_batch.search_job_id
                            AND v1_search.user_id=v1_batch.user_id
                          JOIN drive_bulk_share_recipients v1_recipient
                            ON v1_recipient.share_id=v1_batch.share_id
                          WHERE v1_batch.origin_request_id=r.request_id
                            AND v1_batch.origin_request_revision=r.revision
                            AND v1_batch.user_id=r.user_id
                            AND v1_search.v1_statement_search=TRUE
                            AND v1_search.expires_at>clock_timestamp()
                            AND v1_batch.progressive_batch=TRUE
                            AND ((v1_batch.approval_source='owner'
                                  AND v1_batch.approved_at IS NOT NULL
                                  AND v1_batch.status IN ('queued','running','completed','partial'))
                              OR (r.v1_live_request=TRUE
                                AND ((v1_batch.status='review_ready' AND v1_batch.approved_at IS NULL)
                                  OR (v1_batch.approval_source='trusted_auto'
                                    AND v1_batch.approved_at IS NOT NULL
                                    AND v1_batch.status IN ('queued','running','completed','partial')))))
                            AND v1_batch.expires_at>clock_timestamp()
                            AND v1_batch.file_count>0 AND v1_batch.recipient_count=1
                            AND v1_recipient.recipient_user_id=r.recipient_user_id
                        ))
                      ORDER BY o.updated_at,o.request_id LIMIT :limit"""),
                    {
                        "limit": limit,
                        "stripe_mode": configured_stripe_mode(),
                        "v1_only": v1_only,
                    },
                )
                .mappings()
                .all()
            ]

        return await self._transaction(operation)

    async def defer_unready_checkout_order(
        self, *, request_id: str, requester_user_id: str, v1_only: bool = False
    ) -> None:
        """Move a stale candidate behind newer orders without granting authority."""
        request_id = _request_id(request_id)
        if type(v1_only) is not bool:
            raise ValueError("invalid checkout preparation mode")

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
                """SELECT * FROM drive_share_requests
                   WHERE request_id=:request AND recipient_user_id=:requester FOR UPDATE""",
                {"request": request_id, "requester": requester_user_id},
            )
            if request is None:
                return
            if v1_only and not self.v1_approved_progressive_batch(connection, request):
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
    def v1_approved_progressive_batch(connection, request) -> bool:
        """Require the live server-marked job and exact owner-approved batch."""
        from hushh_mcp.services.drive_v1_authority import v1_package_allowed

        if request.get("v1_live_request") is True and request.get("agent_package_required") is True:
            return v1_package_allowed(connection, request)
        return bool(
            connection.execute(
                _V1_APPROVED_BATCH_REQUEST_SQL,
                {
                    "request": request["request_id"],
                    "owner": request["user_id"],
                    "requester": request["recipient_user_id"],
                    "revision": request["revision"],
                },
            ).scalar_one_or_none()
        )

    async def v1_checkout_eligible(self, *, requester_user_id: str, request_id: str) -> bool:
        """Check live V1 provenance before payout or Stripe preflight I/O."""
        request_id = _request_id(request_id)

        def operation(connection):
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests
                  WHERE request_id=:request AND recipient_user_id=:requester""",
                {"request": request_id, "requester": requester_user_id},
            )
            return bool(request and self.v1_approved_progressive_batch(connection, request))

        return await self._transaction(operation)

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
                text("""SELECT status,paid_at,reconciliation_required,stripe_mode FROM drive_request_payment_orders
                 WHERE request_id=:request FOR SHARE"""),
                {"request": request_row["request_id"]},
            )
            .mappings()
            .first()
        )
        if (
            row is None
            or row.get("stripe_mode") != configured_stripe_mode()
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
              (request_id,user_id,requester_user_id,amount_cents,stripe_mode,settlement_method)
              VALUES (:request,:owner,:requester,:amount,:stripe_mode,:settlement_method)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request["request_id"],
                "owner": request["user_id"],
                "requester": request["recipient_user_id"],
                "amount": amount_cents,
                "stripe_mode": configured_stripe_mode(),
                "settlement_method": request.get("settlement_method", "stripe_transfer"),
            },
        )
        if inserted.rowcount == 1:
            _record_new_owner_payout(
                connection,
                request_id=str(request["request_id"]),
                owner_user_id=request["user_id"],
                amount_cents=amount_cents,
                quoted_request=request.get("quoted_amount_cents") is not None,
                settlement_method=request.get("settlement_method", "stripe_transfer"),
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

    @classmethod
    def ensure_order_for_owner_allow(cls, connection, request, private) -> bool:
        """Create the requester payment order inside the owner's Allow transaction.

        The owner allowed a period at their own price, so the amount is already
        final and the requester can pay while the background search still runs.
        Delivery keeps every gate it had: the permission worker shares nothing
        until Stripe confirms payment, the period still bounds the search, and
        a request that finds nothing is refunded in full.
        """
        if request["payment_required"] is not True:
            return False
        if not autoshare_owner_allow_authority(private):
            return False
        if (
            request["status"] != "pending"
            or request["expires_at"] <= datetime.now(UTC)
            or request["access_stop_requested_at"] is not None
            or not request_has_document_scope(private)
        ):
            return False
        amount_cents = _order_amount_cents(request, private)
        inserted = connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,amount_cents,stripe_mode,settlement_method)
              VALUES (:request,:owner,:requester,:amount,:stripe_mode,:settlement_method)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request["request_id"],
                "owner": request["user_id"],
                "requester": request["recipient_user_id"],
                "amount": amount_cents,
                "stripe_mode": configured_stripe_mode(),
                "settlement_method": request.get("settlement_method", "stripe_transfer"),
            },
        )
        if inserted.rowcount == 1:
            _record_new_owner_payout(
                connection,
                request_id=str(request["request_id"]),
                owner_user_id=request["user_id"],
                amount_cents=amount_cents,
                quoted_request=request.get("quoted_amount_cents") is not None,
                settlement_method=request.get("settlement_method", "stripe_transfer"),
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
            if not request_has_document_scope(private):
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
        if private.get("trusted_auto") is not True or request_requires_owner_review(
            connection,
            user_id=user_id,
            request_id=request["request_id"],
            revision=request["revision"],
        ):
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
              (request_id,user_id,requester_user_id,amount_cents,stripe_mode,settlement_method)
              VALUES (:request,:owner,:requester,:amount,:stripe_mode,:settlement_method)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request["request_id"],
                "owner": user_id,
                "requester": request["recipient_user_id"],
                "amount": amount_cents,
                "stripe_mode": configured_stripe_mode(),
                "settlement_method": request.get("settlement_method", "stripe_transfer"),
            },
        )
        if inserted.rowcount == 1:
            _record_new_owner_payout(
                connection,
                request_id=str(request["request_id"]),
                owner_user_id=user_id,
                amount_cents=amount_cents,
                quoted_request=request.get("quoted_amount_cents") is not None,
                settlement_method=request.get("settlement_method", "stripe_transfer"),
            )
        order = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request",
            {"request": request["request_id"]},
        )
        if order is not None and inserted.rowcount == 1:
            # Only this transaction created the order: the one moment the
            # Checkout lane needs a wake. Never a database column.
            order["_order_created"] = True
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
            return {
                "status": status,
                "notificationQueued": notified,
                # A worker wakes the Checkout lane only when this is True:
                # never on every page handoff while the order stays unpaid.
                "orderCreated": order.get("_order_created") is True,
            }

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
            order = self._row(
                connection,
                """SELECT o.*,EXISTS(SELECT 1 FROM drive_request_owner_payouts p
                     WHERE p.request_id=o.request_id) AS payout_enrolled,
                     f.status AS refund_status,f.amount_cents AS refund_amount_cents,
                     (SELECT a.account_ready FROM stripe_owner_payout_accounts a
                       WHERE a.user_id=o.user_id AND a.stripe_mode=:stripe_mode)
                       AS owner_account_ready
                   FROM drive_request_payment_orders o
                   LEFT JOIN drive_request_payment_refunds f ON f.request_id=o.request_id
                   WHERE o.request_id=:request AND o.requester_user_id=:requester""",
                {
                    "request": request["request_id"],
                    "requester": requester_user_id,
                    "stripe_mode": configured_stripe_mode(),
                },
            )
            initial = optional_payment_state(self, connection, request, order, requester_user_id)
            if initial is not None:
                return initial
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
                missing_dates = request["status"] == "pending" and not request_has_document_scope(
                    private
                )
                if missing_dates and (order is None or order["status"] not in {"paid", "refunded"}):
                    raise DriveSharingError("date_range_required")
                # An old order produced by the former GET side effect is not
                # actionable unless the owner actually approved a batch.
                approved = (
                    private.get("trusted_auto") is True
                    and (
                        # Selection policy gates new payment authority without
                        # reclassifying previously settled charges or refunds.
                        order is not None
                        and order["status"] in {"paid", "refunded"}
                        # An autoshare Allow is payment authority by itself:
                        # it priced the period, so no frozen batch is required.
                        # Only the plaintext hint can withdraw it: a disconnect
                        # clears owner_allowed_at and ends the Allow for good,
                        # so never read as payable after that.
                        or (
                            autoshare_owner_allow_authority(private)
                            and request.get("owner_allowed_at") is not None
                        )
                        or not request_requires_owner_review(
                            connection,
                            user_id=request["user_id"],
                            request_id=request["request_id"],
                            revision=request["revision"],
                        )
                    )
                    or request["status"] in {"approved", "partial", "completed"}
                    or self.owner_approved_progressive_batch(connection, request)
                )
            from hushh_mcp.services.drive_request_package_disclosure import (
                buyer_package_disclosure,
                manual_buyer_disclosure,
            )

            package_required = bool(private and private.get("agent_package_required") is True)
            manual_disclosure_required = bool(
                private
                and private.get("v1_live_request") is True
                and private.get("agent_package_required") is False
            )
            disclosure_required = package_required or manual_disclosure_required
            legacy_auto = bool(
                private
                and private.get("trusted_auto") is True
                and not package_required
                and request["status"] == "pending"
                and (
                    # The same authority as `approved` above: an autoshare Allow
                    # keeps the automatic lane, whose Checkout reads the frozen
                    # unapproved batches this flow produces, because the manual
                    # lane demands owner-approved ones it never writes. An exact
                    # owner approval of this request reverses that: its batch is
                    # approved, so the automatic lane can no longer read it and
                    # the owner's own selection is what Checkout must charge for.
                    (
                        autoshare_owner_allow_authority(private)
                        and not self.owner_approved_progressive_batch(connection, request)
                    )
                    or not request_requires_owner_review(
                        connection,
                        user_id=request["user_id"],
                        request_id=request["request_id"],
                        revision=request["revision"],
                    )
                )
            )
            # A request sealed for autoshare is priced per request, never per
            # file. While its selection is automatic (or its search has not
            # started yet), checkout opens as soon as the order exists, without
            # a frozen file set. Older automatic requests keep the complete-set
            # checkout; a selection the owner must review keeps the manual lane.
            from hushh_mcp.services.drive_owner_allowed import autoshare_request

            autoshare_flow = bool(private is not None and autoshare_request(private))
            autoshare_lane = bool(
                autoshare_flow
                and private is not None
                and private.get("trusted_auto") is True
                and request["status"] == "pending"
                and (legacy_auto or not _search_exists(connection, request))
            )
            if autoshare_lane:
                legacy_auto = False
            disclosure = (
                buyer_package_disclosure(
                    private or {},
                    request_revision=request["revision"],
                    owner_allowed_at=request.get("owner_allowed_at"),
                )
                if package_required
                else manual_buyer_disclosure(private or {}, request_revision=request["revision"])
                if manual_disclosure_required
                else None
            )
            if (
                disclosure_required
                and disclosure is None
                and (order is None or order["status"] not in {"paid", "refunded"})
            ):
                approved = False
            checkout_expired = bool(
                order
                and order["status"] not in {"paid", "refunded"}
                and order.get("stripe_checkout_session_id") is not None
                and (
                    order.get("stripe_checkout_expires_at") is None
                    or order["stripe_checkout_expires_at"] <= datetime.now(UTC)
                )
            )
            wrong_mode = bool(order and order.get("stripe_mode") != configured_stripe_mode())
            if wrong_mode and order["status"] not in {"paid", "refunded"}:
                status = "expired"
            elif order is None:
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
            settlement = (
                order.get("settlement_method", "stripe_transfer")
                if order
                else request.get("settlement_method", "stripe_transfer")
            )
            view = requester_payment_view(
                payment_required=True,
                package_disclosure_required=disclosure_required,
                package_disclosure=disclosure,
                request_status=request["status"],
                request_expires_at=request.get("expires_at"),
                now=datetime.now(UTC),
                access_stopped=request.get("access_stop_requested_at") is not None,
                preparation_error_code=request.get("preparation_error_code"),
                quoted_amount_cents=request.get("quoted_amount_cents"),
                order=order_view_input(order)
                if approved
                or request_expired
                or order is not None
                and order["status"] in {"paid", "refunded"}
                else None,
                refund=(
                    {
                        "status": order["refund_status"],
                        "amount_cents": order.get("refund_amount_cents"),
                    }
                    if order and order.get("refund_status") is not None
                    else None
                ),
                owner_payout_ready=(
                    order.get("owner_account_ready") is True
                    if payout_enrolled and settlement != "hashcoins"
                    else None
                ),
                configured_mode=configured_stripe_mode(),
            )
            if disclosure_required:
                # This authenticated read knows whether sealed terms are current.
                # Null prevents clients from reusing a stale context disclosure.
                view["packageDisclosure"] = disclosure
            return {
                "paymentView": view,
                **({"packageDisclosureRequired": True} if disclosure_required else {}),
                **({"packageDisclosure": disclosure} if disclosure is not None else {}),
                "status": status,
                "amountCents": None
                if setup.get("ownerPriceRequired")
                else _quoted_amount_cents(request, order, private),
                "currency": order["currency"] if order is not None else "usd",
                "paymentLinkExpired": (checkout_expired and not request_expired) or wrong_mode,
                "stripeMode": order.get("stripe_mode") if order else configured_stripe_mode(),
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
                "_payout_settlement_method": order.get("settlement_method", "stripe_transfer")
                if order
                else request.get("settlement_method", "stripe_transfer"),
                "_payout_owner_user_id": request["user_id"] if payout_enrolled else None,
                **(
                    {"_package_owner_user_id": request["user_id"]}
                    if private is not None and private.get("agent_package_required") is True
                    else {}
                ),
                **({"_legacy_auto_owner_user_id": request["user_id"]} if legacy_auto else {}),
                **({"_autoshare_owner_user_id": request["user_id"]} if autoshare_lane else {}),
                **({"_autoshare_request": True} if autoshare_flow else {}),
                "_order_present": order is not None,
                **(
                    {"_legacy_manual_owner_user_id": request["user_id"]}
                    if private is not None
                    and not package_required
                    and approved
                    and not legacy_auto
                    and not autoshare_lane
                    else {}
                ),
                **setup,
            }

        return await self._transaction(operation)

    async def repair_paid_request_authority(self, *, limit: int = 64, v1_only: bool = False) -> int:
        """Move legacy paid-request correction off the read path.

        Old GETs could make an order before consent. Rotate a bounded set of
        paid orders on each scheduled reconciliation pass, so a valid older
        order cannot starve a malformed one indefinitely.
        """
        if type(limit) is not int or not 1 <= limit <= 256:
            raise ValueError("invalid repair limit")
        if type(v1_only) is not bool:
            raise ValueError("invalid repair mode")

        def operation(connection):
            from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
            from hushh_mcp.services.drive_sharing_store import DriveSharingStore

            candidates = (
                connection.execute(
                    text("""SELECT r.request_id,r.user_id,r.recipient_user_id
                  FROM drive_request_payment_orders o
                  JOIN drive_share_requests r ON r.request_id=o.request_id
                  WHERE o.status='paid' AND o.reconciliation_required=FALSE AND o.stripe_mode=:stripe_mode
                    AND r.payment_required=TRUE
                    AND r.status IN ('pending','approved','partial')
                    AND (NOT :v1_only OR EXISTS (
                      SELECT 1 FROM drive_request_payment_obligations obligation
                      WHERE obligation.request_id=o.request_id
                        AND obligation.v1_statement_search=TRUE
                    ))
                  ORDER BY o.updated_at,o.request_id LIMIT :limit"""),
                    {
                        "limit": limit,
                        "stripe_mode": configured_stripe_mode(),
                        "v1_only": v1_only,
                    },
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
                    or order.get("stripe_mode") != configured_stripe_mode()
                    or order["reconciliation_required"]
                ):
                    continue
                if v1_only:
                    obligation = self._row(
                        connection,
                        """SELECT v1_statement_search FROM drive_request_payment_obligations
                           WHERE request_id=:request FOR SHARE""",
                        {"request": candidate["request_id"]},
                    )
                    if obligation is None or obligation["v1_statement_search"] is not True:
                        continue
                private = sharing._open_request(request)
                # Trusted creation and an owner's Allow both seal trusted_auto.
                authorized = (
                    private.get("trusted_auto") is True
                    or request["status"] in {"approved", "partial"}
                    or self.owner_approved_progressive_batch(connection, request)
                )
                invalid = (
                    request["status"] == "pending" and not request_has_document_scope(private)
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
