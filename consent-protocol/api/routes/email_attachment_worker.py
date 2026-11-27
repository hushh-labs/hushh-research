"""Machine-only, in-memory parsing on the scanner-equipped UAT worker."""

import asyncio
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from api.routes.drive_work_drain import _verify_drive_work_drain_oidc_token
from hushh_mcp.services.drive_document_processor import ClamAvScanner, IsolatedDocumentParser
from hushh_mcp.services.email_oss.attachment_worker import (
    ATTACHMENT_MIMES,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_TEXT,
    WORKER_ORIGIN,
    WORKER_PATH,
    WORKER_PRINCIPAL,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError

router = APIRouter()
_NO_STORE = {"Cache-Control": "no-store"}


def _error(status: int, code: str) -> HTTPException:
    return HTTPException(status, detail={"code": code}, headers=_NO_STORE)


async def _authorize(request: Request) -> None:
    if os.getenv("ENVIRONMENT") != "uat":
        raise _error(404, "attachment_worker_disabled")
    authorization = request.headers.get("authorization", "")
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not 0 < len(token) <= 8192:
        raise _error(401, "attachment_worker_unauthorized")
    try:
        async with asyncio.timeout(3):
            claims = await run_in_threadpool(
                _verify_drive_work_drain_oidc_token, token, WORKER_ORIGIN
            )
    except TimeoutError:
        raise _error(503, "attachment_worker_unavailable") from None
    except Exception:
        raise _error(401, "attachment_worker_unauthorized") from None
    if (
        not isinstance(claims, dict)
        or claims.get("aud") != WORKER_ORIGIN
        or claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}
        or claims.get("email") != WORKER_PRINCIPAL
        or claims.get("email_verified") is not True
    ):
        raise _error(401, "attachment_worker_unauthorized")


async def _read_attachment(request: Request) -> bytes:
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise _error(415, "attachment_encoding_unsupported")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_ATTACHMENT_BYTES:
            raise _error(413, "attachment_too_large")
        body.extend(chunk)
    if not body:
        raise _error(400, "attachment_empty")
    return bytes(body)


@router.post(WORKER_PATH, include_in_schema=False)
async def parse_email_attachment(request: Request) -> JSONResponse:
    await _authorize(request)
    mime_type = request.headers.get("content-type", "")
    if mime_type not in ATTACHMENT_MIMES:
        raise _error(415, "attachment_type_unsupported")
    try:
        async with asyncio.timeout(10):
            content = await _read_attachment(request)
            await ClamAvScanner().scan(content)
            parsed = await IsolatedDocumentParser().parse(
                content=content, mime_type=mime_type, live=True
            )
    except TimeoutError:
        raise _error(504, "attachment_timeout") from None
    except ClientDisconnect:
        raise _error(400, "attachment_disconnected") from None
    except DriveReadError:
        raise _error(422, "attachment_unreadable") from None
    text = "\n\n".join(parsed.pages)
    return JSONResponse(
        {
            "pages": [text[:MAX_ATTACHMENT_TEXT]],
            "truncated": parsed.truncated or len(text) > MAX_ATTACHMENT_TEXT,
        },
        headers=_NO_STORE,
    )
