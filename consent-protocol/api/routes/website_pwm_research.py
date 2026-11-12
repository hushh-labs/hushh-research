"""Authenticated UAT transport for the website's bounded PWM work."""

import os
from datetime import datetime
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.id_token import fetch_id_token
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.routes.pwm_notification_drain import NO_STORE, verify_token
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.website_pwm_research import (
    WebsiteResearchGrant,
    run_website_research_slice,
)

router = APIRouter()


class WorkReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uid: str = Field(min_length=1, max_length=128)
    job_id: UUID
    lease: UUID


@router.post("/api/internal/website-pwm/run")
async def run_website_pwm(body: WorkReference, request: Request):
    audience = os.getenv("WEBSITE_PWM_WORKER_AUDIENCE")
    caller = os.getenv("WEBSITE_PWM_WORKER_IDENTITY")
    callback = os.getenv("WEBSITE_PWM_GRANT_URL")
    if (
        get_app_runtime_settings().environment != "uat"
        or not audience
        or not caller
        or not callback
        or not callback.startswith("https://")
    ):
        raise HTTPException(404, "Website PWM is unavailable", headers=NO_STORE)
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer ") or not 0 < len(authorization[7:]) <= 8192:
        raise HTTPException(403, "Worker authentication required", headers=NO_STORE)
    try:
        claims = await run_in_threadpool(verify_token, authorization[7:], audience)
    except Exception:
        raise HTTPException(403, "Worker authentication required", headers=NO_STORE) from None
    if claims.get("email") != caller or claims.get("email_verified") is not True:
        raise HTTPException(403, "Worker authentication required", headers=NO_STORE)

    token = await run_in_threadpool(fetch_id_token, GoogleRequest(), callback)
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:

        async def grant_request(action: str, **payload):
            response = await client.post(
                callback,
                headers={"Authorization": f"Bearer {token}"},
                json={**body.model_dump(mode="json"), "action": action, **payload},
            )
            if response.status_code in (403, 404, 409):
                raise PermissionError("Website research grant is no longer active")
            response.raise_for_status()
            return response.json()

        def grant_from(value):
            return WebsiteResearchGrant(
                owner_id=body.uid,
                job_id=str(body.job_id),
                consent_version=value["consent_version"],
                expires_at=datetime.fromisoformat(value["expires_at"]),
            )

        async def read_active_grant():
            return grant_from(await grant_request("check"))

        async def reserve(slots):
            await grant_request("reserve", slots=slots)

        async def checkpoint(work):
            await grant_request("checkpoint", checkpoint=work)

        try:
            initial = await grant_request("load")
            result = await run_website_research_slice(
                grant_from(initial),
                read_active_grant=read_active_grant,
                reserve_attempts=reserve,
                save_checkpoint=checkpoint,
                attempts_used=tuple(initial["attempts_used"]),
                checkpoint=initial.get("checkpoint"),
            )
        except PermissionError:
            raise HTTPException(
                409, "Website research authority changed", headers=NO_STORE
            ) from None
    return JSONResponse(result, headers=NO_STORE)
