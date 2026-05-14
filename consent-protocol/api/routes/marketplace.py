"""Marketplace discovery routes for RIA and investor ecosystems."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from hushh_mcp.services.ria_iam_service import IAMSchemaNotReadyError, RIAIAMService

router = APIRouter(prefix="/api/marketplace", tags=["Marketplace"])


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
    query: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    firm: str | None = Query(default=None),
    verification_status: str | None = Query(default=None),
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
    query: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
):
    service = RIAIAMService()
    try:
        items = await service.search_marketplace_investors(query=query, limit=limit)
        return {"items": items}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


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
