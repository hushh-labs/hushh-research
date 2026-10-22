"""Packet owner payouts through Stripe Connect (hussh is the broker).

  GET  /api/one/payouts          -> payout account readiness + earnings totals
  POST /api/one/payouts/onboard  -> {url} Stripe-hosted Express onboarding
  GET  /api/one/payouts/account?fresh= -> account readiness and verification, for document
       owners (a 30 s display cache; fresh=true reads Stripe again)
  POST /api/one/payouts/account/onboard -> {url} document-owner onboarding
       (optional body {"purpose":"verify"} collects upcoming requirements too)
  GET  /api/one/payouts/account/bank-payouts?cursor= -> owner's aggregate bank deposits
  GET  /api/one/payouts/account/earnings?cursor=&mode=live|test -> paginated document transactions
  POST /api/one/payouts/account/manage -> owner's Express bank settings
  POST /api/one/payouts/connect/webhook -> signed connected-account events

Owner-scoped (vault owner token). Earnings become due when a bought packet is
delivered; the work drain transfers them once payouts are enabled.
"""

from __future__ import annotations

import inspect
import logging
import os
import re
from collections.abc import Callable, Coroutine
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from hushh_mcp.services.stripe_connect_bank_payouts import (
    ConnectBankPayoutError,
    StripeConnectBankPayouts,
)
from hushh_mcp.services.stripe_mode import (
    configured_connect_mode,
    configured_stripe_mode,
    connect_config,
)

logger = logging.getLogger(__name__)

_PRIVATE = "private, no-store"
_NO_STORE = {"Cache-Control": _PRIVATE}
# "test" history also shows rows recorded before Stripe mode isolation.
_EARNING_MODES = {"live": ("live",), "test": ("test", "legacy")}
_SAFE_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_MAX_CURSOR_CHARS = 256


class _PrivateRoute(APIRoute):
    """Every response, including auth and validation failures, is private and uncached."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                headers = {**(exc.headers or {}), "Cache-Control": _PRIVATE}
                raise HTTPException(exc.status_code, exc.detail, headers=headers) from None
            except RequestValidationError as exc:
                # The app's own handler keeps the error body installed builds already read.
                render = request.app.exception_handlers.get(
                    RequestValidationError, request_validation_exception_handler
                )
                rendered = render(request, exc)
                response = await rendered if inspect.isawaitable(rendered) else rendered
            response.headers["Cache-Control"] = _PRIVATE
            return response

        return private_handler


router = APIRouter(
    prefix="/api/one/payouts", tags=["One Packet Payouts"], route_class=_PrivateRoute
)


def _query_error(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=422, detail={"code": code, "message": message}, headers=_NO_STORE
    )


class OnboardBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: Literal["verify"] | None = None


def _connect_event_rejected(route: str, status: int, code: str) -> None:
    """Name the closed failure code; never the event, account or provider text."""
    logger.warning(
        "connect_webhook.rejected route=%s status=%s code=%s",
        route,
        status,
        code if _SAFE_CODE.fullmatch(code) else "other",
    )


def _service() -> PkmPayoutService:
    return PkmPayoutService()


def _document_service() -> PkmPayoutService:
    try:
        key, mode = connect_config()
    except ValueError:
        raise PacketOrderError("PAYOUT_UNAVAILABLE", "Bank setup is unavailable.") from None
    if mode == configured_stripe_mode() and not os.getenv("STRIPE_CONNECT_SECRET_KEY"):
        return _service()
    return PkmPayoutService(mode=mode, api_key=key)


def _document_bank_service() -> StripeConnectBankPayouts:
    if configured_connect_mode() == configured_stripe_mode() and not os.getenv(
        "STRIPE_CONNECT_SECRET_KEY"
    ):
        return StripeConnectBankPayouts()
    return StripeConnectBankPayouts(connect_mode=True)


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
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
    fresh: bool = Query(False),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        account: dict[str, Any] = await _document_service().account_status(
            user_id=token_data["user_id"], force_refresh=fresh
        )
        return account
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None


@router.post("/account/onboard")
async def onboard_payout_account(
    response: Response,
    body: OnboardBody | None = Body(default=None),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    purpose: Literal["onboarding", "verify"] = (
        "verify" if body is not None and body.purpose == "verify" else "onboarding"
    )
    try:
        link: dict[str, Any] = await _document_service().onboarding_link(
            user_id=token_data["user_id"], surface="documents", purpose=purpose
        )
        return link
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}, headers=_NO_STORE
        ) from None


@router.get("/account/bank-payouts")
async def get_bank_payouts(
    response: Response,
    cursor: str | None = None,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    # Checked here, not by Query(), so the error carries a code and stays private.
    if cursor is not None and not 1 <= len(cursor) <= _MAX_CURSOR_CHARS:
        raise _query_error("INVALID_CURSOR", "Bank payout page is unavailable.")
    try:
        summary: dict[str, Any] = await _document_bank_service().owner_summary(
            user_id=token_data["user_id"], cursor=cursor
        )
        return summary
    except (ConnectBankPayoutError, ConnectorLifecycleError) as exc:
        if isinstance(exc, ConnectBankPayoutError) and exc.code == "invalid_cursor":
            # A cursor this server did not issue for this owner.
            raise _query_error("INVALID_CURSOR", "Bank payout page is unavailable.") from None
        raise HTTPException(
            status_code=503,
            detail="Bank payout status is unavailable.",
            headers={"Cache-Control": "private, no-store"},
        ) from None


@router.post("/account/manage")
async def manage_payout_account(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, str]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        link: dict[str, str] = await _document_service().management_link(
            user_id=token_data["user_id"]
        )
        return link
    except PacketOrderError as exc:
        raise HTTPException(
            status_code=503, detail={"code": exc.code, "message": str(exc)}
        ) from None


@router.get("/account/earnings")
async def document_earnings(
    response: Response,
    cursor: UUID | None = None,
    mode: str | None = None,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService

    response.headers["Cache-Control"] = "private, no-store"
    if mode is not None and mode not in _EARNING_MODES:
        raise _query_error("INVALID_MODE", "Choose live or test.")
    try:
        # Old builds send no mode and see only the configured mode's earnings.
        selected = mode or configured_stripe_mode()
        history: dict[str, Any] = await DriveRequestOwnerPayoutService().owner_history(
            user_id=token_data["user_id"],
            cursor=str(cursor) if cursor else None,
            modes=_EARNING_MODES[selected],
        )
        return {**history, "mode": selected}
    except Exception as exc:
        logger.warning("document_earnings.unavailable type=%s", type(exc).__name__)
        raise HTTPException(
            status_code=503, detail="Transactions are unavailable.", headers=_NO_STORE
        ) from None


@router.post("/connect/webhook")
async def stripe_connect_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
) -> dict[str, str]:
    payload = await request.body()
    if len(payload) > 128_000:
        _connect_event_rejected("live", 413, "payload_too_large")
        raise HTTPException(status_code=413, detail="Event is too large.")
    try:
        result = await StripeConnectBankPayouts().process_webhook(
            payload=payload, signature=stripe_signature
        )
    except (ConnectBankPayoutError, ConnectorLifecycleError) as exc:
        code = exc.code if isinstance(exc, ConnectBankPayoutError) else "storage_unavailable"
        status = {
            "invalid_signature": 400,
            "invalid_event": 400,
            "provider_mismatch": 409,
        }.get(code, 503)
        _connect_event_rejected("live", status, code)
        raise HTTPException(
            status_code=status,
            detail="Connect event could not be processed.",
            headers={"Cache-Control": "no-store"},
        ) from None
    return {"status": result}


@router.post("/connect/sandbox-webhook")
async def stripe_connect_sandbox_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
) -> dict[str, str]:
    """Test Connect events cannot update live financial or bank bindings."""
    if configured_connect_mode() != "test":
        _connect_event_rejected("sandbox", 404, "sandbox_disabled")
        raise HTTPException(status_code=404, detail="Sandbox payouts are unavailable.")
    payload = await request.body()
    if len(payload) > 128_000:
        _connect_event_rejected("sandbox", 413, "payload_too_large")
        raise HTTPException(status_code=413, detail="Event is too large.")
    try:
        result = await StripeConnectBankPayouts(connect_mode=True).process_webhook(
            payload=payload, signature=stripe_signature
        )
    except (ConnectBankPayoutError, ConnectorLifecycleError) as exc:
        code = exc.code if isinstance(exc, ConnectBankPayoutError) else "storage_unavailable"
        status = {"invalid_signature": 400, "invalid_event": 400, "provider_mismatch": 409}.get(
            code, 503
        )
        _connect_event_rejected("sandbox", status, code)
        raise HTTPException(
            status_code=status, detail="Connect event could not be processed."
        ) from None
    return {"status": result}


class HashcoinRedemptionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amountCoins: StrictInt = Field(gt=0, le=50_000)
    clientRequestId: UUID
    mode: Literal["test", "live"]


def _hashcoin_error(exc: Exception) -> HTTPException:
    from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionError
    from hushh_mcp.services.hashcoin_wallet_service import HashcoinError

    if isinstance(exc, HashcoinRedemptionError):
        return HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}
        )
    if isinstance(exc, PacketOrderError):
        return HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    if isinstance(exc, HashcoinError):
        code, message = {
            "insufficient_balance": ("HASHCOINS_INSUFFICIENT", "Not enough redeemable coins."),
            "live_source_unavailable": (
                "REDEMPTION_SOURCE_UNAVAILABLE",
                "This earning is not available for withdrawal. Refresh and try again.",
            ),
            "wallet_held": ("HASHCOINS_HELD", "These earnings are under review."),
            "redemption_mismatch": ("REDEMPTION_CONFLICT", "Use the original redemption amount."),
            "invalid_amount": ("INVALID_AMOUNT", "Enter a valid coin amount."),
            "live_redemption_unavailable": (
                "LIVE_REDEMPTION_DISABLED",
                "Real bank withdrawals are not available yet.",
            ),
        }.get(exc.code, ("PAYOUT_UNAVAILABLE", "Payouts are unavailable. Try again."))
        return HTTPException(status_code=409, detail={"code": code, "message": message})
    logger.warning("hashcoin.request_failed type=%s", type(exc).__name__)
    return HTTPException(
        status_code=503,
        detail={
            "code": "PAYOUT_UNAVAILABLE",
            "message": "Payouts are unavailable. Try again.",
        },
    )


@router.get("/hashcoins")
async def get_hashcoins(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionService

    response.headers["Cache-Control"] = "private, no-store"
    try:
        summary: dict[str, Any] = await HashcoinRedemptionService().summary(
            user_id=token_data["user_id"]
        )
        return summary
    except Exception as exc:
        failure = _hashcoin_error(exc)
        failure.headers = {"Cache-Control": "private, no-store"}
        raise failure from None


@router.post("/hashcoins/redeem")
async def redeem_hashcoins(
    body: HashcoinRedemptionBody,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionService

    response.headers["Cache-Control"] = "private, no-store"
    try:
        redemption: dict[str, Any] = await HashcoinRedemptionService().redeem(
            user_id=token_data["user_id"],
            amount_coins=body.amountCoins,
            client_request_id=str(body.clientRequestId),
            mode=body.mode,
        )
        return redemption
    except Exception as exc:
        failure = _hashcoin_error(exc)
        failure.headers = {"Cache-Control": "private, no-store"}
        raise failure from None
