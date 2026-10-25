"""Explicit, environment-local enrollment after qualified account cleanup.

These endpoints accept external identity proof for this purpose only. They do
not bypass application admission or provide access to a retired owner's vault.
"""

from __future__ import annotations

import os
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from starlette.concurrency import run_in_threadpool

from api.utils.firebase_auth import verify_account_registration_bearer
from hushh_mcp.services.account_generation_service import (
    AccountGenerationRefused,
    AccountGenerationService,
)

router = APIRouter()


def _enabled() -> None:
    # Activation follows schema, all generation consumers, and acceptance.
    if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() != "true":
        raise HTTPException(status_code=404, detail="Account recovery is not available")


class StartFreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    previous_generation: StrictInt = Field(ge=0, le=1_000_000)
    cleanup_operation: UUID
    enrollment_operation: UUID
    accepted_review_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: StrictBool


@router.get("/registration-status")
async def account_registration_status(response: Response, authorization: str | None = Header(None)):
    _enabled()
    response.headers["Cache-Control"] = "private, no-store"
    claims = await run_in_threadpool(verify_account_registration_bearer, authorization)
    try:
        return await run_in_threadpool(AccountGenerationService.registration_status, claims)
    except AccountGenerationRefused:
        raise HTTPException(
            status_code=409,
            detail={"code": "ACCOUNT_REGISTRATION_NOT_READY"},
            headers={"Cache-Control": "private, no-store"},
        ) from None
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={"code": "ACCOUNT_REGISTRATION_UNAVAILABLE"},
            headers={"Cache-Control": "private, no-store"},
        ) from None


@router.post("/start-fresh")
async def start_fresh_account(
    payload: StartFreshRequest, response: Response, authorization: str | None = Header(None)
):
    _enabled()
    response.headers["Cache-Control"] = "private, no-store"
    if payload.confirmed is not True:
        raise HTTPException(
            status_code=409,
            detail={"code": "ACCOUNT_REGISTRATION_CONFIRMATION_REQUIRED"},
            headers={"Cache-Control": "private, no-store"},
        )
    claims = await run_in_threadpool(verify_account_registration_bearer, authorization)
    try:
        principal = await run_in_threadpool(
            AccountGenerationService.confirm_registration,
            claims,
            previous_generation=payload.previous_generation,
            cleanup_operation=str(payload.cleanup_operation),
            enrollment_operation=str(payload.enrollment_operation),
            accepted_review_digest=payload.accepted_review_digest,
        )
    except AccountGenerationRefused:
        raise HTTPException(
            status_code=409,
            detail={"code": "ACCOUNT_REGISTRATION_REVIEW_CHANGED"},
            headers={"Cache-Control": "private, no-store"},
        ) from None
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={"code": "ACCOUNT_REGISTRATION_UNAVAILABLE"},
            headers={"Cache-Control": "private, no-store"},
        ) from None
    return {
        "active": True,
        "firebase_uid": principal.firebase_uid,
        "owner_id": principal.owner_id,
        "account_generation": principal.generation,
    }
