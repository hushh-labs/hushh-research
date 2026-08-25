"""IAM routes for dual persona management."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
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
    persona: str = Field(..., description="Target persona: investor | ria", max_length=32)


class MarketplaceOptInRequest(BaseModel):
    enabled: bool


class ContactDiscoverabilityRequest(BaseModel):
    enabled: bool
    consent_version: str | None = Field(default=None, max_length=64)


def _iam_schema_not_ready_response() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": "RIA verification service is temporarily unavailable",
            "code": "IAM_SCHEMA_NOT_READY",
        },
    )


@router.get("/persona")
async def get_persona(
    firebase_uid: str = Depends(require_firebase_auth),
    force: bool = Query(
        default=False,
        description="Bypass the server persona cache (used after a persona mutation).",
    ),
):
    service = RIAIAMService()
    try:
        return await service.get_persona_state(firebase_uid, force=force)
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.get("/contact-discoverability")
async def get_contact_discoverability(
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Combined consent for verified phone holders to find and auto-connect."""
    service = RIAIAMService()
    try:
        return await service.get_contact_discoverability(firebase_uid)
    except IAMSchemaNotReadyError:
        # Fail closed until the versioned combined-consent schema is available.
        return {
            "user_id": firebase_uid,
            "contact_discoverable": False,
            "contact_sync_consent_enabled_at": None,
            "contact_sync_consent_rule_version": 0,
            "contact_sync_consent_contract_version": None,
            "iam_schema_ready": False,
        }


@router.post("/contact-discoverability")
async def update_contact_discoverability(
    payload: ContactDiscoverabilityRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.set_contact_discoverability(
            firebase_uid,
            payload.enabled,
            consent_version=payload.consent_version,
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
