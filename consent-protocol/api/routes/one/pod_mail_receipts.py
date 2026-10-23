"""Explicit owner-session receipt reads from one selected private mailbox."""

from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_commands import _admitted
from api.routes.one.pod_session import verified_session
from api.routes.one.pod_turn import _require_enabled
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from hushh_mcp.services.pod_mail_receipts import PodReceiptConnection, owner_receipt_service
from hushh_mcp.services.pod_session_authority import PodSessionRefused

router = APIRouter(prefix="/connectors/gmail/accounts", tags=["personal-agent"])
# One owner per pod. Serialize all mailbox scans under the same admitted owner
# budget; an account adapter must never open a hub DB advisory-lock session.
_SCANS = asyncio.Lock()


class ReceiptRead(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    credential_id: str = Field(
        pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
    )
    page: int = Field(default=1, ge=1, le=50)
    per_page: int = Field(default=6, ge=1, le=6)
    cursor: str | None = Field(default=None, max_length=16384)
    source_id: str | None = Field(default=None, max_length=1024)


async def _read_body(request: Request) -> ReceiptRead:
    raw = bytearray()
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 20000:
                    raise HTTPException(413, detail="receipt request too large")
        body = ReceiptRead.model_validate_json(bytes(raw))
    except ValueError:
        raise HTTPException(422, detail={"code": "GMAIL_RECEIPT_INVALID_RESPONSE"}) from None
    except TimeoutError:
        raise HTTPException(408, detail="receipt request timed out") from None
    return body


@router.post("/{account_id}/receipts/{operation}")
async def receipt_read(
    account_id: str,
    operation: Literal["scan", "detail"],
    request: Request,
    authorization: str | None = Header(default=None),
):
    from hushh_mcp.services.pod_mail_accounts import ACCOUNT_ID

    _require_enabled()
    initial, _ = verified_session(authorization, role="app", scope="pkm.read")
    try:
        await initial.require_held()
    except PodSessionRefused as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from None
    # The admission disconnect watcher also consumes ASGI receive. Finish the
    # bounded body read before it starts, while rejecting non-owners first.
    body = await _read_body(request)
    async with _admitted(authorization, request) as claims:
        if not ACCOUNT_ID.fullmatch(account_id):
            raise HTTPException(404, detail="not found")
        authority, _ = verified_session(authorization, role="app", scope="pkm.read")

        async def require_access():
            current, current_claims = verified_session(authorization, role="app", scope="pkm.read")
            if current is not authority or current_claims != claims:
                raise HTTPException(403, detail="owner session changed")
            await current.require_held()

        try:
            connection = PodReceiptConnection(claims["user_id"], account_id, body.credential_id)
            service, current = owner_receipt_service(connection, require_access)
            await current()
            async with asyncio.timeout(60), _SCANS:
                if operation == "scan":
                    result = await service._scan_page(
                        user_id=claims["user_id"],
                        consent_token="pod-owner-receipts",  # noqa: S106 -- invocation label, not a credential
                        require_access=current,
                        page=body.page,
                        per_page=body.per_page,
                        cursor=body.cursor,
                        expected_account=account_id,
                    )
                elif body.source_id:
                    result = await service.detail(
                        user_id=claims["user_id"],
                        source_id=body.source_id,
                        consent_token="pod-owner-receipts",  # noqa: S106 -- invocation label, not a credential
                        require_access=current,
                    )
                else:
                    raise HTTPException(422, detail={"code": "GMAIL_RECEIPT_INVALID_RESPONSE"})
            await current()
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except GmailApiError as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content={"code": exc.code},
                headers={"Cache-Control": "no-store"},
            )
