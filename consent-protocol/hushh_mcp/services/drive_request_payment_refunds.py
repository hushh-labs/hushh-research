"""Durable full-refund reconciliation for paid requests with no delivered files."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import text

# Stripe can prune idempotency keys after 24 hours. Start this shorter window
# before any provider call so a crash or delayed call cannot extend it.
_REFUND_RETRY_WINDOW = timedelta(hours=20)

# Apply this before LIMIT: older paid requests with delivered or unsettled
# grants must not crowd out later requests that really need a refund.
_REFUND_CANDIDATES_SQL = """
  FROM drive_request_payment_obligations o
  LEFT JOIN drive_share_requests r ON r.request_id=o.request_id
  LEFT JOIN drive_request_payment_refunds f ON f.request_id=o.request_id
  WHERE o.status='paid'
    AND (f.request_id IS NULL OR (f.status IN
      ('queued','dispatching','unknown','pending','manual_review')
      AND f.next_check_at<=clock_timestamp()
      AND (f.lease_expires_at IS NULL OR f.lease_expires_at<=clock_timestamp())))
    AND ((o.erased_at IS NOT NULL AND o.reconciliation_required
      AND NOT o.delivery_confirmed_at_erasure) OR
      (r.payment_required=TRUE AND
       (o.reconciliation_required OR r.status IN
         ('completed','partial','no_match','expired','cancelled','declined')
         OR r.expires_at<=clock_timestamp())
       AND NOT EXISTS (SELECT 1 FROM drive_bulk_share_effects e
      JOIN drive_bulk_shares b ON b.share_id=e.share_id
      WHERE b.origin_request_id=o.request_id
        AND (e.state IN ('succeeded','preexisting','dispatching',
                        'unknown','present_unattributed')
             OR (e.state='failed' AND e.safe_error_code='permission_outcome_unknown')))
       AND NOT EXISTS (SELECT 1 FROM drive_share_permission_operations p
      WHERE p.request_id=o.request_id AND p.kind='grant'
        AND p.state IN ('succeeded','preexisting','dispatching',
                        'unknown','present_unattributed'))))
"""


def _retry_window_open(claim: dict) -> bool:
    first_dispatch_at = claim.get("first_dispatch_at")
    return (
        claim.get("create_allowed", True)
        and isinstance(first_dispatch_at, datetime)
        and first_dispatch_at.tzinfo is not None
        and datetime.now(UTC) < first_dispatch_at + _REFUND_RETRY_WINDOW
    )


def _claim_refunds(service, connection, *, limit: int) -> list[dict]:
    candidates = (
        connection.execute(
            text(f"SELECT o.request_id {_REFUND_CANDIDATES_SQL} ORDER BY o.paid_at LIMIT :scan"),
            {"scan": limit * 4},
        )
        .mappings()
        .all()
    )
    claimed = []
    for candidate in candidates:
        if len(claimed) >= limit:
            break
        request_id = candidate["request_id"]
        request = service._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if request is not None:
            service._row(
                connection,
                "SELECT request_id FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
                {"request": request_id},
            )
        order = service._row(
            connection,
            """SELECT * FROM drive_request_payment_obligations
               WHERE request_id=:request FOR UPDATE""",
            {"request": request_id},
        )
        if order is None or order["status"] != "paid" or not order["stripe_payment_intent_id"]:
            continue
        if request is None:
            if (
                order["erased_at"] is None
                or not order["reconciliation_required"]
                or order["delivery_confirmed_at_erasure"]
            ):
                continue
            if order["delivery_unsettled_at_erasure"]:
                connection.execute(
                    text("""INSERT INTO drive_request_payment_refunds
                  (request_id,attempt_id,status,first_dispatch_at,next_check_at)
                  VALUES (:request,:attempt,'manual_review',clock_timestamp(),
                          clock_timestamp()+interval '1 hour')
                  ON CONFLICT (request_id) DO NOTHING"""),
                    {"request": request_id, "attempt": str(uuid4())},
                )
                connection.execute(
                    text("""UPDATE drive_request_payment_refunds
                  SET status='manual_review',first_dispatch_at=COALESCE(
                    first_dispatch_at,clock_timestamp()),updated_at=clock_timestamp()
                  WHERE request_id=:request AND status IN ('queued','unknown')"""),
                    {"request": request_id},
                )
        else:
            # Queued grants have not reached a provider POST. The live order
            # lock above fences both grant dispatch paths, which recheck paid
            # authority before changing a queued effect to dispatching.
            effects = service._row(
                connection,
                """SELECT
          EXISTS(SELECT 1 FROM drive_bulk_share_effects e
            JOIN drive_bulk_shares b ON b.share_id=e.share_id
            WHERE b.origin_request_id=:request
              AND e.state IN ('succeeded','preexisting')) AS delivered,
          EXISTS(SELECT 1 FROM drive_bulk_share_effects e
            JOIN drive_bulk_shares b ON b.share_id=e.share_id
            WHERE b.origin_request_id=:request
              AND (e.state IN ('dispatching','unknown','present_unattributed')
                   OR (e.state='failed' AND e.safe_error_code='permission_outcome_unknown')))
            AS unsettled,
          EXISTS(SELECT 1 FROM drive_share_permission_operations p
            WHERE p.request_id=:request AND p.kind='grant'
              AND p.state IN ('succeeded','preexisting')) AS legacy_delivered,
          EXISTS(SELECT 1 FROM drive_share_permission_operations p
            WHERE p.request_id=:request AND p.kind='grant'
              AND p.state IN ('dispatching','unknown','present_unattributed'))
            AS legacy_unsettled
            """,
                {"request": request_id},
            )
            if (
                effects["delivered"]
                or effects["unsettled"]
                or effects["legacy_delivered"]
                or effects["legacy_unsettled"]
            ):
                continue
        connection.execute(
            text("""UPDATE drive_request_payment_obligations
          SET reconciliation_required=TRUE,
              updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        if request is not None:
            connection.execute(
                text("""UPDATE drive_request_payment_orders
              SET reconciliation_required=TRUE,
                  reconciliation_reason=COALESCE(reconciliation_reason,'zero_delivery'),
                  reconciliation_at=COALESCE(reconciliation_at,clock_timestamp()),
                  updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": request_id},
            )
        connection.execute(
            text("""INSERT INTO drive_request_payment_refunds
          (request_id,attempt_id,status) VALUES (:request,:attempt,'queued')
          ON CONFLICT (request_id) DO NOTHING"""),
            {"request": request_id, "attempt": str(uuid4())},
        )
        refund = service._row(
            connection,
            """SELECT * FROM drive_request_payment_refunds
               WHERE request_id=:request FOR UPDATE""",
            {"request": request_id},
        )
        if refund is None or refund["status"] in {"succeeded", "failed"}:
            continue
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if refund["next_check_at"] > now or (
            refund["status"] == "dispatching"
            and refund["lease_expires_at"] is not None
            and refund["lease_expires_at"] > now
        ):
            continue
        dispatched = service._row(
            connection,
            """UPDATE drive_request_payment_refunds
          SET status='dispatching',lease_expires_at=clock_timestamp()+interval '2 minutes',
              first_dispatch_at=COALESCE(first_dispatch_at,clock_timestamp()),
              updated_at=clock_timestamp() WHERE request_id=:request
          RETURNING first_dispatch_at""",
            {"request": request_id},
        )
        claimed.append(
            {
                "request_id": str(request_id),
                "payment_intent": order["stripe_payment_intent_id"],
                "attempt_id": str(refund["attempt_id"]),
                "refund_id": refund["stripe_refund_id"],
                "first_dispatch_at": dispatched["first_dispatch_at"],
                "create_allowed": (
                    refund["status"] != "manual_review"
                    and not order["delivery_unsettled_at_erasure"]
                ),
            }
        )
    return claimed


def _provider_refund(service, claim: dict, key: str) -> tuple[dict | None, str | None]:
    """Reconcile first; retry the same create key only inside its safe window."""
    from hushh_mcp.services.drive_request_payment_service import _stripe_dict

    api = service.stripe_api
    intent = claim["payment_intent"]
    if claim["refund_id"]:
        refund = api.Refund.retrieve(claim["refund_id"], api_key=key)
        return _stripe_dict(refund), None
    listed = _stripe_dict(api.Refund.list(payment_intent=intent, limit=100, api_key=key))
    if listed.get("has_more"):
        return None, "provider_mismatch"
    refunds = [_stripe_dict(item) for item in (listed.get("data") or [])]
    if refunds:
        exact = [
            r
            for r in refunds
            if r.get("payment_intent") == intent
            and r.get("amount") == 1000
            and r.get("currency") == "usd"
        ]
        if len(refunds) != 1 or len(exact) != 1:
            return None, "provider_mismatch"
        return exact[0], None
    if not _retry_window_open(claim):
        return None, "idempotency_window_elapsed"
    refund = api.Refund.create(
        payment_intent=intent,
        amount=1000,
        metadata={"payment_kind": "drive_request", "request_id": claim["request_id"]},
        api_key=key,
        idempotency_key=f"drive-request-refund-{claim['request_id']}-{claim['attempt_id']}",
    )
    return _stripe_dict(refund), None


def _finish_refund(service, connection, claim: dict, refund: dict | None, error: str | None) -> str:
    request_id = claim["request_id"]
    participant = service._row(
        connection,
        "SELECT user_id,recipient_user_id FROM drive_share_requests WHERE request_id=:request",
        {"request": request_id},
    )
    if participant is not None:
        from hushh_mcp.services.connection_graph_service import lock_connection_graph_users

        # A successful live refund emits a Feed event, whose insert guard
        # takes shared graph gates. Erasure takes exclusive gates first.
        lock_connection_graph_users(
            connection, user_ids=[participant["user_id"], participant["recipient_user_id"]]
        )
    request = service._row(
        connection,
        "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    if request is not None:
        service._row(
            connection,
            "SELECT request_id FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
    order = service._row(
        connection,
        "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    row = service._row(
        connection,
        "SELECT * FROM drive_request_payment_refunds WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    if (
        order is None
        or row is None
        or str(row["attempt_id"]) != claim["attempt_id"]
        or (request is None and order["erased_at"] is None)
    ):
        return "gone"
    if row["status"] == "succeeded":
        return "succeeded"
    if refund is not None:
        if (
            refund.get("payment_intent") != claim["payment_intent"]
            or refund.get("amount") != 1000
            or refund.get("currency") != "usd"
            or not isinstance(refund.get("id"), str)
        ):
            error = "provider_mismatch"
            refund = None
    if refund is None:
        next_status = (
            "failed"
            if error == "provider_mismatch"
            else "unknown"
            if _retry_window_open(claim)
            else "manual_review"
        )
        check_interval = "1 hour" if next_status == "manual_review" else "5 minutes"
        connection.execute(
            text("""UPDATE drive_request_payment_refunds
          SET status=:status,safe_error_code=:error,lease_expires_at=NULL,
              next_check_at=clock_timestamp()+CAST(:check_interval AS interval),
              updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {
                "status": next_status,
                "error": error or "provider_unavailable",
                "check_interval": check_interval,
                "request": request_id,
            },
        )
        return next_status
    provider_status = refund.get("status")
    next_status = (
        {
            "succeeded": "succeeded",
            "pending": "pending",
            "requires_action": "pending",
            "failed": "failed",
            "canceled": "failed",
        }
    ).get(provider_status, "unknown")
    connection.execute(
        text("""UPDATE drive_request_payment_refunds
      SET status=:status,stripe_refund_id=:refund,safe_error_code=NULL,
          lease_expires_at=NULL,next_check_at=clock_timestamp()+interval '5 minutes',
          updated_at=clock_timestamp() WHERE request_id=:request"""),
        {"status": next_status, "refund": refund["id"], "request": request_id},
    )
    if next_status == "succeeded" and order["status"] == "paid":
        if request is None:
            connection.execute(
                text("""UPDATE drive_request_payment_obligations
              SET status='refunded',updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": request_id},
            )
        else:
            connection.execute(
                text("""UPDATE drive_request_payment_orders
              SET status='refunded',stripe_checkout_url=NULL,updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": request_id},
            )
            service._event(connection, request, "document_share_payment_refunded")
    return next_status


async def reconcile_refunds(service, *, max_orders: int = 4) -> dict:
    if type(max_orders) is not int or not 1 <= max_orders <= 20:
        raise ValueError("invalid refund reconciliation bound")
    from hushh_mcp.services.drive_request_payment_service import _config

    outcomes = {
        "claimed": 0,
        "succeeded": 0,
        "pending": 0,
        "unknown": 0,
        "failed": 0,
        "manual_review": 0,
    }
    has_candidate = await service._transaction(
        lambda connection: bool(
            connection.execute(
                text(f"SELECT EXISTS(SELECT 1 {_REFUND_CANDIDATES_SQL})")
            ).scalar_one()
        )
    )
    if not has_candidate:
        return outcomes
    key, _, _ = _config()
    claims = await service._transaction(
        lambda connection: _claim_refunds(service, connection, limit=max_orders)
    )
    outcomes["claimed"] = len(claims)
    for claim in claims:
        try:
            refund, error = await asyncio.to_thread(_provider_refund, service, claim, key)
        except Exception:
            refund, error = None, "provider_unavailable"
        result = await service._transaction(
            lambda connection, claim=claim, refund=refund, error=error: _finish_refund(
                service, connection, claim, refund, error
            )
        )
        if result in outcomes:
            outcomes[result] += 1
    return outcomes
