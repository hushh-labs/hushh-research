"""Requester payment state and Stripe's signed server-to-server settlement callback."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from api.middleware import require_firebase_auth_read_only
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.pkm_packet_order_service import (
    PAYMENT_KIND as PKM_PACKET_PAYMENT_KIND,
)
from hushh_mcp.services.pkm_packet_order_service import (
    PacketOrderError,
    PkmPacketOrderService,
    webhook_payment_kind,
)

router = APIRouter(prefix="/api/connectors/google_drive/sharing", tags=["drive-request-payments"])
webhook_router = APIRouter(prefix="/api/payments/stripe", tags=["payments"])


def _service() -> DriveRequestPaymentService:
    return DriveRequestPaymentService()


def _http(error: Exception) -> HTTPException:
    code = str(error) if isinstance(error, DriveSharingError) else "payment_unavailable"
    known = {
        "request_unavailable": (404, "This request is unavailable."),
        "invalid_argument": (422, "Check the request ID."),
        "payment_not_ready": (409, "Payment is not ready for this request."),
        "payment_already_paid": (409, "This request has already been paid."),
        "payment_checkout_expired": (409, "This checkout expired. Refresh the request."),
        "payment_invalid_signature": (400, "Invalid payment signature."),
        "payment_invalid_event": (409, "Payment event could not be matched."),
    }
    status, detail = known.get(code, (503, "Payment is temporarily unavailable."))
    return HTTPException(status_code=status, detail=detail, headers={"Cache-Control": "no-store"})


@router.get("/requests/{request_id}/payment")
async def get_drive_request_payment(
    request_id: UUID,
    response: Response,
    requester_user_id: str = Depends(require_firebase_auth_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _service().get_payment(
            requester_user_id=requester_user_id, request_id=str(request_id)
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/requests/{request_id}/payment/checkout")
async def create_drive_request_checkout(
    request_id: UUID,
    response: Response,
    requester_user_id: str = Depends(require_firebase_auth_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _service().checkout(
            requester_user_id=requester_user_id, request_id=str(request_id)
        )
    except Exception as error:
        raise _http(error) from None


@webhook_router.post("/webhook")
async def stripe_drive_request_webhook(
    request: Request, stripe_signature: str | None = Header(default=None, alias="Stripe-Signature")
):
    # Stripe signs the exact bytes; parsing/re-serializing first breaks verification.
    payload = await request.body()
    if len(payload) > 128_000:
        raise HTTPException(status_code=413, detail="Payment event is too large.")
    # One Stripe endpoint, two kinds of payment. Route on the (unverified)
    # payment_kind; each handler verifies the signature before acting.
    if webhook_payment_kind(payload) in {PKM_PACKET_PAYMENT_KIND, "pkm_credits"}:
        try:
            await PkmPacketOrderService().process_webhook(
                payload=payload, signature=stripe_signature
            )
        except PacketOrderError as error:
            status = 400 if error.code == "INVALID_SIGNATURE" else 409
            if error.code == "PAYMENT_UNAVAILABLE":
                status = 503
            raise HTTPException(
                status_code=status, detail=str(error), headers={"Cache-Control": "no-store"}
            ) from None
        return {"received": True}
    try:
        await _service().process_webhook(payload=payload, signature=stripe_signature)
    except Exception as error:
        raise _http(error) from None
    return {"received": True}
