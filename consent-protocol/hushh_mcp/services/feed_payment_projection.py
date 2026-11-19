"""Truthful bounded requester payment copy fields from the owning payment view."""

from datetime import datetime, timezone
from typing import Any


def _aware_instant(value: object) -> datetime | None:
    """A timezone-aware instant from a database value, or None."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def requester_payment_projection(event_type: str, current: dict[str, Any]) -> dict[str, Any]:
    """The shared payment view state for the requester's own payment rows.
    A confirmed-payment row changes only when that payment arrived after
    the request closed (it is refunded, never "confirmed"); otherwise the
    historical confirmation stays as it was.
    """
    if current.get("view_payment_required") is not True:
        return {}
    if (
        event_type == "document_share_payment_confirmed"
        and current.get("view_reconciliation_reason") != "request_closed"
    ):
        return {}
    from hushh_mcp.services.drive_request_payment_view import requester_payment_view

    checkout_expires_at = _aware_instant(current.get("current_checkout_expires_at"))
    status = current.get("current_payment_status")
    readiness = current.get("current_owner_payout_account_ready")
    view = requester_payment_view(
        payment_required=True,
        request_status=str(current.get("current_request_status") or ""),
        request_expires_at=_aware_instant(current.get("current_request_expires_at")),
        now=datetime.now(timezone.utc),
        access_stopped=current.get("current_access_stopped") is True,
        preparation_error_code=current.get("view_preparation_error_code"),
        quoted_amount_cents=current.get("view_quoted_amount_cents"),
        order=(
            {
                "status": status,
                "amount_cents": current.get("current_payment_amount_cents"),
                "checkout_bound": checkout_expires_at is not None,
                "checkout_expires_at": checkout_expires_at,
                "reconciliation_reason": current.get("view_reconciliation_reason"),
            }
            if isinstance(status, str)
            else None
        ),
        refund=(
            {
                "status": current["view_refund_status"],
                "amount_cents": current.get("view_refund_amount_cents"),
            }
            if isinstance(current.get("view_refund_status"), str)
            else None
        ),
        owner_payout_ready=readiness if type(readiness) is bool else None,
    )
    projection: dict[str, Any] = {"current_payment_state": view["state"]}
    if event_type == "document_share_payment_confirmed":
        projection["current_request_status"] = current.get("current_request_status")
        refund = view.get("refund")
        if refund is not None and type(refund.get("amountCents")) is int:
            projection["current_refund_amount_cents"] = refund["amountCents"]
    return projection
