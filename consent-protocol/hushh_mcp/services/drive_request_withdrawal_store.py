"""Requester withdrawal of a Drive document request, and the paid guard.

A requester's withdrawal and an owner's decline must never close a request
whose payment was taken or whose sharing already reached Google: the refund
worker skips delivered requests and the owner's earning would hold forever.
Both therefore refuse with ``request_paid`` once the order is paid (or
refunded) or any bulk effect or legacy grant has been dispatched.

A withdrawal closes everything still queued in one transaction: queued bulk
effects are skipped and their batches stopped, queued grants are retired with
their file claims, the unpaid order is expired (its Checkout URL cleared, its
session and attempt ids kept so a late signed webhook still binds and is
refunded as ``request_closed``), and an unpaid owner earning becomes void.

Lock order matches the delivery settlement, refund and erasure writers:
participant graph gates, management context, bulk shares (ORDER BY share_id),
request, payment order, obligation, refund, owner payout. Stripe is never
called here. Retiring an open Checkout page runs after commit and is
best-effort (``retire_withdrawn_checkout``); the webhook and the refund worker
remain the money authority.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError

logger = logging.getLogger(__name__)

WITHDRAWABLE_STATUSES = frozenset({"pending", "preparing", "review_ready", "approved"})
UNPAID_ORDER_STATUSES = frozenset({"awaiting_payment", "checkout_open", "expired"})

# Any effect or grant past "queued" may already be visible in Google, and an
# outcome Google never confirmed counts as dispatched, never as undone.
_DISPATCHED_SQL = """SELECT EXISTS (
    SELECT 1 FROM drive_bulk_share_effects e
    JOIN drive_bulk_shares b ON b.share_id=e.share_id
    WHERE b.origin_request_id=:request
      AND (e.state IN ('dispatching','unknown','succeeded','preexisting','present_unattributed')
        OR (e.state='failed' AND e.safe_error_code='permission_outcome_unknown'))
  ) OR EXISTS (
    SELECT 1 FROM drive_share_permission_operations p
    WHERE p.request_id=:request AND p.kind='grant'
      AND (p.state IN ('dispatching','unknown','succeeded','preexisting','present_unattributed')
        OR (p.state='queued' AND p.dispatched_at IS NOT NULL))
  )"""


# Fixed statements per table; no identifier is ever taken from input.
_LOCK_SQL = {
    "drive_request_payment_orders": (
        "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE"
    ),
    "drive_request_payment_obligations": (
        "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE"
    ),
    "drive_request_payment_refunds": (
        "SELECT * FROM drive_request_payment_refunds WHERE request_id=:request FOR UPDATE"
    ),
    "drive_request_owner_payouts": (
        "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE"
    ),
}


def lock_closable_request(
    store, connection, *, user_id: str, request_id: str, recipient: bool
) -> dict[str, Any]:
    """Take every lock a close needs, in the shared order, and return the rows."""
    participants = store._participant_gate(connection, user_id, request_id, recipient=recipient)
    identity = {"request": request_id, "owner": participants["user_id"]}
    connection.execute(
        text("""SELECT request_id FROM drive_share_management_contexts
          WHERE request_id=:request AND user_id=:owner FOR UPDATE"""),
        identity,
    ).all()
    shares = (
        connection.execute(
            text("""SELECT share_id,status FROM drive_bulk_shares
              WHERE origin_request_id=:request ORDER BY share_id FOR UPDATE"""),
            identity,
        )
        .mappings()
        .all()
    )
    request = store._request(connection, user_id, request_id, recipient=recipient)
    rows: dict[str, Any] = {"request": request, "shares": [dict(row) for row in shares]}
    for name, table in (
        ("order", "drive_request_payment_orders"),
        ("obligation", "drive_request_payment_obligations"),
        ("refund", "drive_request_payment_refunds"),
        ("payout", "drive_request_owner_payouts"),
    ):
        rows[name] = store._row(connection, _LOCK_SQL[table], identity)
    return rows


def _paid(row: dict | None) -> bool:
    return row is not None and (
        row.get("status") not in UNPAID_ORDER_STATUSES or row.get("paid_at") is not None
    )


def require_unpaid_and_undispatched(connection, locked: dict[str, Any]) -> None:
    """Refuse to close a request whose money or sharing has already moved."""
    if _paid(locked["order"]) or _paid(locked["obligation"]):
        raise DriveSharingError("request_paid")
    request_id = str(locked["request"]["request_id"])
    if connection.execute(text(_DISPATCHED_SQL), {"request": request_id}).scalar_one():
        raise DriveSharingError("request_paid")


def _summary(store, connection, row) -> dict[str, Any]:
    summary = store._summary(row, recipient=True)
    payment = store._payment_metadata(connection, str(row["request_id"])).get("payment")
    return {**summary, "payment": payment} if payment is not None else summary


def withdraw_in_transaction(
    store, connection, *, user_id: str, request_id: str, revision: int
) -> dict[str, Any]:
    """The requester's withdrawal; idempotent for a repeated tap or lost response."""
    locked = lock_closable_request(
        store, connection, user_id=user_id, request_id=request_id, recipient=True
    )
    row = locked["request"]
    if row["revision"] != revision:
        raise DriveSharingError("review_changed")
    if row["status"] == "cancelled":
        return _summary(store, connection, row)
    if row["status"] not in WITHDRAWABLE_STATUSES:
        raise DriveSharingError("request_already_decided")
    require_unpaid_and_undispatched(connection, locked)
    identity = {"request": request_id}
    connection.execute(
        text("""
        UPDATE one_action_directive_ledger SET state='cancelled',settled_at=clock_timestamp(),
          settlement_status='cancelled',settlement_reason_code='document_request_cancelled'
        WHERE channel='document_review' AND document_request_id=:id AND user_id=:owner
          AND state IN ('issued','confirmed')
    """),
        {"id": request_id, "owner": row["user_id"]},
    )
    for share in locked["shares"]:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='skipped',
              safe_error_code='stopped',updated_at=clock_timestamp()
              WHERE share_id=:share AND state='queued'"""),
            {"share": share["share_id"]},
        )
        if share["status"] in {"review_ready", "queued", "running"}:
            connection.execute(
                text("""UPDATE drive_bulk_shares SET status='stopped',
                  stopped_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
                  WHERE share_id=:share"""),
                {"share": share["share_id"]},
            )
    retired = (
        connection.execute(
            text("""UPDATE drive_share_permission_operations SET state='not_dispatched',
              safe_error_code='request_cancelled',settled_at=clock_timestamp(),
              updated_at=clock_timestamp()
              WHERE request_id=:request AND kind='grant' AND state='queued'
                AND dispatched_at IS NULL
              RETURNING operation_id"""),
            identity,
        )
        .scalars()
        .all()
    )
    for operation_id in retired:
        connection.execute(
            text("DELETE FROM drive_share_file_claims WHERE operation_id=:id"),
            {"id": operation_id},
        )
    # Keep the session and attempt ids: a late signed payment must still bind
    # to this order, settle as request_closed and be refunded in full.
    connection.execute(
        text("""UPDATE drive_request_payment_orders SET status='expired',
          stripe_checkout_url=NULL,updated_at=clock_timestamp()
          WHERE request_id=:request AND status IN ('awaiting_payment','checkout_open')
            AND paid_at IS NULL"""),
        identity,
    )
    connection.execute(
        text("""UPDATE drive_request_owner_payouts SET status='void',
          next_check_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE request_id=:request AND status='awaiting_delivery' AND finalized_at IS NULL"""),
        identity,
    )
    updated = store._row(
        connection,
        """
        UPDATE drive_share_requests SET status='cancelled',updated_at=clock_timestamp(),
          preparation_lease_id=NULL,preparation_lease_expires_at=NULL
        WHERE request_id=:request RETURNING *
    """,
        identity,
    )
    store._event(connection, updated, row["user_id"], "document_share_decided")
    return _summary(store, connection, updated)


async def retire_withdrawn_checkout(
    result: dict[str, Any], *, requester_user_id: str, request_id: str, payments=None
) -> dict[str, Any]:
    """After commit: best-effort expiry of a withdrawn request's Checkout page.

    Never fails the withdrawal. When Stripe reports the session already paid,
    the response says a refund is pending: the signed webhook will settle the
    order as request_closed and the refund worker returns the full amount.
    """
    payment = result.get("payment")
    if (
        not isinstance(payment, dict)
        or result.get("status") != "cancelled"
        or payment.get("state") != "closed"
    ):
        return result
    try:
        if payments is None:
            from hushh_mcp.services.drive_request_payment_service import (
                DriveRequestPaymentService,
            )

            payments = DriveRequestPaymentService()
        verdict = await payments.retire_checkout(
            requester_user_id=requester_user_id, request_id=request_id
        )
    except Exception as error:  # noqa: BLE001 - a withdrawal never depends on Stripe
        logger.info("drive_request.withdraw_checkout_unconfirmed error=%s", type(error).__name__)
        return result
    if verdict != "paid":
        return result
    return {
        **result,
        "payment": {
            **payment,
            "state": "refund_pending",
            "refund": {"status": "queued", "amountCents": payment.get("amountCents")},
            "nextAction": "none",
        },
    }
