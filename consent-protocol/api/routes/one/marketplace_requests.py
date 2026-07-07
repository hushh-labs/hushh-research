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


class RegisterRecipientKeyBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key_id: str | None = Field(default=None, alias="keyId", max_length=160)
    public_key_jwk: dict[str, Any] = Field(alias="publicKeyJwk")
    algorithm: str = Field(default="ECDH-P256-AES256-GCM", max_length=80)


class ApproveRequestBody(BaseModel):
    """Optional sealed delivery envelope posted with an approval. When present the
    seller has already encrypted the slice against the buyer's recipient key
    on-device, so only ciphertext reaches the server (blind relay)."""

    model_config = ConfigDict(populate_by_name=True)

    envelope: dict[str, Any] | None = None


class DeliverRequestBody(BaseModel):
    """Sealed delivery envelope for an already-approved request. Used by the
    seller's on-device delivery sweep to fulfil an approval that an agent (A2A or
    the marketplace chat) made without a browser to seal. Envelope is required —
    this endpoint exists only to deliver ciphertext."""

    model_config = ConfigDict(populate_by_name=True)

    envelope: dict[str, Any]


@router.post("/recipient-keys")
async def register_marketplace_recipient_key(
    body: RegisterRecipientKeyBody,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Publish this buyer's marketplace recipient public key (idempotent)."""
    if not body.public_key_jwk.get("kty"):
        raise HTTPException(status_code=422, detail="Recipient public key material is required")
    try:
        recipient = await _service().register_recipient_key(
            user_id=token_data["user_id"],
            public_key_jwk=body.public_key_jwk,
            key_id=body.key_id,
            algorithm=body.algorithm,
        )
        return {"recipientKey": recipient}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("marketplace.register_recipient_key_failed")
        raise HTTPException(status_code=500, detail="Could not register recipient key")


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
    role: str = Query(default="owner", pattern="^(owner|buyer)$"),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """List requests for the caller. `role=owner` (default) is the seller's inbox;
    `role=buyer` is the caller's own outgoing requests (their Received-data tab)."""
    try:
        user_id = token_data["user_id"]
        if role == "buyer":
            requests = await _service().list_buyer_requests(buyer_user_id=user_id, status=status)
        else:
            requests = await _service().list_requests(owner_user_id=user_id, status=status)
        return {"requests": requests}
    except Exception:
        logger.exception("marketplace.list_requests_failed")
        raise HTTPException(status_code=500, detail="Could not load requests")


@router.get("/requests/{request_id}/recipient-key")
async def get_request_recipient_key(
    request_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Owner-scoped: the buyer's active recipient key for one of the owner's
    requests, so the seller can seal a slice envelope for them at approve time."""
    try:
        result = await _service().get_request_recipient_key(
            owner_user_id=token_data["user_id"], request_id=request_id
        )
    except Exception:
        logger.exception("marketplace.get_request_recipient_key_failed")
        raise HTTPException(status_code=500, detail="Could not load the recipient key")
    if result is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return result


@router.get("/requests/{request_id}/delivery")
async def get_marketplace_delivery(
    request_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Buyer-scoped: the latest sealed envelope for one of the caller's requests.
    Ciphertext only — the buyer decrypts on-device with their IndexedDB key."""
    try:
        result = await _service().get_delivered_envelope(
            buyer_user_id=token_data["user_id"], request_id=request_id
        )
    except Exception:
        logger.exception("marketplace.get_delivery_failed")
        raise HTTPException(status_code=500, detail="Could not load the delivered slice")
    if result is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return result


@router.post("/requests/{request_id}/approve")
async def approve_marketplace_request(
    request_id: str = Path(..., min_length=1, max_length=128),
    body: ApproveRequestBody | None = None,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    envelope = body.envelope if body else None
    try:
        result: dict[str, Any] = await _service().approve_request(
            owner_user_id=token_data["user_id"],
            request_id=request_id,
            envelope=envelope,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Request not found or not pending")
    return result


@router.post("/requests/{request_id}/deliver")
async def deliver_marketplace_request(
    request_id: str = Path(..., min_length=1, max_length=128),
    body: DeliverRequestBody = ...,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Owner-scoped: attach a sealed slice envelope to an already-approved request
    (agent-approval fulfilment). Does not change status; only stores ciphertext."""
    try:
        result: dict[str, Any] = await _service().deliver_envelope(
            owner_user_id=token_data["user_id"],
            request_id=request_id,
            envelope=body.envelope,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Request not found or not awaiting delivery")
    return result


@router.post("/requests/{request_id}/revoke")
async def revoke_marketplace_request(
    request_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Owner-scoped: revoke a previously approved request (withdraw access +
    purge delivered ciphertext). Works for interactive and agent-approved grants."""
    result: dict[str, Any] = await _service().revoke_request(
        owner_user_id=token_data["user_id"], request_id=request_id
    )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail="Request not found or not revocable")
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
