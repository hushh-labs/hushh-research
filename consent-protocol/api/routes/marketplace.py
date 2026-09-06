"""Marketplace discovery routes for RIA and investor ecosystems."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/marketplace", tags=["Marketplace"])


class MarketplaceInvestorActionRequest(BaseModel):
    action: str = Field(..., max_length=32)
    source_type: str | None = Field(default=None, max_length=32)
    public_profile_id: str | int | None = Field(None)
    target_user_id: str | None = Field(default=None, max_length=256)
    metadata: dict | None = Field(None)


class MarketplaceContactLookup(BaseModel):
    hash: str = Field(..., min_length=64, max_length=64, pattern=r"^[a-fA-F0-9]{64}$")
    last4: str = Field(..., min_length=2, max_length=4, pattern=r"^\d{2,4}$")


class MarketplaceContactMatchRequest(BaseModel):
    phone_lookups: list[MarketplaceContactLookup] = Field(default_factory=list, max_length=1000)
    limit: int = Field(default=50, ge=1, le=100)
    # "marketplace" keeps the Connect deck's publicly-discoverable-profiles
    # policy. "one_network" matches any phone-verified account that has not
    # turned off contact discoverability, which is what One Location contact
    # sync needs.
    scope: Literal["marketplace", "one_network"] = "marketplace"


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


@router.post("/contacts/match")
# Two ceilings on one route. See RateLimits.CONTACT_DISCOVERY_MATCH for why a
# single number cannot express this: the minute bound stops a loop, the day
# bound stops the patient walk that is the realistic way to enumerate a user
# base through a discovery endpoint.
#
# Keyed per authenticated user by `get_rate_limit_key`, not per IP, which is
# the bucket that matters here -- the route requires a Firebase identity, so a
# caller cannot shed the limit by changing address.
@limiter.limit(RateLimits.CONTACT_DISCOVERY_MATCH_DAILY)
@limiter.limit(RateLimits.CONTACT_DISCOVERY_MATCH)
async def match_marketplace_contacts(
    request: Request,
    payload: MarketplaceContactMatchRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    del request
    service = RIAIAMService()
    try:
        if payload.scope == "one_network" and payload.phone_lookups:
            # This compatibility read exposes the same verified-phone mapping
            # as canonical contact sync. It must share the verified-requester
            # gate and Postgres lookup allowance so changing routes cannot
            # bypass the cross-instance enumeration budget.
            await ActorIdentityService().sync_from_firebase(firebase_uid, force=False)
            await run_in_threadpool(
                ConnectionsService().reserve_contact_sync_lookup_budget,
                firebase_uid,
                len(payload.phone_lookups),
            )
        items = await service.match_marketplace_contacts(
            firebase_uid,
            phone_lookups=[item.dict() for item in payload.phone_lookups],
            limit=payload.limit,
            scope=payload.scope,
        )
        return {"items": items}
    except ConnectionsError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
        ) from None
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - contact proofs must stay out of exception logs
        logger.error("contact_match.failed error=%s", type(exc).__name__)
        raise HTTPException(status_code=500, detail="Contact matching failed.") from None


@router.get("/ria/{ria_id}")
async def get_marketplace_ria(ria_id: str = Path(..., min_length=1, max_length=128)):
    service = RIAIAMService()
    try:
        profile = await service.get_marketplace_ria_profile(ria_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="RIA profile not found")
        return profile
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
