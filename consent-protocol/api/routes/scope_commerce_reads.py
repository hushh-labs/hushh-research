"""Authenticated read projections for commerce requests and activity."""

import asyncio
import logging
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
from hushh_mcp.services.directory_identity_service import (
    DirectoryIdentityUnavailableError,
    active_directory_user_ids,
)
from hushh_mcp.services.requester_identity import label_from_identity_row
from hushh_mcp.services.scope_commerce.activity import scope_label
from hushh_mcp.services.scope_commerce_requests import (
    fetch_connected_counterpart_row,
    get_pool,
    inspect_request_financial_history,
    resolve_commerce_request,
)

router = APIRouter(tags=["scope-commerce"])
logger = logging.getLogger(__name__)


async def _connected_counterpart(viewer: str, counterpart: str | None, *, can_open: bool) -> dict:
    """Name and navigation only; destination consent still governs every export."""
    if not counterpart:
        return {}
    row = await fetch_connected_counterpart_row(
        viewer,
        counterpart,
        check_tables=True,
        pool_getter=get_pool,
    )
    if not row:
        return {}
    # Provider work must not hold the financial service's advisory lock or a DB lease.
    try:
        live = await asyncio.wait_for(
            asyncio.to_thread(
                active_directory_user_ids, [counterpart], use_cache=False, notify_connections=False
            ),
            timeout=10,
        )
    except (DirectoryIdentityUnavailableError, TimeoutError):
        logger.warning("scope_commerce.counterpart_identity_unavailable")
        return {"counterpart_person_ref": None}
    if counterpart not in live:
        return {"counterpart_person_ref": None}
    # Connection removal or local retirement may commit during the provider read.
    row = await fetch_connected_counterpart_row(
        viewer,
        counterpart,
        check_tables=False,
        pool_getter=get_pool,
    )
    if not row:
        return {"counterpart_person_ref": None}
    return {
        "counterpart_label": label_from_identity_row(
            row, allow_email_handle=False, fallback="Hussh member"
        ),
        "counterpart_person_ref": str(row["public_person_ref"]) if can_open else None,
    }


async def _request_state(request_id: str, user_id: str) -> dict:
    service = _service()
    historical, legacy_state = await inspect_request_financial_history(
        request_id,
        user_id,
        service=service,
        legacy_fallback=_legacy_free_request_state,
        pool_getter=get_pool,
    )
    if legacy_state is not None:
        return legacy_state
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
            "_counterpart_user_id": historical["payer_user_id"]
            if historical["owner_user_id"] == user_id
            else historical["owner_user_id"],
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
    deadline = binding.get("request_deadline")
    return {
        "_counterpart_user_id": binding["payer_user_id"]
        if binding["owner_user_id"] == user_id
        else binding["owner_user_id"],
        "request_id": request_id,
        "role": "owner" if user_id == binding["owner_user_id"] else "payer",
        "machine_scope": binding["machine_scope"],
        "scope_handle": binding["scope_handle"],
        "duration_seconds": mapped_purchase.get("duration_seconds", binding["duration_seconds"])
        if mapped_purchase
        else binding["duration_seconds"],
        "purpose": binding["purpose"],
        "refresh_policy": binding["refresh_policy"],
        "request_deadline": deadline.isoformat() if deadline else None,
        "recipient_label": "One"
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
        "_counterpart_user_id": binding["payer_user_id"]
        if binding["owner_user_id"] == user_id
        else binding["owner_user_id"],
        "_commerce_schema_ready": False,
        "request_id": request_id,
        "role": "owner" if user_id == binding["owner_user_id"] else "payer",
        "machine_scope": binding["machine_scope"],
        "scope_handle": binding["scope_handle"],
        "duration_seconds": binding["duration_seconds"],
        "purpose": binding["purpose"],
        "refresh_policy": binding["refresh_policy"],
        "recipient_label": "One"
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
        counterpart = await _connected_counterpart(
            user_id,
            result.pop("_counterpart_user_id", None),
            can_open=result["role"] == "payer"
            and (result.get("purchase") or {}).get("status") == "active",
        )
        return {
            "scope_label": scope_label(result["machine_scope"]),
            "counterpart_label": "Requester" if result["role"] == "owner" else "Information owner",
            **result,
            **review,
            **counterpart,
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
