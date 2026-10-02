"""Packet owner payouts through Stripe Connect (hussh is the broker).

  GET  /api/one/payouts          -> payout account readiness + earnings totals
  POST /api/one/payouts/onboard  -> {url} Stripe-hosted Express onboarding

Owner-scoped (vault owner token). Earnings become due when a bought packet is
delivered; the work drain transfers them once payouts are enabled.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response

from api.middleware import require_vault_owner_token
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
from hushh_mcp.services.pkm_payout_service import PkmPayoutService

router = APIRouter(prefix="/api/one/payouts", tags=["One Packet Payouts"])


def _service() -> PkmPayoutService:
    return PkmPayoutService()


@router.get("")
async def get_payouts(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        summary: dict[str, Any] = await _service().summary(user_id=token_data["user_id"])
        return summary
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None


@router.post("/onboard")
async def onboard(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        link: dict[str, Any] = await _service().onboarding_link(user_id=token_data["user_id"])
        return link
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None
