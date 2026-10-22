"""Finite OIDC-authenticated UAT wake for the durable PWM notification outbox."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from starlette.concurrency import run_in_threadpool

from hushh_mcp.managed_ai_config import load_pwm_policy
from hushh_mcp.runtime_settings import get_app_runtime_settings, one_profile_research_enabled
from hushh_mcp.services.world_model_notifications import world_model_notification_worker

router = APIRouter(prefix="/api/internal/pwm-notifications", tags=["internal-pwm"])
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


def verify_token(token, audience):
    transport = GoogleRequest()

    def bounded(*args, **kwargs):
        kwargs["timeout"] = 4
        return transport(*args, **kwargs)

    return id_token.verify_oauth2_token(token, bounded, audience)


async def require_scheduler(request: Request):
    if get_app_runtime_settings().environment != "uat" or not one_profile_research_enabled():
        raise HTTPException(404, "PWM notifications unavailable", headers=NO_STORE)
    config = load_pwm_policy()["notification_scheduler"]
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer ") or not 0 < len(authorization[7:]) <= 8192:
        raise HTTPException(401, "Unauthorized", headers=NO_STORE)
    try:
        claims = await asyncio.wait_for(
            run_in_threadpool(verify_token, authorization[7:], config["audience"]), 5
        )
    except TimeoutError:
        raise HTTPException(503, "Verification unavailable", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(401, "Unauthorized", headers=NO_STORE) from None
    if (
        claims.get("iss") not in {"https://accounts.google.com", "accounts.google.com"}
        or claims.get("aud") != config["audience"]
        or claims.get("email") != config["service_account"]
        or claims.get("email_verified") is not True
    ):
        raise HTTPException(401, "Unauthorized", headers=NO_STORE)


@router.post("/drain")
async def drain(request: Request, response: Response, _authorized=Depends(require_scheduler)):
    response.headers.update(NO_STORE)
    await world_model_notification_worker.drain()
    return {"ok": True}
