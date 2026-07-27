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

Subscriber endpoints (developer-principal auth; Bearer token):
    POST   /api/fabric/read                 -> present a grant handle, receive
                                               only the granted fields + a receipt
    POST   /api/fabric/requests             -> open a pairing request; returns a
                                               short code to show the person
    GET    /api/fabric/requests/{id}        -> poll; on approval the signed
                                               handle is returned exactly once

Owner handshake endpoints (Firebase auth):
    GET    /api/fabric/requests/code/{code} -> who is asking, for what, why
    POST   /api/fabric/requests/{id}/approve -> mint the grant (+ receipt)
    POST   /api/fabric/requests/{id}/deny    -> one-tap no
"""

import logging
from typing import Any, NoReturn

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.developer_auth import authenticate_developer_principal
from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from hushh_mcp.services.fabric_grant_service import FabricGrantError, get_fabric_grant_service
from hushh_mcp.services.fabric_receipts_service import get_fabric_receipts_service
from hushh_mcp.services.fabric_request_service import get_fabric_request_service
from hushh_mcp.services.pwm_service import get_pwm_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fabric", tags=["subscription-fabric"])

# Handle/grant authorization failures are collapsed to one generic denial for
# the subscriber so the /read response cannot be used as an oracle (forged vs.
# valid-but-wrong-subscriber vs. revoked vs. expired). The specific code is
# logged server-side for the owner's audit, never returned to the caller.
_READ_DENY_CODES = frozenset(
    {
        "FABRIC_HANDLE_INVALID",
        "FABRIC_HANDLE_EXPIRED",
        "FABRIC_SUBSCRIBER_MISMATCH",
        "FABRIC_GRANT_NOT_FOUND",
        "FABRIC_GRANT_REVOKED",
    }
)


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
@limiter.limit(RateLimits.FABRIC_GRANT_WRITE)
async def create_grant(
    request: Request,
    payload: CreateGrantRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    try:
        created: dict[str, Any] = await get_fabric_grant_service().create_grant(
            user_id=firebase_uid,
            subscriber_id=payload.subscriber_id,
            scopes=payload.scopes,
            purpose=payload.purpose,
            subscriber_label=payload.subscriber_label,
            ttl_ms=payload.ttl_ms,
            price_cents=payload.price_cents,
            currency=payload.currency,
        )
        return created
    except FabricGrantError as err:
        _raise(err)


@router.get("/grants")
@limiter.limit(RateLimits.FABRIC_OWNER_READ)
async def list_grants(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    grants = await get_fabric_grant_service().list_grants(firebase_uid)
    return {"grants": grants, "count": len(grants)}


@router.post("/grants/{grant_id}/revoke")
@limiter.limit(RateLimits.FABRIC_GRANT_WRITE)
async def revoke_grant(
    request: Request,
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
@limiter.limit(RateLimits.FABRIC_OWNER_READ)
async def list_receipts(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
    limit: int = 200,
) -> dict[str, Any]:
    receipts = await get_fabric_receipts_service().list_receipts(firebase_uid, limit=limit)
    return {"receipts": receipts, "count": len(receipts)}


@router.get("/receipts/verify")
@limiter.limit(RateLimits.FABRIC_OWNER_READ)
async def verify_receipts(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
    expected_head_seq: int | None = None,
    expected_head_hash: str | None = None,
) -> dict[str, Any]:
    # The owner's client may pin the last head it saw (trust-on-first-use) and
    # pass it back to detect tail-truncation / a wiped ledger, which a plain
    # prev_hash walk cannot see.
    verification: dict[str, Any] = await get_fabric_receipts_service().verify_chain(
        firebase_uid,
        expected_head_seq=expected_head_seq,
        expected_head_hash=expected_head_hash,
    )
    return verification


@router.post("/read")
@limiter.limit(RateLimits.FABRIC_READ)
async def subscriber_read(
    request: Request,
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
        # Collapse every handle/grant authz failure to one generic denial so the
        # response is not a signature/existence oracle; log the real reason for
        # the owner's audit trail only.
        if err.code in _READ_DENY_CODES:
            logger.info(
                "fabric.read_denied",
                extra={
                    "event_type": "fabric_read_denied",
                    "subscriber_id": principal.agent_id,
                    "reason_code": err.code,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "FABRIC_READ_DENIED", "message": "Read denied."},
            )
        _raise(err)


# ---------------------------------------------------------------------------
# The brand-initiated handshake (device-authorization-style pairing).
# The subscriber opens a request and shows a short code; the person's agent
# looks the code up, sees exactly who is asking for what and why, and approves
# or denies. Approval mints the grant; the subscriber claims the handle once.
# ---------------------------------------------------------------------------


class CreateRequestBody(BaseModel):
    scopes: list[str] = Field(min_length=1, max_length=64)
    purpose: str = Field(min_length=1, max_length=500)
    subscriber_label: str | None = Field(default=None, max_length=200)
    ttl_ms: int | None = Field(default=None, ge=1)
    price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, max_length=8)


class RespondRequestBody(BaseModel):
    pairing_code: str = Field(min_length=8, max_length=16)


@router.post("/requests")
@limiter.limit(RateLimits.FABRIC_GRANT_WRITE)
async def create_consent_request(
    request: Request,
    body: CreateRequestBody,
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
        created: dict[str, Any] = await get_fabric_request_service().create_request(
            subscriber_id=principal.agent_id,
            scopes=body.scopes,
            purpose=body.purpose,
            subscriber_label=body.subscriber_label or principal.display_name,
            ttl_ms=body.ttl_ms,
            price_cents=body.price_cents,
            currency=body.currency,
        )
        return created
    except FabricGrantError as err:
        _raise(err)


@router.get("/requests/code/{code}")
@limiter.limit(RateLimits.FABRIC_REQUEST_LOOKUP)
async def lookup_consent_request(
    request: Request,
    code: str,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """What is this code asking me to share? Sign-in required; no uid binding yet."""
    try:
        found: dict[str, Any] = await get_fabric_request_service().lookup_by_code(code)
        return found
    except FabricGrantError as err:
        _raise(err)


@router.post("/requests/{request_id}/approve")
@limiter.limit(RateLimits.FABRIC_GRANT_WRITE)
async def approve_consent_request(
    request: Request,
    request_id: str,
    body: RespondRequestBody,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    try:
        approved: dict[str, Any] = await get_fabric_request_service().approve(
            user_id=firebase_uid,
            request_id=request_id,
            pairing_code=body.pairing_code,
        )
        return approved
    except FabricGrantError as err:
        _raise(err)


@router.post("/requests/{request_id}/deny")
@limiter.limit(RateLimits.FABRIC_GRANT_WRITE)
async def deny_consent_request(
    request: Request,
    request_id: str,
    body: RespondRequestBody,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    try:
        denied: dict[str, Any] = await get_fabric_request_service().deny(
            user_id=firebase_uid,
            request_id=request_id,
            pairing_code=body.pairing_code,
        )
        return denied
    except FabricGrantError as err:
        _raise(err)


@router.get("/requests/{request_id}")
@limiter.limit(RateLimits.FABRIC_READ)
async def poll_consent_request(
    request: Request,
    request_id: str,
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
        polled: dict[str, Any] = await get_fabric_request_service().poll(
            subscriber_id=principal.agent_id,
            request_id=request_id,
        )
        return polled
    except FabricGrantError as err:
        _raise(err)
