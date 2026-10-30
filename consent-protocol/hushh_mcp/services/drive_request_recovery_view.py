"""What happens to files a document request did not deliver (pure).

The requester's view after a partial delivery, and the owner's notice once the
requester asks for a review. Inputs are rows the caller already read; nothing
here touches the database or a provider.

The requester view carries counts, public reason codes, the owner-retry state
and the requester's own refund. It never carries file names, owner coverage,
Drive or trust state, owner fees or earnings, or provider identifiers.

Owner retry (option a: no refund hold). A retry is only ever offered while the
owner could still run one: a retryable effect exists, the request is open and
paid when it must be, and the owner's payout is not finalized. Finalization
prorates the refund, so "Request review" never promises a retry it cannot keep.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from hushh_mcp.services.drive_bulk_share_store import safe_bulk_reason

MAX_REVIEW_REQUESTS = 3

# Settled without delivery. present_unattributed and unknown are still being
# checked, so they are neither delivered nor "not shared" yet.
UNDELIVERED_STATES = frozenset({"skipped", "failed", "absent"})
IN_FLIGHT_STATES = frozenset({"queued", "dispatching"})
RECOVERY_REQUEST_STATUSES = frozenset({"partial", "completed"})
# A retry moves the request back to pending (progressive) or approved.
RETRYING_REQUEST_STATUSES = frozenset({"pending", "approved"})

OWNER_RETRY_STATES = frozenset({"available", "requested", "retrying", "unavailable"})
REFUND_STATES = frozenset({"none", "pending", "succeeded", "manual_review", "failed"})
# A provider outcome that is not known yet is pending, never a refund.
_REFUND_STATE = {
    "queued": "pending",
    "dispatching": "pending",
    "unknown": "pending",
    "pending": "pending",
    "succeeded": "succeeded",
    "manual_review": "manual_review",
    "failed": "failed",
}


def _cents(value: Any) -> int | None:
    return value if type(value) is int and 0 < value <= 50000 else None


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _instant(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _refund(
    refund: Mapping[str, Any] | None,
    payout: Mapping[str, Any] | None,
    order_amount_cents: int | None,
) -> dict[str, Any]:
    state = _REFUND_STATE.get(str(refund.get("status"))) if refund is not None else None
    amount = None
    if state is not None:
        # A refund row without an amount returns the whole paid amount.
        amount = _cents(refund.get("amount_cents")) if refund is not None else None
        amount = amount or _cents(order_amount_cents)
    elif (
        payout is not None
        and payout.get("status") == "awaiting_refund"
        and _cents(payout.get("refund_amount_cents")) is not None
    ):
        # Finalized delivery owes a prorated refund the worker has not started.
        state, amount = "pending", _cents(payout.get("refund_amount_cents"))
    finalized = payout is not None and payout.get("finalized_at") is not None
    return {
        "state": state or "none",
        "amountCents": amount,
        "grossCents": (_cents(payout.get("gross_amount_cents")) if payout is not None else None)
        or _cents(order_amount_cents),
        "expectedFiles": _count(payout.get("expected_files")) if finalized else None,
        "confirmedFiles": _count(payout.get("confirmed_files")) if finalized else None,
    }


def requester_recovery_view(
    *,
    request_status: str,
    review_requested_at: datetime | None,
    outcomes: Mapping[tuple[str, str | None], int],
    retryable_count: int,
    retryable_updated_at: datetime | None,
    request_open: bool,
    paid: bool,
    refund: Mapping[str, Any] | None = None,
    payout: Mapping[str, Any] | None = None,
    order_amount_cents: int | None = None,
) -> dict[str, Any] | None:
    """The requester's recovery block, or None when nothing is missing.

    ``outcomes`` counts the requester's bulk effects by (state, safe_error_code).
    ``retryable_count`` and ``retryable_updated_at`` describe the effects an
    owner retry would requeue. ``request_open``: unexpired, access not stopped,
    still connected. ``paid``: no payment is required or the order is paid.
    """
    # A finalized payout froze the delivered count for the prorated refund and
    # the owner's earning; a retry after it would share files nobody paid for.
    payout_final = payout is not None and payout.get("finalized_at") is not None
    retry_open = request_open and paid and not payout_final
    if request_status not in RECOVERY_REQUEST_STATUSES and not (
        review_requested_at is not None and request_status in RETRYING_REQUEST_STATUSES
    ):
        return None
    undelivered = sum(n for (state, _), n in outcomes.items() if state in UNDELIVERED_STATES)
    in_flight = sum(n for (state, _), n in outcomes.items() if state in IN_FLIGHT_STATES)
    if undelivered == 0 and in_flight == 0:
        return None
    reasons: Counter[str] = Counter()
    for (state, reason), n in outcomes.items():
        if state in UNDELIVERED_STATES and n > 0:
            reasons[safe_bulk_reason(reason)] += n
    retryable = max(0, retryable_count)
    if in_flight and review_requested_at is not None:
        retry_state = "retrying"
    elif retryable and retry_open and not in_flight:
        # An ask stays "requested" until the owner touches those files again.
        asked = review_requested_at is not None and (
            retryable_updated_at is None or review_requested_at >= retryable_updated_at
        )
        retry_state = "requested" if asked else "available"
    else:
        retry_state = "unavailable"
    return {
        "undeliveredCount": undelivered,
        "reasons": [{"reasonCode": code, "count": n} for code, n in sorted(reasons.items())],
        "ownerRetry": {
            "state": retry_state,
            "retryableCount": retryable if retry_state in {"available", "requested"} else 0,
            "requestedAt": _instant(review_requested_at),
        },
        "refund": _refund(refund, payout, order_amount_cents),
    }


def review_request_result(request_id: str, recovery: Mapping[str, Any]) -> dict[str, Any]:
    """POST review-request reply: the new retry state and the requester's refund."""
    retry, refund = recovery["ownerRetry"], recovery["refund"]
    return {
        "requestId": request_id,
        "reviewRequestedAt": retry["requestedAt"],
        "ownerRetry": {"state": retry["state"], "retryableCount": retry["retryableCount"]},
        "refund": {"state": refund["state"], "amountCents": refund["amountCents"]},
    }


def owner_review_request_view(
    recovery: Mapping[str, Any] | None, *, review_request_count: int
) -> dict[str, Any] | None:
    """The owner's notice for an unanswered ask, or None.

    Shown while the requester's latest ask waits for a retry, or when the ask
    can no longer be met (the owner then sees what the requester got back).
    Hidden once the owner retried after the ask or a retry is running. Whether
    the owner can retry right now stays with the owner's own bulk share view.
    """
    if recovery is None or recovery["ownerRetry"]["requestedAt"] is None:
        return None
    retry, refund = recovery["ownerRetry"], recovery["refund"]
    if retry["state"] not in {"requested", "unavailable"}:
        return None
    expected, confirmed = refund["expectedFiles"], refund["confirmedFiles"]
    unshared = (
        expected - confirmed
        if expected is not None and confirmed is not None and expected > confirmed
        else recovery["undeliveredCount"]
    )
    return {
        "requestedAt": retry["requestedAt"],
        "count": max(0, min(MAX_REVIEW_REQUESTS, review_request_count)),
        "unsharedCount": unshared,
        "refund": {"state": refund["state"], "amountCents": refund["amountCents"]},
    }
