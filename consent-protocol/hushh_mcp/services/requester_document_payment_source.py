"""Complete, owner-only snapshot of first-party document request payments.

This read model is deliberately separate from Stripe receipts and anonymous
payment obligations. It exposes only orders still attached to an identified
requester; account erasure cannot rehydrate a private memory projection.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db
from hushh_mcp.services.fabric_grant_service import subject_ref

MAX_SOURCE_PAYMENTS = 5_000
_ORDER_STATUSES = frozenset({"awaiting_payment", "checkout_open", "paid", "refunded", "expired"})
_REFUND_STATUSES = frozenset(
    {"queued", "dispatching", "unknown", "pending", "manual_review", "succeeded", "failed"}
)
_MODES = frozenset({"live", "test", "legacy"})


class RequesterDocumentPaymentSourceUnavailable(RuntimeError):
    """A complete, trustworthy owner snapshot could not be established."""


class RequesterDocumentPaymentSourceCapacity(RequesterDocumentPaymentSourceUnavailable):
    """The owner has more rows than this snapshot contract can verify."""


def _instant(value: Any) -> str:
    """One canonical UTC instant, whatever time zone the database session uses."""
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RequesterDocumentPaymentSourceUnavailable("payment timestamp unavailable")
    return value.astimezone(UTC).isoformat()


def _row_view(row: dict[str, Any], *, user_id: str) -> dict[str, Any]:
    try:
        request_id = str(UUID(str(row["request_id"])))
        counterpart = row["counterpart_user_id"]
        status = row["status"]
        mode = row["stripe_mode"]
        amount = row["amount_cents"]
        refund_status = row["refund_status"]
        refund_amount = row["refund_amount_cents"]
        paid_at = row["paid_at"]
        currency = row["currency"]
        reconciliation_required = row["reconciliation_required"]
        created_at = row["created_at"]
        updated_at = row["updated_at"]
    except (KeyError, TypeError, ValueError, AttributeError):
        raise RequesterDocumentPaymentSourceUnavailable("payment request unavailable") from None
    if (
        not isinstance(counterpart, str)
        or not counterpart
        or counterpart == user_id
        or mode not in _MODES
        or status not in _ORDER_STATUSES
        or type(amount) is not int
        or not 50 <= amount <= 50_000
        or currency != "usd"
        or type(reconciliation_required) is not bool
        or (refund_status is not None and refund_status not in _REFUND_STATUSES)
        or (
            refund_amount is not None
            and (type(refund_amount) is not int or not 1 <= refund_amount <= amount)
        )
        or (refund_status is None and refund_amount is not None)
        or ((status in {"paid", "refunded"}) != (paid_at is not None))
    ):
        raise RequesterDocumentPaymentSourceUnavailable("payment row could not be verified")
    return {
        "requestId": request_id,
        "counterpartRef": subject_ref(subscriber_id=user_id, user_id=counterpart),
        "mode": mode,
        "status": status,
        "amountCents": amount,
        "currency": "USD",
        "paidAt": _instant(paid_at) if paid_at is not None else None,
        "refundStatus": refund_status,
        "refundAmountCents": refund_amount,
        "reconciliationRequired": reconciliation_required,
        "createdAt": _instant(created_at),
        "updatedAt": _instant(updated_at),
    }


class RequesterDocumentPaymentSourceService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def snapshot(self, *, user_id: str) -> dict[str, Any]:
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("owner required")

        def read() -> dict[str, Any]:
            with self.db.engine.begin() as connection:
                connection.execute(
                    text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                )
                connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                as_of = connection.execute(text("SELECT transaction_timestamp()")).scalar_one()
                rows = (
                    connection.execute(
                        text("""SELECT o.request_id,o.user_id AS counterpart_user_id,
                                      o.stripe_mode,o.status,o.amount_cents,o.currency,
                                      o.paid_at,o.reconciliation_required,o.created_at,o.updated_at,
                                      f.status AS refund_status,f.amount_cents AS refund_amount_cents
                               FROM drive_request_payment_orders o
                               LEFT JOIN drive_request_payment_refunds f
                                 ON f.request_id=o.request_id
                               WHERE o.requester_user_id=:owner
                               ORDER BY o.created_at DESC,o.request_id DESC
                               LIMIT :maximum"""),
                        {"owner": user_id, "maximum": MAX_SOURCE_PAYMENTS + 1},
                    )
                    .mappings()
                    .all()
                )
                if len(rows) > MAX_SOURCE_PAYMENTS:
                    raise RequesterDocumentPaymentSourceCapacity(
                        "payment source exceeds safe bound"
                    )
                items = [_row_view(dict(row), user_id=user_id) for row in rows]
                if len({item["requestId"] for item in items}) != len(items):
                    raise RequesterDocumentPaymentSourceUnavailable(
                        "payment source has duplicate requests"
                    )
                return {
                    "schemaVersion": 1,
                    "ownerUserId": user_id,
                    "sourceReadVerified": True,
                    "asOf": _instant(as_of),
                    "items": items,
                }

        try:
            return await asyncio.to_thread(read)
        except SQLAlchemyError:
            raise RequesterDocumentPaymentSourceUnavailable("payment storage unavailable") from None
