"""Pinned Cloud Scheduler wake-up for durable alerts, including task reminders."""

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token

from api.utils.private_no_store import PRIVATE_NO_STORE_HEADERS
from hushh_mcp.services.system_push_delivery import dispatch_system_pushes

router = APIRouter(prefix="/api/internal/system-push", tags=["Internal system push"])


def scheduler_identity() -> tuple[str, str]:
    environment = os.getenv("ENVIRONMENT", "").lower()
    if environment == "production":
        return "https://api.hushh.ai", "system-push-drain@hushh-pda.iam.gserviceaccount.com"
    if environment in {"uat", "test", "local", "development"}:
        return "https://api.uat.hushh.ai", "system-push-drain@hushh-pda-uat.iam.gserviceaccount.com"
    raise HTTPException(404, "System push drain unavailable")


def verify_scheduler_token(token: str, audience: str) -> dict:
    transport = GoogleRequest()

    def bounded(*args, **kwargs):
        return transport(*args, **{**kwargs, "timeout": 4})

    return dict(id_token.verify_oauth2_token(token, bounded, audience))


async def require_scheduler(request: Request) -> None:
    audience, account = scheduler_identity()
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer ") or not 0 < len(header[7:]) <= 8192:
        raise HTTPException(401, "Unauthorized", headers=PRIVATE_NO_STORE_HEADERS)
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(verify_scheduler_token, header[7:], audience), 5
        )
    except TimeoutError:
        raise HTTPException(
            503, "Verification unavailable", headers=PRIVATE_NO_STORE_HEADERS
        ) from None
    except Exception:
        raise HTTPException(401, "Unauthorized", headers=PRIVATE_NO_STORE_HEADERS) from None
    if (
        claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}
        or claims.get("aud") != audience
        or claims.get("email") != account
        or claims.get("email_verified") is not True
    ):
        raise HTTPException(401, "Unauthorized", headers=PRIVATE_NO_STORE_HEADERS)


@router.post("/drain")
async def drain(_authorized: None = Depends(require_scheduler)) -> JSONResponse:
    try:
        processed = await run_in_threadpool(dispatch_system_pushes)
    except Exception:
        raise HTTPException(
            503, "Notification delivery unavailable", headers=PRIVATE_NO_STORE_HEADERS
        ) from None
    return JSONResponse({"processed": processed}, headers=PRIVATE_NO_STORE_HEADERS)
