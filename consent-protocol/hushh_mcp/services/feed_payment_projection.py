"""Truthful bounded requester payment copy fields from the owning payment view."""

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.drive_request_outcome_view import request_outcome_view


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


DRIVE_DELIVERY_COUNT_FIELDS = (
    "current_delivery_total_count",
    "current_delivery_confirmed_count",
    "current_delivery_pending_count",
)


def _document_state(
    row: dict[str, Any], current: dict[str, Any], projection: dict[str, Any]
) -> None:
    is_document_group = str(row.get("thread_key") or "").startswith("document:")
    if is_document_group and current:
        projection.update(
            {
                "feed_audience": "owner" if current["viewer_is_owner"] else "recipient",
                "current_request_status": current.get("current_request_status"),
                "current_request_expired": current.get("current_request_expired") is True,
                "current_access_stopped": current.get("current_access_stopped") is True,
                "current_payment_status": current.get("current_payment_status"),
            }
        )
        for field in ("current_payment_amount_cents", "current_refund_amount_cents"):
            amount = current.get(field)
            if type(amount) is int and amount >= 0:
                projection[field] = amount
    if (
        row.get("event_type") == "document_share_outcome"
        and current.get("current_request_status") == "partial"
    ) or (
        is_document_group
        and current.get("current_request_status") in {"partial", "completed"}
        and current.get("current_access_stopped") is not True
    ):
        # Historical outcome rows use current participant-scoped receipts,
        # not payment state or the ambiguous request-level partial flag.
        for field in DRIVE_DELIVERY_COUNT_FIELDS:
            count = current.get(field)
            if type(count) is int and count >= 0:
                projection[field] = count


def _payment_readiness(current: dict[str, Any], projection: dict[str, Any]) -> None:
    # Fail closed in presentation: a missing read cannot authorize
    # an old Pay instruction. The action rechecks the live order.
    projection.update(
        {
            "current_payment_status": current.get("current_payment_status") or "unavailable",
            "current_request_status": current.get("current_request_status") or "unavailable",
            "current_checkout_expired": current.get("current_checkout_expired") is True,
            "current_request_expired": current.get("current_request_expired") is True,
            "current_access_stopped": current.get("current_access_stopped") is True,
        }
    )
    readiness = current.get("current_owner_payout_account_ready")
    if type(readiness) is bool:
        projection["current_owner_payout_account_ready"] = readiness
    for field in ("current_checkout_expires_at", "current_request_expires_at"):
        instant = current.get(field)
        if instant is not None:
            projection[field] = (
                instant.isoformat() if hasattr(instant, "isoformat") else str(instant)
            )


def _owner_and_refund(
    row: dict[str, Any], current: dict[str, Any], projection: dict[str, Any]
) -> None:
    if current.get("viewer_is_owner") is True and row.get("event_type") in {
        "document_share_request",
        "document_share_outcome",
    }:
        status = current.get("owner_payout_status")
        if isinstance(status, str):
            projection["owner_payout_status"] = status
        readiness = current.get("owner_payout_account_ready")
        if type(readiness) is bool:
            projection["owner_payout_account_ready"] = readiness
        earning = current.get("owner_earning_cents")
        if type(earning) is int and earning >= 0:
            projection["owner_earning_cents"] = earning
    if (
        current.get("viewer_is_owner") is False
        and row.get("event_type") == "document_share_payment_refunded"
    ):
        refund_amount = current.get("current_refund_amount_cents")
        payment_amount = current.get("current_payment_amount_cents")
        if (
            type(refund_amount) is int
            and type(payment_amount) is int
            and (0 < refund_amount <= payment_amount)
        ):
            projection["current_refund_amount_cents"] = refund_amount
            projection["current_payment_amount_cents"] = payment_amount


def project_document_payment_rows(
    rows: list[dict[str, Any]],
    by_request: dict[str, dict[str, Any]],
    requester_projection: Callable[[str, dict[str, Any]], dict[str, Any]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for row in rows:
        if not str(row.get("event_type") or "").startswith("document_share_"):
            result.append(row)
            continue
        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            result.append(row)
            continue
        current = by_request.get(str(metadata.get("request_id") or ""), {})
        # These fields are live receipt projections, never snapshot claims.
        metadata = {
            key: value for key, value in metadata.items() if key not in DRIVE_DELIVERY_COUNT_FIELDS
        }
        projection: dict[str, Any] = {}
        metadata.pop("current_existing_access_nocharge", None)
        metadata.pop("current_outcome_reason", None)
        _document_state(row, current, projection)
        if row.get("event_type") == "document_share_payment_ready":
            _payment_readiness(current, projection)
        _owner_and_refund(row, current, projection)
        if current.get("viewer_is_owner") is False and row.get("event_type") in {
            "document_share_payment_ready",
            "document_share_payment_confirmed",
        }:
            projection.update(requester_projection(row["event_type"], current))
        result.append(
            {
                **row,
                "metadata": {**metadata, **projection},
                "_drive_outcome_reason": request_outcome_view(
                    {**current, "status": current.get("current_request_status")}
                ).get("outcomeReason")
                if row.get("event_type") == "document_share_outcome"
                else None,
                "_drive_existing_access_nocharge": current.get("current_existing_access_nocharge")
                is True,
            }
        )
    return result
