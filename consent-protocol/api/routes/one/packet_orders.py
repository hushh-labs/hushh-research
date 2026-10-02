"""Buy a PKM packet (hussh is the broker).

  POST /api/one/packet-orders            {listingId, packetId} -> {orderId, checkoutUrl}
  GET  /api/one/packet-orders/{order_id} -> the buyer's order status

Firebase-authenticated buyer. Payment goes to hussh through Stripe Checkout; the
signed webhook (/api/payments/stripe/webhook) marks it paid and files the owner
request. The owner still approves or denies; a denial is refunded.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Response

from api.middleware import require_firebase_auth
from hushh_mcp.services.directory_claim_service import ClaimError
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError, PkmPacketOrderService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/packet-orders", tags=["One PKM Packet Orders"])

_STATUS = {
    "PAYMENT_UNAVAILABLE": 503,
    "PACKET_UNAVAILABLE": 404,
    "OWN_PACKET": 400,
    "INVALID_LISTING_ID": 400,
}


def _service() -> PkmPacketOrderService:
    return PkmPacketOrderService()


@router.post("")
async def create_packet_order(
    response: Response,
    body: dict[str, Any] = Body(...),
    buyer_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        checkout: dict[str, Any] = await _service().create_checkout(
            buyer_user_id=buyer_user_id,
            listing_id=body.get("listingId"),
            packet_id=body.get("packetId"),
        )
        return checkout
    except (PacketOrderError, ClaimError) as exc:
        raise HTTPException(
            status_code=_STATUS.get(exc.code, 400),
            detail={"code": exc.code, "message": str(exc)},
        ) from None


@router.get("/{order_id}")
async def get_packet_order(
    response: Response,
    order_id: str = Path(..., min_length=1, max_length=64),
    buyer_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    order = await _service().get_order(buyer_user_id=buyer_user_id, order_id=order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return {"order": order}
