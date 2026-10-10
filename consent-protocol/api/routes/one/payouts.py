"""Packet owner payouts through Stripe Connect (hussh is the broker).

  GET  /api/one/payouts          -> payout account readiness + earnings totals
  POST /api/one/payouts/onboard  -> {url} Stripe-hosted Express onboarding
  GET  /api/one/payouts/account  -> account readiness only, for document owners
  POST /api/one/payouts/account/onboard -> {url} document-owner onboarding
  GET  /api/one/payouts/account/bank-payouts -> owner's aggregate bank deposits
  POST /api/one/payouts/connect/webhook -> signed connected-account events

Owner-scoped (vault owner token). Earnings become due when a bought packet is
delivered; the work drain transfers them once payouts are enabled.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from api.middleware import require_vault_owner_token
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from hushh_mcp.services.stripe_connect_bank_payouts import (
    ConnectBankPayoutError,
    StripeConnectBankPayouts,
)

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


@router.get("/account")
async def get_payout_account(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        account: dict[str, Any] = await _service().account_status(user_id=token_data["user_id"])
        return account
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None


@router.post("/account/onboard")
async def onboard_payout_account(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        link: dict[str, Any] = await _service().onboarding_link(
            user_id=token_data["user_id"], surface="documents"
        )
        return link
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None


@router.get("/account/bank-payouts")
async def get_bank_payouts(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        summary: dict[str, Any] = await StripeConnectBankPayouts().owner_summary(
            user_id=token_data["user_id"]
        )
        return summary
    except ConnectBankPayoutError:
        raise HTTPException(status_code=503, detail="Bank payout status is unavailable.") from None


@router.post("/connect/webhook")
async def stripe_connect_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
) -> dict[str, str]:
    payload = await request.body()
    if len(payload) > 128_000:
        raise HTTPException(status_code=413, detail="Event is too large.")
    try:
        result = await StripeConnectBankPayouts().process_webhook(
            payload=payload, signature=stripe_signature
        )
    except ConnectBankPayoutError as exc:
        status = {
            "invalid_signature": 400,
            "invalid_event": 400,
            "provider_mismatch": 409,
        }.get(exc.code, 503)
        raise HTTPException(
            status_code=status,
            detail="Connect event could not be processed.",
            headers={"Cache-Control": "no-store"},
        ) from None
    return {"status": result}
