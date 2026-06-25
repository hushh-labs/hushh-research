"""IAM routes for dual persona management."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/iam", tags=["IAM"])


class PersonaSwitchRequest(BaseModel):
    persona: str = Field(..., description="Target persona: investor | ria", max_length=32)


class MarketplaceOptInRequest(BaseModel):
    enabled: bool


def _iam_schema_not_ready_response(exc: Exception | None = None) -> JSONResponse:
    """Return a static 503 response.

    Internal admin commands and exception detail are suppressed to avoid
    leaking server-side implementation details to API clients (CWE-209).
    """
    if exc is not None:
        logger.warning("IAM schema not ready: %s", exc)
    return JSONResponse(
        status_code=503,
        content={
            "error": "Service temporarily unavailable. Please try again later.",
            "code": "IAM_SCHEMA_NOT_READY",
        },
    )


@router.get("/persona")
async def get_persona(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return await service.get_persona_state(firebase_uid)
    except IAMSchemaNotReadyError:
        return {
            "user_id": firebase_uid,
            "personas": ["investor"],
            "last_active_persona": "investor",
            "investor_marketplace_opt_in": False,
            "iam_schema_ready": False,
            "mode": "compat_investor",
        }


@router.post("/persona/switch")
async def switch_persona(
    payload: PersonaSwitchRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.switch_persona(firebase_uid, payload.persona)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(exc)
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/marketplace/opt-in")
async def update_marketplace_opt_in(
    payload: MarketplaceOptInRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.set_marketplace_opt_in(firebase_uid, payload.enabled)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(exc)
