"""Private eligible-card access routes. Protected responses are never cacheable."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.utils.firebase_admin import get_firebase_auth_app
from api.utils.firebase_auth import refuse_foreign_review_mint
from hushh_mcp.services.direct_messages_service import DirectMessagesError
from hushh_mcp.services.wallet_card_access_service import (
    WalletCardAccessError,
    WalletCardAccessService,
)

logger = logging.getLogger(__name__)
HEADERS = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class PrivateWalletAccessRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private(request: Request):
            try:
                if request.method == "POST":
                    chunks, size = [], 0
                    async with asyncio.timeout(15):
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > (98304 if request.url.path.endswith("/grants") else 16384):
                                raise HTTPException(413, {"code": "WALLET_CARD_REQUEST_TOO_LARGE"})
                            chunks.append(chunk)
                    request._body = b"".join(chunks)
                response = await handler(request)
                response.headers.update(HEADERS)
                return response
            except RequestValidationError:
                return JSONResponse(
                    {"detail": {"code": "WALLET_CARD_REQUEST_INVALID"}},
                    status_code=422,
                    headers=HEADERS,
                )
            except HTTPException as exc:
                return JSONResponse(
                    {"detail": exc.detail}, status_code=exc.status_code, headers=HEADERS
                )
            except (WalletCardAccessError, DirectMessagesError) as exc:
                return JSONResponse(
                    {"detail": {"code": exc.code}}, status_code=exc.status_code, headers=HEADERS
                )
            except Exception as exc:
                logger.warning("wallet_card_access.unavailable error=%s", type(exc).__name__)
                return JSONResponse(
                    {"detail": {"code": "WALLET_CARD_ACCESS_UNAVAILABLE"}},
                    status_code=503,
                    headers=HEADERS,
                )

        return private


router = APIRouter(
    prefix="/api/one/wallet/card-access",
    tags=["Wallet Card Access"],
    route_class=PrivateWalletAccessRoute,
)


class RegistrationBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    request_id: UUID = Field(alias="requestId")


class ShareBody(RegistrationBody):
    recipient_person_refs: list[UUID] = Field(
        alias="recipientPersonRefs", min_length=1, max_length=20
    )
    duration_minutes: Literal[5, 10, 15, 60, 120] = Field(alias="durationMinutes")
    encrypted_cards: dict[UUID, str] | None = Field(
        default=None, alias="encryptedCards", max_length=20
    )


class SharingActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: Literal[
        "SHARE_CREATED",
        "SHARE_DELIVERED",
        "SHARE_OPENED",
        "SHARE_EXPIRED",
        "SHARE_REVOKED",
        "ACCESS_VERIFIED",
        "ACCESS_DENIED",
    ]
    at: str
    actor: Literal["owner", "recipient"]
    outcome: Literal["recorded", "denied"]


class SharingHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    cardId: str
    cardType: Literal["payment", "profile"]
    source: Literal["owner_manual", "owner_profile"]
    displayLabel: str
    last4: str | None
    senderName: str
    recipientName: str
    senderPersonRef: UUID | None
    recipientPersonRef: UUID | None
    createdAt: str
    expiresAt: str
    durationMinutes: Literal[5, 10, 15, 60, 120]
    trustedCircle: bool | None
    method: Literal["trusted_circle", "standard_connection", "legacy_unspecified"]
    verificationMethod: Literal["identity_reauthentication", "trusted_circle", "legacy_unspecified"]
    verifiedAt: str | None
    status: Literal["active", "expired", "revoked"]
    revokedAt: str | None
    lastAccessedAt: str | None
    permittedFields: list[str]
    activity: list[SharingActivity]


class SharingHistory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recipientCount: int = Field(default=0, ge=0)
    items: list[SharingHistoryItem]
    hasMore: bool
    nextCursor: str | None
    serverNow: str


class CardNetworkBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    iin_prefix: str = Field(alias="iinPrefix", pattern=r"^[0-9]{6}$", min_length=6, max_length=6)
    pan_length: StrictInt = Field(alias="panLength", ge=13, le=19)
    selected_network: str | None = Field(default=None, alias="selectedNetwork", max_length=32)


async def owner_identity(
    uid: str = Depends(require_firebase_auth), consent: dict = Depends(require_vault_owner_token)
):
    if str(consent.get("user_id") or "") != uid:
        raise HTTPException(403, {"code": "WALLET_CARD_OWNER_MISMATCH"})
    return uid


def service():
    return WalletCardAccessService()


@router.get("/networks")
async def card_networks(owner: str = Depends(owner_identity)):
    from hushh_mcp.services.wallet_card_validation import NETWORK_ORDER

    return {"networks": list(NETWORK_ORDER)}


@router.post("/networks/resolve")
async def resolve_card_network(body: CardNetworkBody, owner: str = Depends(owner_identity)):
    from hushh_mcp.services.wallet_card_validation import classify_card_network

    try:
        return classify_card_network(body.iin_prefix, body.pan_length, body.selected_network)
    except ValueError:
        raise HTTPException(422, {"code": "WALLET_CARD_REQUEST_INVALID"}) from None


@router.post("/registrations")
async def reserve(body: RegistrationBody, owner: str = Depends(owner_identity)):
    try:
        return await run_in_threadpool(service().reserve, owner, str(body.request_id))
    except Exception as exc:
        logger.warning("wallet_card_access.registration_unavailable error=%s", type(exc).__name__)
        return {"enabled": False, "cardId": None}


@router.get("/connections")
async def connections(
    query: str = Query(default="", max_length=100), owner: str = Depends(owner_identity)
):
    return await run_in_threadpool(service().connections, owner, query)


@router.get("/cards/{card_id}")
async def card_access(
    card_id: str,
    cursor: UUID | None = Query(default=None),
    owner: str = Depends(owner_identity),
):
    if len(card_id) > 64:
        raise HTTPException(422, {"code": "WALLET_CARD_REQUEST_INVALID"})
    return await run_in_threadpool(
        service().card_access, owner, card_id, str(cursor) if cursor else None
    )


@router.get("/profile")
async def profile_access(owner: str = Depends(owner_identity)):
    return await run_in_threadpool(service().profile_access, owner)


@router.get("/history", response_model=SharingHistory)
async def sharing_history(
    direction: Literal["outgoing", "received"] = "outgoing",
    card_type: Literal["payment", "profile"] | None = Query(default=None, alias="cardType"),
    cursor: str | None = Query(default=None, max_length=60),
    limit: int = Query(default=20, ge=1, le=100),
    owner: str = Depends(owner_identity),
):
    return await run_in_threadpool(
        service().history,
        owner,
        direction=direction,
        card_type=card_type,
        cursor=cursor,
        limit=limit,
    )


@router.get("/history/{grant_id}", response_model=SharingHistoryItem)
async def sharing_details(grant_id: UUID, viewer: str = Depends(owner_identity)):
    # One participant-scoped ledger, independent of the card's current eligibility.
    try:
        result = await run_in_threadpool(service().history, viewer, grant_id=str(grant_id))
    except WalletCardAccessError as exc:
        if exc.status_code != 404:
            raise
        result = await run_in_threadpool(
            service().history, viewer, direction="received", grant_id=str(grant_id)
        )
    return result["items"][0]


@router.post("/cards/{card_id}/grants")
async def create_grants(card_id: str, body: ShareBody, owner: str = Depends(owner_identity)):
    if len(card_id) > 64:
        raise HTTPException(422, {"code": "WALLET_CARD_REQUEST_INVALID"})
    return await run_in_threadpool(
        service().create_grants,
        owner,
        card_id,
        str(body.request_id),
        [str(v) for v in body.recipient_person_refs],
        body.duration_minutes,
        **(
            {"encrypted_cards": {str(k): v for k, v in body.encrypted_cards.items()}}
            if body.encrypted_cards is not None
            else {}
        ),
    )


@router.delete("/grants/{grant_id}")
async def revoke(grant_id: UUID, owner: str = Depends(owner_identity)):
    return await run_in_threadpool(service().revoke, owner, str(grant_id))


@router.get("/grants/{grant_id}")
async def view(grant_id: UUID, recipient: str = Depends(require_firebase_auth)):
    return await run_in_threadpool(service().view_grant, recipient, str(grant_id))


def verified_reauthentication_time(authorization: str | None, uid: str):
    from firebase_admin import auth

    if not authorization or not authorization.startswith("Bearer ") or len(authorization) > 20000:
        raise HTTPException(401, {"code": "WALLET_CARD_VERIFICATION_REQUIRED"})
    try:
        claims = auth.verify_id_token(
            authorization[7:].strip(), app=get_firebase_auth_app(), check_revoked=True
        )
    except Exception:
        raise HTTPException(401, {"code": "WALLET_CARD_VERIFICATION_REQUIRED"}) from None
    provider = (claims.get("firebase") or {}).get("sign_in_provider")
    if (
        refuse_foreign_review_mint(claims)
        or str(claims.get("uid") or claims.get("sub") or "") != uid
        or provider not in {"google.com", "apple.com"}
    ):
        raise HTTPException(401, {"code": "WALLET_CARD_VERIFICATION_REQUIRED"})
    return claims.get("auth_time")


@router.post("/grants/{grant_id}/verify")
async def verify(
    grant_id: UUID,
    recipient: str = Depends(require_firebase_auth),
    authorization: str | None = Header(default=None),
):
    auth_time = await run_in_threadpool(verified_reauthentication_time, authorization, recipient)
    return await run_in_threadpool(
        service().view_grant, recipient, str(grant_id), verified_auth_time=auth_time
    )
