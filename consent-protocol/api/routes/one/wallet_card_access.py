"""Private manual-card access routes. No credential-bearing responses are cacheable."""

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
from pydantic import BaseModel, ConfigDict, Field

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
                            if size > 16384:
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
    duration_minutes: Literal[5, 10, 15] = Field(alias="durationMinutes")


async def owner_identity(
    uid: str = Depends(require_firebase_auth), consent: dict = Depends(require_vault_owner_token)
):
    if str(consent.get("user_id") or "") != uid:
        raise HTTPException(403, {"code": "WALLET_CARD_OWNER_MISMATCH"})
    return uid


def service():
    return WalletCardAccessService()


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
async def card_access(card_id: str, owner: str = Depends(owner_identity)):
    if len(card_id) > 64:
        raise HTTPException(422, {"code": "WALLET_CARD_REQUEST_INVALID"})
    return await run_in_threadpool(service().card_access, owner, card_id)


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
