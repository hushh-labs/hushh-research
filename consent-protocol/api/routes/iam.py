"""IAM routes for dual persona management."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

router = APIRouter(prefix="/api/iam", tags=["IAM"])


class PersonaSwitchRequest(BaseModel):
    persona: str = Field(..., description="Target persona: investor | ria")


class MarketplaceOptInRequest(BaseModel):
    enabled: bool


def _iam_schema_not_ready_response(message: str | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": message or "IAM schema is not ready",
            "code": "IAM_SCHEMA_NOT_READY",
            "hint": "Run `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`.",
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
        return _iam_schema_not_ready_response(str(exc))
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
        return _iam_schema_not_ready_response(str(exc))
