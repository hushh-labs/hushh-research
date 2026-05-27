"""Marketplace discovery routes for RIA and investor ecosystems."""

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

router = APIRouter(prefix="/api/marketplace", tags=["Marketplace"])


class MarketplaceInvestorActionRequest(BaseModel):
    action: str = Field(..., max_length=32)
    source_type: str | None = Field(default=None, max_length=32)
    public_profile_id: str | int | None = None
    target_user_id: str | None = Field(default=None, max_length=256)
    metadata: dict | None = None


def _iam_schema_not_ready_response(message: str | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": message or "IAM schema is not ready",
            "code": "IAM_SCHEMA_NOT_READY",
            "hint": "Run `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`.",
        },
    )


@router.get("/rias")
async def list_marketplace_rias(
    query: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    firm: str | None = Query(default=None, max_length=200),
    verification_status: str | None = Query(default=None, max_length=50),
):
    service = RIAIAMService()
    try:
        items = await service.search_marketplace_rias(
            query=query,
            limit=limit,
            firm=firm,
            verification_status=verification_status,
        )
        return {"items": items}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/investors")
async def list_marketplace_investors(
    query: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    persona: str | None = Query(default="ria", max_length=50),
    deck: str | None = Query(default="qualified", max_length=50),
    location: str | None = Query(default=None, max_length=100),
):
    service = RIAIAMService()
    try:
        items = await service.search_marketplace_investors(
            query=query,
            limit=limit,
            persona=persona,
            deck=deck,
            location=location,
        )
        return {"items": items}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/investors/deck")
async def list_marketplace_investor_deck(
    query: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=12, ge=1, le=50),
    persona: str | None = Query(default="ria", max_length=50),
    deck: str | None = Query(default="qualified", max_length=50),
    location: str | None = Query(default=None, max_length=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.search_marketplace_investor_deck(
            firebase_uid,
            query=query,
            limit=limit,
            persona=persona,
            deck=deck,
            location=location,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/investors/actions")
async def list_marketplace_investor_actions(
    status: str | None = Query(default=None, max_length=32),
    action: str | None = Query(default=None, max_length=32),
    limit: int = Query(default=50, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        items = await service.list_marketplace_investor_actions(
            firebase_uid,
            status=status,
            action=action,
            limit=limit,
        )
        return {"items": items}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/investors/actions")
async def record_marketplace_investor_action(
    payload: MarketplaceInvestorActionRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.record_marketplace_investor_action(
            firebase_uid,
            action=payload.action,
            source_type=payload.source_type,
            public_profile_id=payload.public_profile_id,
            target_user_id=payload.target_user_id,
            metadata=payload.metadata,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/ria/{ria_id}")
async def get_marketplace_ria(ria_id: str):
    service = RIAIAMService()
    try:
        profile = await service.get_marketplace_ria_profile(ria_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="RIA profile not found")
        return profile
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
