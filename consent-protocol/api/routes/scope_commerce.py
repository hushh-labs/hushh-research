"""Authenticated scope-commerce controls; plaintext information never enters here."""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from asyncpg import UndefinedTableError
from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import Field

from api.routes.scope_commerce_contracts import (
    NO_STORE,
    Owner,
    Payer,
    StrictBody,
    _enabled,
    _error,
    _provider,
    _purchase,
    _quote,
    _service,
    _snake,
    _withdrawal,
)
from api.routes.scope_commerce_exports import router as owner_export_router
from api.routes.scope_commerce_reads import router as read_router
from db.connection import get_pool
from hushh_mcp.services.scope_commerce_requests import (
    resolve_commerce_request,
    validate_tariff_scope,
)

router = APIRouter(prefix="/api/scope-commerce", tags=["scope-commerce"])
webhook_router = APIRouter(prefix="/api/payments/scope-commerce", tags=["scope-commerce"])


class OperationBody(StrictBody):
    idempotency_key: UUID


class TariffBody(OperationBody):
    scope_handle: str = Field(min_length=1, max_length=256)
    machine_scope: str = Field(min_length=1, max_length=512)
    price_cents: int = Field(strict=True, ge=0, le=100_000)
    base_duration_seconds: int = Field(strict=True, ge=3600, le=7_776_000)


class QuoteBody(OperationBody):
    request_id: str = Field(min_length=1, max_length=200)
    duration_seconds: int = Field(strict=True, ge=3600, le=7_776_000)


class ApprovalBody(OperationBody):
    duration_seconds: int = Field(strict=True, ge=3600, le=7_776_000)


class PurchaseBody(OperationBody):
    quote_id: UUID
    confirmed: bool = Field(strict=True)


class FundingBody(OperationBody):
    amount_cents: int = Field(strict=True, ge=50, le=100_000)


class OnboardingBody(OperationBody):
    country: str = Field(pattern=r"^[A-Z]{2}$")


class RefundPreviewBody(StrictBody):
    amount_cents: int = Field(strict=True, ge=1, le=100_000)


class RefundBody(OperationBody):
    amount_cents: int = Field(strict=True, ge=1, le=100_000)
    preview_token: str = Field(min_length=64, max_length=64)


class WithdrawalBody(OperationBody):
    preview_token: str = Field(min_length=64, max_length=64)


@router.get("/account")
async def account(response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        service = _service()
        data = _snake(await service.balance(payer_user_id=user_id, buyer_app_id="shared"))
        earnings = _snake(await service.earnings(owner_user_id=user_id))
        # Reading obligations must work during rollback or a provider outage.
        # The onboarding/withdrawal paths refresh provider eligibility again.
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT account_id,country,eligible FROM scope_commerce_seller_accounts WHERE user_id=$1",
                user_id,
            )
            withdrawals = await conn.fetch(
                """SELECT withdrawal_id,status,net_cents,fee_micro_usd,settled_micro_usd,created_at
                   FROM scope_commerce_withdrawals WHERE user_id=$1
                   ORDER BY created_at DESC LIMIT 20""",
                user_id,
            )
        seller = dict(row) if row else {}
        return {
            "enabled": _enabled(),
            "readiness": await service.readiness(viewer_user_id=user_id),
            "managed_balances": True,
            "currency": "USD",
            "balance": {
                "available_cents": data["balance_cents"],
                "reserved_cents": data["reserved_cents"],
                "frozen_cents": data["frozen_cents"],
            },
            "earnings": {
                "pending_cents": earnings["pending_cents"],
                "available_cents": earnings["withdrawable_cents"],
                "debt_cents": earnings["debt_cents"],
                "withdrawing_cents": earnings.get("withdrawing_cents", 0),
            },
            "seller": {
                "onboarded": bool(seller.get("account_id")),
                "eligible": bool(seller.get("eligible")),
                "country": seller.get("country"),
            },
            "payout": {"minimum_net_cents": 50},
            "funding_lots": [
                {
                    "id": lot["funding_id"],
                    "refundable_cents": 0 if lot["frozen"] else lot["unused_cents"],
                }
                for lot in data.get("funding_lots", [])
            ],
            "recent_withdrawals": [_withdrawal(item) for item in withdrawals],
        }
    except UndefinedTableError:
        if not _enabled():
            return {
                "enabled": False,
                "managed_balances": False,
                "currency": "USD",
                "readiness": await _service().readiness(viewer_user_id=user_id),
            }
        raise HTTPException(
            503, detail={"code": "scope_commerce_schema_unavailable"}, headers=NO_STORE
        ) from None
    except Exception as error:
        raise _error(error) from None


@router.get("/tariffs")
async def tariff(scope_handle: str, machine_scope: str, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        result = await _service().get_tariff(
            owner_user_id=user_id, scope_handle=scope_handle, machine_scope=machine_scope
        )
        return {"tariff": _snake(result) if result else None}
    except Exception as error:
        raise _error(error) from None


@router.post("/tariffs")
async def set_tariff(body: TariffBody, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        await validate_tariff_scope(user_id, body.scope_handle, body.machine_scope)
        return _snake(
            await _service().set_tariff(
                owner_user_id=user_id,
                scope_handle=body.scope_handle,
                machine_scope=body.machine_scope,
                price_cents=body.price_cents,
                base_duration_seconds=body.base_duration_seconds,
                idempotency_key=str(body.idempotency_key),
            )
        )
    except Exception as error:
        raise _error(error) from None


@router.post("/requests/{request_id}/approve")
async def approve(request_id: str, body: ApprovalBody, response: Response, token: Owner):
    from hushh_mcp.consent.paid_admission import approve_paid_request

    response.headers.update(NO_STORE)
    try:
        result = await approve_paid_request(
            owner_user_id=token["user_id"],
            request_id=request_id,
            duration_seconds=body.duration_seconds,
            idempotency_key=str(body.idempotency_key),
        )
        if result is None:
            raise HTTPException(
                409, detail={"code": "use_existing_free_consent_flow"}, headers=NO_STORE
            )
        return _snake(result)
    except HTTPException:
        raise
    except Exception as error:
        raise _error(error) from None


@router.post("/quotes")
async def quote(body: QuoteBody, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        binding = await resolve_commerce_request(body.request_id, user_id, require_payer=True)
        row = await _service().get_quote_by_request(body.request_id)
        if not row:
            raise HTTPException(409, detail={"code": "owner_approval_required"}, headers=NO_STORE)
        data = _quote(row)
        if (
            data["duration_seconds"] != body.duration_seconds
            or data["buyer_app_id"] != binding["buyer_app_id"]
            or data["recipient_key_fingerprint"] != binding["recipient_key_fingerprint"]
        ):
            raise HTTPException(409, detail={"code": "quote_binding_changed"}, headers=NO_STORE)
        return data
    except HTTPException:
        raise
    except Exception as error:
        raise _error(error) from None


@router.post("/purchases")
async def purchase(body: PurchaseBody, response: Response, user_id: Payer):
    from hushh_mcp.consent.paid_admission import record_paid_funded

    response.headers.update(NO_STORE)
    if body.confirmed is not True:
        raise HTTPException(422, detail={"code": "human_confirmation_required"}, headers=NO_STORE)
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT request_id FROM scope_commerce_quotes WHERE quote_id=$1 AND payer_user_id=$2",
                body.quote_id,
                user_id,
            )
        if not row:
            raise HTTPException(404, detail={"code": "quote_unavailable"}, headers=NO_STORE)
        await resolve_commerce_request(str(row["request_id"]), user_id, require_payer=True)
        return _purchase(
            await _service().reserve_purchase(
                payer_user_id=user_id,
                quote_id=str(body.quote_id),
                idempotency_key=str(body.idempotency_key),
                on_reserved=record_paid_funded,
            )
        )
    except HTTPException:
        raise
    except Exception as error:
        raise _error(error) from None


@router.get("/purchases/{purchase_id}")
async def purchase_status(purchase_id: UUID, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        service = _service()
        purchase = await service.get_purchase(
            purchase_id=str(purchase_id),
            viewer_user_id=user_id,
        )
        return _purchase(
            await service.access_state(
                purchase_id=str(purchase_id),
                buyer_app_id=purchase["buyerAppId"],
            )
        )
    except Exception as error:
        raise _error(error) from None


@router.post("/purchases/{purchase_id}/revoke")
async def revoke(purchase_id: UUID, body: OperationBody, response: Response, token: Owner):
    from hushh_mcp.consent.paid_admission import end_paid_purchase

    response.headers.update(NO_STORE)
    try:
        return _purchase(await end_paid_purchase(token["user_id"], str(purchase_id), as_owner=True))
    except Exception as error:
        raise _error(error) from None


@router.post("/purchases/{purchase_id}/cancel")
async def cancel(purchase_id: UUID, body: OperationBody, response: Response, user_id: Payer):
    from hushh_mcp.consent.paid_admission import end_paid_purchase

    response.headers.update(NO_STORE)
    try:
        return _purchase(await end_paid_purchase(user_id, str(purchase_id), as_owner=False))
    except Exception as error:
        raise _error(error) from None


@router.post("/funding/checkout")
async def checkout(body: FundingBody, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        result = _snake(
            await _provider().funding_checkout(
                payer_user_id=user_id,
                buyer_app_id="shared",
                amount_cents=body.amount_cents,
                operation_id=str(body.idempotency_key),
            )
        )
        return {"url": result["checkout_url"], "funding_id": result["funding_id"]}
    except Exception as error:
        raise _error(error) from None


@router.post("/onboarding")
async def onboarding(body: OnboardingBody, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        result = _snake(
            await _provider().onboarding(
                user_id=user_id,
                country=body.country,
                operation_id=str(body.idempotency_key),
            )
        )
        return {"url": result["onboarding_url"]}
    except Exception as error:
        raise _error(error) from None


def _preview(value: dict, *, refund_amount: int | None = None) -> dict:
    data = _snake(value)
    amount = (
        refund_amount
        if refund_amount is not None
        else int(data.get("gross_micro_usd", 0)) // 10_000
    )
    fee = 0 if refund_amount is not None else (int(data.get("fee_micro_usd", 0)) + 9_999) // 10_000
    result = {
        "amount_cents": amount,
        "fee_cents": fee,
        "net_cents": refund_amount if refund_amount is not None else int(data.get("net_cents", 0)),
        "minimum_net_cents": int(data.get("minimum_net_cents", 50)),
        "blocked_reason": data.get("block_reason") or data.get("blocked_reason"),
        "fee_configuration_ref": data.get("fee_configuration_ref"),
    }
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
    return {**result, "preview_token": hashlib.sha256(encoded).hexdigest()}


@router.get("/withdrawals/preview")
async def withdrawal_preview(response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        return _preview(await _provider().preview_withdrawal(user_id=user_id))
    except Exception as error:
        raise _error(error) from None


@router.post("/withdrawals")
async def withdraw(body: WithdrawalBody, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        preview = _preview(await _provider().preview_withdrawal(user_id=user_id))
        if preview["preview_token"] != body.preview_token or preview.get("blocked_reason"):
            raise HTTPException(
                409, detail={"code": "review_current_payout_terms"}, headers=NO_STORE
            )
        return _snake(
            await _provider().request_withdrawal(
                user_id=user_id,
                operation_id=str(body.idempotency_key),
                expected_net_cents=preview["net_cents"],
                expected_fee_micro_usd=preview["fee_cents"] * 10_000,
                expected_fee_configuration_ref=preview.get("fee_configuration_ref"),
            )
        )
    except HTTPException:
        raise
    except Exception as error:
        raise _error(error) from None


@router.post("/funding/{funding_id}/refund-preview")
async def refund_preview(
    funding_id: UUID, body: RefundPreviewBody, response: Response, user_id: Payer
):
    response.headers.update(NO_STORE)
    try:
        return _preview(
            await _provider().preview_source_refund(
                payer_user_id=user_id,
                funding_id=str(funding_id),
                amount_cents=body.amount_cents,
            ),
            refund_amount=body.amount_cents,
        )
    except Exception as error:
        raise _error(error) from None


@router.post("/funding/{funding_id}/refund")
async def refund(funding_id: UUID, body: RefundBody, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        preview = _preview(
            await _provider().preview_source_refund(
                payer_user_id=user_id,
                funding_id=str(funding_id),
                amount_cents=body.amount_cents,
            ),
            refund_amount=body.amount_cents,
        )
        if preview["preview_token"] != body.preview_token or preview.get("blocked_reason"):
            raise HTTPException(
                409, detail={"code": "review_current_refund_terms"}, headers=NO_STORE
            )
        return _snake(
            await _provider().refund_unused_funding(
                payer_user_id=user_id,
                buyer_app_id="shared",
                funding_id=str(funding_id),
                amount_cents=body.amount_cents,
                operation_id=str(body.idempotency_key),
            )
        )
    except HTTPException:
        raise
    except Exception as error:
        raise _error(error) from None


@webhook_router.post("/webhook")
async def webhook(request: Request, signature: str | None = Header(None, alias="Stripe-Signature")):
    payload = await request.body()
    if len(payload) > 128_000:
        raise HTTPException(413, detail="Payment event is too large.", headers=NO_STORE)
    try:
        await _provider().process_webhook(payload=payload, signature=signature)
    except Exception as error:
        raise _error(error) from None
    return {"received": True}


router.include_router(read_router)
router.include_router(owner_export_router)
