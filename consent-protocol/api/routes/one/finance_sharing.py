"""Private, bounded Finance object sharing. No plaintext financial request bodies."""

import asyncio
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.direct_messages_service import DirectMessagesError
from hushh_mcp.services.finance_sharing_contract import CreateFinanceShare, RefreshFinanceShare
from hushh_mcp.services.finance_sharing_service import FinanceSharingError, FinanceSharingService

logger = logging.getLogger(__name__)
PRIVATE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class PrivateFinanceRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private(request: Request):
            try:
                if request.method in {"POST", "PUT"}:
                    chunks, size = [], 0
                    async with asyncio.timeout(15):
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > 4_000_000:
                                raise HTTPException(413, {"code": "FINANCE_SHARE_TOO_LARGE"})
                            chunks.append(chunk)
                    request._body = b"".join(chunks)
                response = await handler(request)
                response.headers.update(PRIVATE)
                return response
            except RequestValidationError:
                return JSONResponse(
                    {"detail": {"code": "FINANCE_SHARE_INVALID"}}, status_code=422, headers=PRIVATE
                )
            except HTTPException as exc:
                return JSONResponse(
                    {"detail": exc.detail}, status_code=exc.status_code, headers=PRIVATE
                )
            except (FinanceSharingError, DirectMessagesError) as exc:
                return JSONResponse(
                    {"detail": {"code": exc.code}}, status_code=exc.status_code, headers=PRIVATE
                )
            except Exception as exc:
                logger.warning("finance_sharing.unavailable error=%s", type(exc).__name__)
                return JSONResponse(
                    {"detail": {"code": "FINANCE_SHARE_UNAVAILABLE"}},
                    status_code=503,
                    headers=PRIVATE,
                )

        return private


router = APIRouter(
    prefix="/api/one/finance/shares", tags=["Finance sharing"], route_class=PrivateFinanceRoute
)


async def identity(
    uid: str = Depends(require_firebase_auth), consent: dict = Depends(require_vault_owner_token)
):
    if str(consent.get("user_id") or "") != uid:
        raise HTTPException(403, {"code": "FINANCE_SHARE_OWNER_MISMATCH"})
    return uid


@router.post("")
async def create(body: CreateFinanceShare, owner: str = Depends(identity)):
    return await run_in_threadpool(FinanceSharingService().create, owner, body)


@router.get("")
async def history(
    direction: Literal["outgoing", "received"] = "outgoing",
    cursor: UUID | None = Query(default=None),
    viewer: str = Depends(identity),
):
    from functools import partial

    return await run_in_threadpool(
        partial(
            FinanceSharingService().history,
            viewer,
            direction=direction,
            cursor=str(cursor) if cursor else None,
        )
    )


@router.get("/{grant_id}")
async def view(grant_id: UUID, viewer: str = Depends(identity)):
    return await run_in_threadpool(FinanceSharingService().view, viewer, str(grant_id))


@router.put("/{grant_id}")
async def refresh(grant_id: UUID, body: RefreshFinanceShare, owner: str = Depends(identity)):
    return await run_in_threadpool(FinanceSharingService().refresh, owner, str(grant_id), body)


@router.delete("/{grant_id}")
async def stop(grant_id: UUID, owner: str = Depends(identity)):
    return await run_in_threadpool(FinanceSharingService().revoke, owner, str(grant_id))
