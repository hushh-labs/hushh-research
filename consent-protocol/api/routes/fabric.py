# consent-protocol/api/routes/fabric.py
"""
Preference Subscription Fabric API routes (PCHP RFC-002).

Turns the Personal World Model (/api/pwm) from a private store into a
subscribable fabric: a person grants a subscriber scoped, dated, priced,
revocable read access to specific PWM fields, and every grant/read/revoke
writes a signed, hash-chained receipt.

Owner endpoints (Firebase auth; uid only from the verified token):
    POST   /api/fabric/grants               -> create a grant, return the handle
    GET    /api/fabric/grants               -> list my grants (no handles)
    POST   /api/fabric/grants/{id}/revoke   -> revoke a grant
    GET    /api/fabric/receipts             -> my hash-chained receipt ledger
    GET    /api/fabric/receipts/verify      -> verify my chain integrity

Subscriber endpoint (developer-principal auth; Bearer token):
    POST   /api/fabric/read                 -> present a grant handle, receive
                                               only the granted fields + a receipt
"""

import logging
from typing import Any, NoReturn

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.developer_auth import authenticate_developer_principal
from api.middleware import require_firebase_auth
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from hushh_mcp.services.fabric_grant_service import FabricGrantError, get_fabric_grant_service
from hushh_mcp.services.fabric_receipts_service import get_fabric_receipts_service
from hushh_mcp.services.pwm_service import get_pwm_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fabric", tags=["subscription-fabric"])


def require_subscriber_principal(request: Request) -> DeveloperPrincipal:
    """Authenticate the calling third-party subscriber (brand/agent).

    Reuses the developer-principal auth (static ``hdk_`` token or OAuth
    client-credentials); the subscriber identity is the principal's agent_id.
    """
    return authenticate_developer_principal(
        authorization=request.headers.get("authorization"),
        request=request,
    )


class CreateGrantRequest(BaseModel):
    subscriber_id: str = Field(min_length=1, max_length=200)
    scopes: list[str] = Field(min_length=1, max_length=64)
    purpose: str = Field(min_length=1, max_length=500)
    subscriber_label: str | None = Field(default=None, max_length=200)
    ttl_ms: int | None = Field(default=None, ge=1)
    price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, max_length=8)


class ReadRequest(BaseModel):
    handle: str = Field(min_length=8, max_length=4096)


def _raise(err: FabricGrantError) -> NoReturn:
    raise HTTPException(
        status_code=err.status_code, detail={"code": err.code, "message": err.message}
    )


@router.post("/grants")
async def create_grant(
    request: CreateGrantRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    try:
        created: dict[str, Any] = await get_fabric_grant_service().create_grant(
            user_id=firebase_uid,
            subscriber_id=request.subscriber_id,
            scopes=request.scopes,
            purpose=request.purpose,
            subscriber_label=request.subscriber_label,
            ttl_ms=request.ttl_ms,
            price_cents=request.price_cents,
            currency=request.currency,
        )
        return created
    except FabricGrantError as err:
        _raise(err)


@router.get("/grants")
async def list_grants(
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    grants = await get_fabric_grant_service().list_grants(firebase_uid)
    return {"grants": grants, "count": len(grants)}


@router.post("/grants/{grant_id}/revoke")
async def revoke_grant(
    grant_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    try:
        revoked: dict[str, Any] = await get_fabric_grant_service().revoke_grant(
            user_id=firebase_uid, grant_id=grant_id
        )
        return revoked
    except FabricGrantError as err:
        _raise(err)


@router.get("/receipts")
async def list_receipts(
    firebase_uid: str = Depends(require_firebase_auth),
    limit: int = 200,
) -> dict[str, Any]:
    receipts = await get_fabric_receipts_service().list_receipts(firebase_uid, limit=limit)
    return {"receipts": receipts, "count": len(receipts)}


@router.get("/receipts/verify")
async def verify_receipts(
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    verification: dict[str, Any] = await get_fabric_receipts_service().verify_chain(firebase_uid)
    return verification


@router.post("/read")
async def subscriber_read(
    body: ReadRequest = Body(...),
    principal: DeveloperPrincipal = Depends(require_subscriber_principal),
) -> dict[str, Any]:
    if not principal.agent_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FABRIC_SUBSCRIBER_UNIDENTIFIED",
                "message": "Subscriber has no agent id.",
            },
        )
    try:
        result: dict[str, Any] = await get_fabric_grant_service().read_for_subscriber(
            handle=body.handle,
            subscriber_id=principal.agent_id,
            pwm_doc_loader=get_pwm_service().get_document,
        )
        return result
    except FabricGrantError as err:
        _raise(err)
