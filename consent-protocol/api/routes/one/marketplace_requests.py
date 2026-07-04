"""Information Marketplace access-request routes (durable, owner-scoped).

Turns marketplace access requests into real records (migration 076) so the owner
has a durable inbox and approve/deny is server-side — usable from the direct
marketplace chat, the marketplace page, and Agent One over A2A.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/marketplace", tags=["One Information Marketplace Requests"])


def _service() -> MarketplaceRequestService:
    return MarketplaceRequestService()


class CreateRequestBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    slice_name: str = Field(alias="sliceName", max_length=200)
    domain: str = Field(max_length=128)
    scope_handle: str | None = Field(default=None, alias="scopeHandle", max_length=256)
    buyer_label: str | None = Field(default=None, alias="buyerLabel", max_length=200)
    price_cents: int = Field(default=0, alias="priceCents", ge=0, le=100_000_000)
    currency: str = Field(default="USD", max_length=8)
    duration_days: int = Field(default=30, alias="durationDays", ge=1, le=3650)
    message: str | None = Field(default=None, max_length=2000)


@router.post("/requests")
async def create_marketplace_request(
    body: CreateRequestBody,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        request = await _service().create_request(
            owner_user_id=token_data["user_id"],
            slice_label=body.slice_name,
            domain=body.domain,
            scope_handle=body.scope_handle,
            buyer_label=body.buyer_label,
            price_cents=body.price_cents,
            currency=body.currency,
            duration_days=body.duration_days,
            message=body.message,
        )
        return {"request": request}
    except Exception:
        logger.exception("marketplace.create_request_failed")
        raise HTTPException(status_code=500, detail="Could not file the request")


@router.get("/requests")
async def list_marketplace_requests(
    status: str | None = Query(default=None, max_length=24),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        requests = await _service().list_requests(
            owner_user_id=token_data["user_id"], status=status
        )
        return {"requests": requests}
    except Exception:
        logger.exception("marketplace.list_requests_failed")
        raise HTTPException(status_code=500, detail="Could not load requests")


@router.post("/requests/{request_id}/approve")
async def approve_marketplace_request(
    request_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    result: dict[str, Any] = await _service().approve_request(
        owner_user_id=token_data["user_id"], request_id=request_id
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Request not found or not pending")
    return result


@router.post("/requests/{request_id}/deny")
async def deny_marketplace_request(
    request_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    result: dict[str, Any] = await _service().deny_request(
        owner_user_id=token_data["user_id"], request_id=request_id
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Request not found or not pending")
    return result
