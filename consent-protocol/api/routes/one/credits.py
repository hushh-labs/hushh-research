"""Credits plans for buying packets.

  GET  /api/one/credits            -> balance, plan, and the three plans
  POST /api/one/credits/subscribe  {plan} -> {checkoutUrl}  (Stripe, hussh's account)
  POST /api/one/credits/cancel     -> stop renewing at the end of the period

Firebase-authenticated. Credits are granted by the signed Stripe webhook on each
paid invoice; unused credits expire when the next month's credits arrive.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response

from api.middleware import require_firebase_auth
from hushh_mcp.services.pkm_credit_service import PkmCreditService
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError

router = APIRouter(prefix="/api/one/credits", tags=["One Credits"])

_STATUS = {"PAYMENT_UNAVAILABLE": 503, "ALREADY_SUBSCRIBED": 409, "UNKNOWN_PLAN": 400}


def _service() -> PkmCreditService:
    return PkmCreditService()


@router.get("")
async def get_credits(
    response: Response, user_id: str = Depends(require_firebase_auth)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    summary: dict[str, Any] = await _service().summary(user_id)
    return summary


@router.post("/subscribe")
async def subscribe(
    response: Response,
    body: dict[str, Any] = Body(...),
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        checkout: dict[str, Any] = await _service().create_subscription_checkout(
            user_id=user_id, plan=str(body.get("plan") or "")
        )
        return checkout
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=_STATUS.get(exc.code, 400),
            detail={"code": exc.code, "message": str(exc)},
        ) from None


@router.post("/cancel")
async def cancel(user_id: str = Depends(require_firebase_auth)) -> dict[str, Any]:
    try:
        return {"cancelled": await _service().cancel_at_period_end(user_id=user_id)}
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None
