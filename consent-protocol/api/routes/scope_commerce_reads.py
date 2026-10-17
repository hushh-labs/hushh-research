"""Authenticated read projections for commerce requests and activity."""

from typing import Any, Literal

from fastapi import APIRouter, Query, Response

from api.routes.scope_commerce_contracts import (
    NO_STORE,
    Payer,
    _error,
    _purchase,
    _quote,
    _service,
    _snake,
)
from db.connection import get_pool
from hushh_mcp.services.scope_commerce.activity import scope_label
from hushh_mcp.services.scope_commerce_requests import resolve_commerce_request

router = APIRouter(tags=["scope-commerce"])


async def _request_state(request_id: str, user_id: str) -> dict:
    service = _service()
    pool = await get_pool()
    async with pool.acquire() as conn:
        financial_schema = await conn.fetchval(
            "SELECT to_regclass('scope_commerce_purchases') IS NOT NULL"
        )
        if not financial_schema:
            return await _legacy_free_request_state(conn, service, request_id, user_id)
        historical = await conn.fetchrow(
            """SELECT purchase_id,owner_user_id FROM scope_commerce_purchases
               WHERE request_id=$1 AND (owner_user_id=$2 OR payer_user_id=$2)""",
            request_id,
            user_id,
        )
    if historical:
        # Financial receipts remain readable after revocation/key rotation.
        # This grants no export authority and preserves the accepted quote.
        purchase = await service.get_purchase(
            purchase_id=str(historical["purchase_id"]), viewer_user_id=user_id
        )
        quote = _quote(await service.get_quote_by_request(request_id))
        state = await service.access_state(
            purchase_id=str(historical["purchase_id"]), buyer_app_id=quote["buyer_app_id"]
        )
        return {
            "request_id": request_id,
            "role": "owner" if historical["owner_user_id"] == user_id else "payer",
            "machine_scope": quote["machine_scope"],
            "scope_handle": quote["scope_handle"],
            "duration_seconds": quote["duration_seconds"],
            "purpose": quote["purpose"],
            "refresh_policy": quote["refresh_policy"],
            "purchase": _purchase({**purchase, **state}),
            "tariff": {
                "scope_handle": quote["scope_handle"],
                "machine_scope": quote["machine_scope"],
                "price_cents": quote["base_price_cents"],
                "base_duration_seconds": quote["base_duration_seconds"],
                "tariff_revision": quote["tariff_revision"],
            },
        }
    binding = await resolve_commerce_request(request_id, user_id)
    tariff = await service.get_tariff(
        owner_user_id=binding["owner_user_id"],
        scope_handle=binding["scope_handle"],
        machine_scope=binding["machine_scope"],
    )
    purchase = await service.lookup_by_request(request_id)
    mapped_purchase = _purchase(purchase) if purchase else None
    return {
        "request_id": request_id,
        "role": "owner" if user_id == binding["owner_user_id"] else "payer",
        "machine_scope": binding["machine_scope"],
        "scope_handle": binding["scope_handle"],
        "duration_seconds": mapped_purchase.get("duration_seconds", binding["duration_seconds"])
        if mapped_purchase
        else binding["duration_seconds"],
        "purpose": binding["purpose"],
        "refresh_policy": binding["refresh_policy"],
        "request_deadline": binding.get("request_deadline").isoformat()
        if binding.get("request_deadline")
        else None,
        "recipient_label": "Requester’s private agent"
        if binding["buyer_app_id"] == "agent_one"
        else "Registered application " + binding["buyer_app_id"],
        "tariff": _snake(tariff) if tariff else None,
        "purchase": mapped_purchase,
    }


async def _legacy_free_request_state(
    conn, service, request_id: str, user_id: str
) -> dict[str, Any]:
    from hushh_mcp.consent.paid_admission import is_paid_grant
    from hushh_mcp.services.scope_commerce.domain import CommerceError

    binding = await resolve_commerce_request(request_id, user_id, connection=conn)
    if is_paid_grant(binding["metadata"]) or binding["metadata"].get("commerce_quote_id"):
        raise CommerceError("commerce_schema_required")
    tariff = None
    if await conn.fetchval("SELECT to_regclass('scope_commerce_tariffs') IS NOT NULL"):
        tariff = await service.get_tariff(
            owner_user_id=binding["owner_user_id"],
            scope_handle=binding["scope_handle"],
            machine_scope=binding["machine_scope"],
            conn=conn,
        )
    if tariff and tariff["priceCents"] > 0:
        raise CommerceError("commerce_schema_required")
    return {
        "_commerce_schema_ready": False,
        "request_id": request_id,
        "role": "owner" if user_id == binding["owner_user_id"] else "payer",
        "machine_scope": binding["machine_scope"],
        "scope_handle": binding["scope_handle"],
        "duration_seconds": binding["duration_seconds"],
        "purpose": binding["purpose"],
        "refresh_policy": binding["refresh_policy"],
        "recipient_label": "Requester’s private agent"
        if binding["buyer_app_id"] == "agent_one"
        else "Registered application " + binding["buyer_app_id"],
        "tariff": _snake(tariff) if tariff else None,
        "purchase": None,
    }


@router.get("/activity")
async def activity(
    response: Response,
    user_id: Payer,
    view: Literal["purchases", "sales", "transactions"] = "transactions",
    cursor: str | None = Query(None, max_length=1024),
    limit: int = Query(25, ge=1, le=100),
):
    response.headers.update(NO_STORE)
    try:
        return await _service().activity(
            viewer_user_id=user_id, view=view, cursor=cursor, limit=limit
        )
    except Exception as error:
        raise _error(error) from None


@router.get("/requests/{request_id}")
async def request_state(request_id: str, response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        result = await _request_state(request_id, user_id)
        review = (
            await _service().request_review(request_id=request_id, viewer_user_id=user_id)
            if result.pop("_commerce_schema_ready", True)
            else {}
        )
        return {
            "scope_label": scope_label(result["machine_scope"]),
            "counterpart_label": "Requester" if result["role"] == "owner" else "Information owner",
            **result,
            **review,
        }
    except Exception as error:
        raise _error(error) from None


@router.get("/sandbox-readiness")
async def sandbox_readiness(
    response: Response, user_id: Payer, app_origin: str = Query(..., max_length=512)
):
    response.headers.update(NO_STORE)
    try:
        return await _service().sandbox_readiness(viewer_user_id=user_id, app_origin=app_origin)
    except Exception as error:
        raise _error(error) from None


@router.get("/readiness")
async def readiness(response: Response, user_id: Payer):
    response.headers.update(NO_STORE)
    try:
        return await _service().readiness(viewer_user_id=user_id)
    except Exception as error:
        raise _error(error) from None
