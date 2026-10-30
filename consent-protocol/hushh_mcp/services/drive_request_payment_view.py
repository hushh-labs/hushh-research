"""The requester's payment view of one Drive document request (pure).

Every surface that tells a requester about payment builds it here: request
status, GET /payment, the Consent Center entry and the Feed. They therefore
cannot disagree about state, link expiry or request expiry. Inputs are rows
the caller already read; nothing here touches the database or Stripe, and the
view never carries provider identifiers, owner earnings or file details.

State precedence, first match wins:

1. no payment required                    -> none
2. order refunded or paid                 -> refunded | partially_refunded |
                                             refund_pending | paid
3. request closed or access stopped       -> closed
4. request expired (status or deadline)   -> request_expired
5. Checkout window over, or wrong mode    -> link_expired
6. owner setup still needed               -> awaiting_owner
7. bound, unexpired Checkout session      -> payable
8. anything else before payment           -> preparing

Request expiry always wins over link expiry, so a link is only ever "expired"
while its request is still open. Money states win over everything: a late
payment on a closed request is never shown as closed or unpaid.

An autoshare request (the sealed ``oct17_autoshare`` flow) asks for payment
when the owner allows, before any file is found, and refunds what is not
sent. Only a caller that opened the request envelope knows that, so it passes
``autoshare=True`` and the view carries ``autoshare``; ``checkoutPending``
then tells "the order exists, its link is being made" apart from "nothing
is due yet" within ``preparing``. Both keys are absent otherwise, so every
older request keeps its exact shape and copy. Presentation only, never
payment authority.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

PAYMENT_VIEW_STATES = frozenset(
    {
        "none",
        "awaiting_owner",
        "preparing",
        "payable",
        "link_expired",
        "request_expired",
        "paid",
        "refund_pending",
        "refunded",
        "partially_refunded",
        "closed",
    }
)
NEXT_ACTIONS = frozenset({"pay", "wait_owner", "new_request", "none"})
REFUND_VIEW_STATUSES = frozenset({"queued", "pending", "succeeded", "manual_review", "failed"})

# Statuses in which a request can still take (or be waiting for) payment.
OPEN_REQUEST_STATUSES = frozenset({"pending", "preparing", "review_ready", "approved", "partial"})
OWNER_SETUP_CODES = frozenset(
    {"owner_price_required", "owner_payout_required", "payout_unavailable"}
)

# A provider outcome that is not known yet is still pending, never a refund.
_REFUND_STATUS = {
    "queued": "queued",
    "dispatching": "pending",
    "unknown": "pending",
    "pending": "pending",
    "succeeded": "succeeded",
    "manual_review": "manual_review",
    "failed": "failed",
}
_NEXT_ACTION = {
    "payable": "pay",
    "awaiting_owner": "wait_owner",
    "preparing": "wait_owner",
    "link_expired": "new_request",
    "request_expired": "new_request",
}


def _instant(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _cents(value: Any) -> int | None:
    return value if type(value) is int and 0 < value <= 50000 else None


def _view(
    state: str,
    *,
    amount_cents: int | None,
    request_expires_at: datetime | None,
    withdrawn: bool,
    checkout_expires_at: datetime | None = None,
    refund: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "state": state,
        "amountCents": amount_cents,
        "currency": "usd",
        "checkoutExpiresAt": _instant(checkout_expires_at) if state == "payable" else None,
        "requestExpiresAt": _instant(request_expires_at),
        "refund": refund,
        "nextAction": _NEXT_ACTION.get(state, "none"),
        "withdrawn": withdrawn,
    }


def order_view_input(order: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Normalize a drive_request_payment_orders row (raw columns) for the view."""
    if order is None:
        return None
    bound = order.get("stripe_checkout_session_id") is not None
    return {
        "status": order.get("status"),
        "amount_cents": order.get("amount_cents"),
        "checkout_bound": bound,
        "checkout_expires_at": order.get("stripe_checkout_expires_at") if bound else None,
        "reconciliation_reason": order.get("reconciliation_reason"),
        "stripe_mode": order.get("stripe_mode"),
    }


def requester_payment_view(
    *,
    payment_required: bool,
    request_status: str,
    request_expires_at: datetime | None,
    now: datetime,
    access_stopped: bool = False,
    preparation_error_code: str | None = None,
    quoted_amount_cents: int | None = None,
    order: Mapping[str, Any] | None = None,
    refund: Mapping[str, Any] | None = None,
    owner_payout_ready: bool | None = None,
    configured_mode: str | None = None,
    package_disclosure_required: bool = False,
    package_disclosure: dict[str, Any] | None = None,
    autoshare: bool = False,
) -> dict[str, Any]:
    """Return the closed RequesterPaymentView shape for one request.

    ``order`` is the normalized shape from :func:`order_view_input` (SQL
    projections may build it directly). ``refund`` is the request's refund row
    (``status``, ``amount_cents``). ``owner_payout_ready`` is ``False`` only
    when an enrolled bank-settled order is waiting for the owner's payout
    account, ``None`` when unknown or not applicable. ``autoshare`` is the
    request's sealed flow (``autoshare_request``); it never changes the state.
    """

    def disclosed_view(*args, **kwargs) -> dict[str, Any]:
        result = _view(*args, **kwargs)
        if package_disclosure_required:
            result["packageDisclosureRequired"] = True
            if package_disclosure is not None:
                result["packageDisclosure"] = package_disclosure
        if autoshare is True:
            result["autoshare"] = True
            if result["state"] == "preparing" and order is not None:
                result["checkoutPending"] = True
        return result

    withdrawn = request_status == "cancelled"
    if not payment_required and not (order and order.get("status") in {"paid", "refunded"}):
        return disclosed_view(
            "none", amount_cents=None, request_expires_at=request_expires_at, withdrawn=withdrawn
        )
    order_status = order.get("status") if order is not None else None
    order_amount = _cents(order.get("amount_cents")) if order is not None else None

    if order is not None and order_status in {"paid", "refunded"}:
        refund_status = _REFUND_STATUS.get(str(refund.get("status"))) if refund else None
        refund_amount = (
            (_cents(refund.get("amount_cents")) or order_amount) if refund is not None else None
        )
        paid = {
            "amount_cents": order_amount,
            "request_expires_at": request_expires_at,
            "withdrawn": withdrawn,
        }
        if order_status == "refunded":
            return disclosed_view(
                "refunded",
                **paid,
                refund={"status": "succeeded", "amountCents": refund_amount or order_amount},
            )
        if refund_status is not None and refund_amount is not None:
            if refund_status == "succeeded":
                return disclosed_view(
                    "partially_refunded"
                    if order_amount is not None and refund_amount < order_amount
                    else "refunded",
                    **paid,
                    refund={"status": "succeeded", "amountCents": refund_amount},
                )
            return disclosed_view(
                "refund_pending",
                **paid,
                refund={"status": refund_status, "amountCents": refund_amount},
            )
        if order.get("reconciliation_reason") == "request_closed" and order_amount is not None:
            # Paid after the request closed: nothing can be delivered, and the
            # refund worker returns the full amount.
            return disclosed_view(
                "refund_pending",
                **paid,
                refund={"status": "queued", "amountCents": order_amount},
            )
        return disclosed_view("paid", **paid)

    amount = (
        order_amount
        if order is not None
        else None
        if preparation_error_code == "owner_price_required"
        else _cents(quoted_amount_cents)
    )
    unpaid = {
        "amount_cents": amount,
        "request_expires_at": request_expires_at,
        "withdrawn": withdrawn,
    }
    if access_stopped or (
        request_status not in OPEN_REQUEST_STATUSES and request_status != "expired"
    ):
        return disclosed_view("closed", **unpaid)
    if request_status == "expired" or (
        request_expires_at is not None and request_expires_at <= now
    ):
        return disclosed_view("request_expired", **unpaid)
    if order is not None:
        expires_at = order.get("checkout_expires_at")
        if (
            order_status == "expired"
            or (
                configured_mode is not None
                and order.get("stripe_mode") is not None
                and order.get("stripe_mode") != configured_mode
            )
            or (
                order.get("checkout_bound") is True
                and (not isinstance(expires_at, datetime) or expires_at <= now)
            )
        ):
            return disclosed_view("link_expired", **unpaid)
    if owner_payout_ready is False or (
        order is None and preparation_error_code in OWNER_SETUP_CODES
    ):
        return disclosed_view("awaiting_owner", **unpaid)
    if (
        order is not None
        and order_status == "checkout_open"
        and order.get("checkout_bound") is True
        and isinstance(order.get("checkout_expires_at"), datetime)
    ):
        return disclosed_view("payable", **unpaid, checkout_expires_at=order["checkout_expires_at"])
    return disclosed_view("preparing", **unpaid)
