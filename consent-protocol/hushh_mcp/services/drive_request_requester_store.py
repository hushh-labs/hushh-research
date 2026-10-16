"""The requester's side of a document request: terms, price, recovery, review ask.

Functions take the calling DriveSharingStore (``store``) and, for reads, its
open transaction, so they share its locks, cipher and row helpers without an
import cycle. Nothing here calls a provider.

Requester-safe fields only: their own words, dates and email, the price, their
own refund, counts and public reason codes. Only approved package coverage; never file names,
Drive or trust state, owner fees or earnings.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_allowed import valid_owner_price_cents
from hushh_mcp.services.drive_request_package_disclosure import (
    buyer_package_disclosure,
    manual_buyer_disclosure,
)
from hushh_mcp.services.drive_request_recovery_view import (
    MAX_REVIEW_REQUESTS,
    requester_recovery_view,
    review_request_result,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, ShareRequestPurpose
from hushh_mcp.services.stripe_mode import configured_stripe_mode

# Sealed into a request only when its requester wrote it (create_request with
# owner_initiated=False). Owner-initiated shares carry the owner's own words.
REQUESTER_ORIGIN = "requester"
PRICE_STATES = frozenset({"estimate", "owner_set", "final", "awaiting_owner"})


def _price(value: Any) -> int | None:
    return value if valid_owner_price_cents(value) else None


def requester_price_view(
    *,
    initial_quote_cents: Any,
    quoted_amount_cents: Any,
    owner_allowed: bool,
    order_amount_cents: Any,
) -> dict[str, Any]:
    """RequesterPriceView: the estimate seen, the owner's price, the final price.

    ``final`` once an order froze the amount; ``awaiting_owner`` while the owner
    has not priced the request; ``owner_set`` once the owner chose a price or
    the estimate is unknown; otherwise the estimate still stands.
    """
    estimate = _price(initial_quote_cents)
    current = _price(quoted_amount_cents)
    final = _price(order_amount_cents)
    if final is not None:
        state = "final"
    elif current is None:
        state = "awaiting_owner"
    elif owner_allowed or estimate != current:
        state = "owner_set"
    else:
        state = "estimate"
    return {
        "estimateCents": estimate,
        "currentCents": current if current is not None else final,
        "finalCents": final,
        "state": state,
    }


def requester_context(store, connection, *, user_id: str, request_id: str) -> dict[str, Any]:
    """The requester's own request terms (vault-gated, never cached).

    Only the request's recipient passes the first read, so the owner, another
    person and an unknown id are refused before any decryption. A paid request
    was always written by its requester; a free one needs the sealed requester
    origin, so owner-initiated shares and older free requests stay hidden.
    """
    row = store._row(
        connection,
        """SELECT request_id,user_id,request_envelope,payment_required,created_at,revision,owner_allowed_at,
              requested_access_days,approved_access_days,access_expires_at
           FROM drive_share_requests WHERE request_id=:id AND recipient_user_id=:user""",
        {"id": str(UUID(request_id)), "user": user_id},
    )
    if not row:
        raise DriveSharingError("request_unavailable")
    private = store._open_request(row)
    if row["payment_required"] is not True and private.get("origin") != REQUESTER_ORIGIN:
        raise DriveSharingError("request_unavailable")
    purpose = ShareRequestPurpose.model_validate(private["purpose"])
    recipient = private.get("recipient")
    email = recipient.get("email") if isinstance(recipient, dict) else None
    time_zone = private.get("request_time_zone")
    disclosure = (
        manual_buyer_disclosure(private, request_revision=row["revision"])
        if private.get("v1_live_request") is True and private.get("agent_package_required") is False
        else buyer_package_disclosure(
            private, request_revision=row["revision"], owner_allowed_at=row["owner_allowed_at"]
        )
    )
    return {
        "requestId": str(row["request_id"]),
        "requestRevision": row["revision"],
        "purpose": purpose.model_dump(),
        "reason": private.get("reason", ""),
        "requestedAccessDays": row.get("requested_access_days"),
        "approvedAccessDays": row.get("approved_access_days"),
        "accessExpiresAt": row["access_expires_at"].isoformat()
        if row.get("access_expires_at")
        else None,
        "recipientEmail": email if isinstance(email, str) else None,
        "requestedAt": row["created_at"].isoformat(),
        "timeZone": time_zone if isinstance(time_zone, str) else None,
        **({"packageDisclosure": disclosure} if disclosure is not None else {}),
    }


def recovery_inputs(connection, request: Mapping[str, Any]) -> dict[str, Any]:
    """Read what requester_recovery_view needs for one request. DB-only.

    Effect counts are scoped to the requester and to approved, unexpired batches,
    as the delivery projection is. Retryable effects mirror the owner's Retry
    (DriveBulkShareStore canRetry and retry): skipped as provider_unavailable,
    never sent, unleased, in a partial or failed batch bound to the current
    request revision and still on the owner's current, verified Drive connection.
    """
    rows = (
        connection.execute(
            text("""SELECT state,safe_error_code,count(*) AS n,
              count(*) FILTER (WHERE retryable) AS retryable,
              max(updated_at) FILTER (WHERE retryable) AS retryable_updated_at
            FROM (
              SELECT e.state,e.safe_error_code,e.updated_at,
                (e.state='skipped' AND e.safe_error_code='provider_unavailable'
                  AND e.receipt_envelope IS NULL AND e.lease_id IS NULL
                  AND b.status IN ('partial','failed')
                  AND b.origin_request_revision=:revision
                  AND ((b.progressive_batch AND :status IN ('pending','partial'))
                    OR (NOT b.progressive_batch AND :status='partial'))
                  AND EXISTS (SELECT 1 FROM user_external_connector_connections d
                    WHERE d.user_id=b.user_id AND d.connector_id='google_drive'
                      AND d.connection_generation=b.connection_generation
                      AND d.status='connected' AND d.validation_state='verified')
                ) AS retryable
              FROM drive_bulk_shares b
              JOIN drive_bulk_share_effects e ON e.share_id=b.share_id
              JOIN drive_bulk_share_files f ON f.share_id=e.share_id AND f.position=e.position
              WHERE b.origin_request_id=:request AND b.user_id=:owner
                AND b.approved_at IS NOT NULL AND b.expires_at>clock_timestamp()
                AND e.recipient_user_id=:recipient
                AND (b.progressive_batch=FALSE OR f.origin_request_id=:request)
            ) AS effect
            GROUP BY state,safe_error_code"""),
            {
                "request": request["request_id"],
                "owner": request["user_id"],
                "recipient": request["recipient_user_id"],
                "revision": request["revision"],
                "status": request["status"],
            },
        )
        .mappings()
        .all()
    )
    money = (
        connection.execute(
            text("""SELECT o.status AS order_status,o.amount_cents AS order_amount_cents,
              o.paid_at,o.reconciliation_required,o.stripe_mode AS order_stripe_mode,
              p.status AS payout_status,p.gross_amount_cents,p.expected_files,
              p.confirmed_files,p.refund_amount_cents AS payout_refund_cents,p.finalized_at,
              f.status AS refund_status,f.amount_cents AS refund_cents,
              EXISTS (SELECT 1 FROM connections c WHERE c.status='active'
                AND ((c.user_a_id=:owner AND c.user_b_id=:recipient)
                  OR (c.user_a_id=:recipient AND c.user_b_id=:owner))) AS connected
            FROM (SELECT 1) AS one
            LEFT JOIN drive_request_payment_orders o ON o.request_id=:request
            LEFT JOIN drive_request_owner_payouts p ON p.request_id=:request
              AND p.erased_at IS NULL
            LEFT JOIN drive_request_payment_refunds f ON f.request_id=:request"""),
            {
                "request": request["request_id"],
                "owner": request["user_id"],
                "recipient": request["recipient_user_id"],
            },
        )
        .mappings()
        .one()
    )
    expires_at = request.get("expires_at")
    return {
        "request_status": request["status"],
        "review_requested_at": request.get("review_requested_at"),
        "outcomes": {(row["state"], row["safe_error_code"]): int(row["n"]) for row in rows},
        "retryable_count": sum(int(row["retryable"]) for row in rows),
        "retryable_updated_at": max(
            (row["retryable_updated_at"] for row in rows if row["retryable_updated_at"]),
            default=None,
        ),
        "request_open": bool(
            money["connected"]
            and request.get("access_stop_requested_at") is None
            and isinstance(expires_at, datetime)
            and expires_at > datetime.now(UTC)
            # The owner's Retry is hidden while their Drive sharing is off.
            and DriveBulkShareStore._owner_grants_enabled(request["user_id"])
        ),
        # Exactly what a retried grant requires (require_paid_if_required).
        "paid": request.get("payment_required") is not True
        or (
            money["order_status"] == "paid"
            and money["paid_at"] is not None
            and money["reconciliation_required"] is not True
            and money["order_stripe_mode"] == configured_stripe_mode()
        ),
        "refund": (
            {"status": money["refund_status"], "amount_cents": money["refund_cents"]}
            if money["refund_status"] is not None
            else None
        ),
        "payout": (
            {
                "status": money["payout_status"],
                "gross_amount_cents": money["gross_amount_cents"],
                "expected_files": money["expected_files"],
                "confirmed_files": money["confirmed_files"],
                "refund_amount_cents": money["payout_refund_cents"],
                "finalized_at": money["finalized_at"],
            }
            if money["payout_status"] is not None
            else None
        ),
        "order_amount_cents": money["order_amount_cents"],
    }


def recovery_for(connection, request: Mapping[str, Any]) -> dict[str, Any] | None:
    return requester_recovery_view(**recovery_inputs(connection, request))


async def request_review(store, *, user_id: str, request_id: str) -> dict[str, Any]:
    """The requester asks the owner to review undelivered files (option a).

    Allowed only while an owner retry is still possible, at most three times
    per request; a repeat before the owner acts returns the same answer. It
    grants nothing and holds no refund: the owner still uses the existing retry.
    Lock order matches decline_or_cancel: graph gates, then the request row.
    """
    identity = str(UUID(request_id))

    def operation(connection):
        store._participant_gate(connection, user_id, identity, recipient=True)
        row = store._request(connection, user_id, identity, recipient=True)
        recovery = recovery_for(connection, row)
        state = recovery["ownerRetry"]["state"] if recovery else "unavailable"
        if state == "requested":
            return review_request_result(identity, cast(dict, recovery))
        if state != "available":
            raise DriveSharingError("review_not_available")
        if int(row.get("review_request_count") or 0) >= MAX_REVIEW_REQUESTS:
            raise DriveSharingError("review_limit_reached")
        updated = store._row(
            connection,
            """UPDATE drive_share_requests
               SET review_requested_at=clock_timestamp(),
                 review_request_count=review_request_count+1,updated_at=clock_timestamp()
               WHERE request_id=:request RETURNING *""",
            {"request": identity},
        )
        # Every ask is its own owner event. Like document_share_outcome, the
        # event revision only deduplicates the notification, never authority.
        revision = connection.execute(
            text("""SELECT GREATEST(:revision,COALESCE(MAX(revision)+1,:revision))
               FROM drive_share_events
               WHERE request_id=:request AND event_type='document_share_review_requested'"""),
            {"request": identity, "revision": updated["revision"]},
        ).scalar_one()
        connection.execute(
            text("""INSERT INTO drive_share_events(event_id,request_id,user_id,revision,event_type)
               VALUES (:id,:request,:owner,:revision,'document_share_review_requested')
               ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""),
            {
                "id": str(uuid4()),
                "request": identity,
                "owner": updated["user_id"],
                "revision": revision,
            },
        )
        return review_request_result(identity, cast(dict, recovery_for(connection, updated)))

    return cast(dict, await store._transaction(operation))
