"""One-time attendance claim and reviewed organizer Mail settlement."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, get_gmail_delivery_service
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from hushh_mcp.services.google_connection_service import GoogleConnectionError

if TYPE_CHECKING:
    from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService


async def claim_attendance_review(
    service: CalendarScheduleService, *, user_id: str, review_id: str
) -> dict[str, Any] | None:
    """Claim once, or return the durable result of a completed confirmation."""
    params = {"review_id": review_id, "user_id": user_id}
    claim = await service._sql(
        "UPDATE calendar_attendance_reviews SET state = 'executing' WHERE review_id = :review_id AND user_id = :user_id AND state = 'prepared' AND expires_at > NOW() RETURNING review_id",
        params,
    )
    if claim.data:
        return None
    current = await service._sql(
        "SELECT result_json FROM calendar_attendance_reviews WHERE review_id = :review_id AND user_id = :user_id",
        params,
    )
    if current.data and current.data[0].get("result_json"):
        result = current.data[0]["result_json"]
        return json.loads(result) if isinstance(result, str) else result
    raise GoogleConnectionError(
        "This confirmation is in progress or expired. Check Calendar before retrying.",
        status_code=409,
        reason_code="calendar_confirmation_pending",
    )


async def send_reviewed_organizer_mail(
    service: CalendarScheduleService,
    *,
    user_id: str,
    plan: dict[str, Any],
    result: dict[str, Any],
) -> None:
    """Settle Mail only after Calendar confirmed a decline."""
    if result["calendar"] != "declined" or not plan.get("mail"):
        return
    try:
        await service.calendar._check_read_binding(user_id, tuple(plan["binding"]))
        sent = await (service.mail or get_gmail_delivery_service()).execute(
            user_id=user_id,
            action_id=plan["mail"]["action_id"],
            draft_payload=plan["mail"]["draft"],
        )
        result["email"] = "sent" if sent.get("state") == "sent" else "unknown"
        if result["email"] == "unknown":
            result["email_error"] = (
                "Delivery could not be confirmed. Check Sent Mail before sending again."
            )
    except (GmailDeliveryError, GmailApiError) as exc:
        code = exc.code or ""
        result["email"] = "unknown" if "UNKNOWN" in code or "ALREADY" in code else "failed"
        result["email_error"] = str(exc)
    except Exception:
        result["email"] = "unknown"
        result["email_error"] = (
            "Your attendance was declined, but email delivery could not be confirmed. Check Sent Mail before trying again."
        )
