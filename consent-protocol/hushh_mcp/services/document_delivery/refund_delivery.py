"""Delivery eligibility for refunds under the existing locked financial claim."""

from uuid import uuid4

from sqlalchemy import text

from .state import delivery_summary


def refund_delivery_eligible(
    service, connection, *, request_id, request, order, payout, partial_refund
):
    summary = delivery_summary(connection, str(request_id))
    if summary is not None and (
        summary["unsettled"] or summary["confirmed"] and not partial_refund
    ):
        return False
    if request is None:
        return _erased_eligible(connection, request_id, order, payout, partial_refund, summary)
    if summary is None:
        return _legacy_eligible(service, connection, request_id, request, order, partial_refund)
    return True


def _erased_eligible(connection, request_id, order, payout, partial_refund, summary):
    if partial_refund and payout is not None and payout["erased_at"] is not None:
        # Erasure snapshots the terminal approved-file denominator
        # before batches disappear. The owner cannot receive an
        # automatic transfer, but the requester is still owed the
        # undelivered portion of the paid charge.
        if summary is None and order["delivery_unsettled_at_erasure"]:
            return False
    elif (
        order["erased_at"] is None
        or not order["reconciliation_required"]
        or (
            summary is None
            and order["delivery_confirmed_at_erasure"]
            and order["existing_access_waived_at"] is None
        )
    ):
        return False
    if summary is None and not partial_refund and order["delivery_unsettled_at_erasure"]:
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
    return True


def _legacy_eligible(service, connection, request_id, request, order, partial_refund):
    # Queued grants have not reached a provider POST. The live order
    # lock above fences both grant dispatch paths, which recheck paid
    # authority before changing a queued effect to dispatching.
    effects = service._row(
        connection,
        """SELECT
  EXISTS(SELECT 1 FROM drive_bulk_share_effects e
    JOIN drive_bulk_shares b ON b.share_id=e.share_id
    WHERE b.origin_request_id=:request
      AND (e.state='succeeded' OR (:count_preexisting AND e.state='preexisting'))) AS delivered,
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
        {
            "request": request_id,
            "count_preexisting": request.get("v1_live_request") is not True
            and order["existing_access_waived_at"] is None,
        },
    )
    if (
        (effects["delivered"] and not partial_refund)
        or effects["unsettled"]
        or (effects["legacy_delivered"] and not partial_refund)
        or effects["legacy_unsettled"]
    ):
        return False
    return True
