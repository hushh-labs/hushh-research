"""Server-only signed PLG evidence export; no customer content or send authority."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import time
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from api.middleware import require_firebase_auth_read_only
from api.utils.firebase_auth import current_auth_lane
from hushh_mcp.services import marketing_preferences, product_activity
from hushh_mcp.services.plg_audience import AudienceCursorError, AudienceRequest, audience_page
from hushh_mcp.services.plg_customer_cohort import (
    CohortCursorError,
    CohortRequest,
    customer_cohort_page,
)
from hushh_mcp.services.plg_evidence import PilotRequest, snapshot

from .marketing_preferences import router as marketing_preferences_router

router = APIRouter(prefix="/api/one/plg", tags=["One PLG integration"])
router.include_router(marketing_preferences_router)
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


class SubscriptionAck(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountHash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    revision: int = Field(ge=1, le=9_007_199_254_740_991)


class SubscriptionAcks(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    changes: list[SubscriptionAck] = Field(max_length=25)


class SubscriptionRevocation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountHash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    generation: UUID


class SubscriptionCheck(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accountId: str = Field(min_length=1, max_length=128)
    generation: UUID
    emailHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    revision: int = Field(ge=1, le=9_007_199_254_740_991)


async def _subscription_request(request: Request, purpose: str):
    secret = os.getenv("ONE_PLG_SUBSCRIPTION_SECRET", "")
    if (
        os.getenv("ONE_PLG_SUBSCRIPTION_ENABLED") != "true"
        or os.getenv("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
        or current_auth_lane() != "production"
        or len(secret) < 32
    ):
        raise HTTPException(404, "Subscription integration unavailable", headers=NO_STORE)
    return await _signed_body(request, secret=secret, purpose="subscriptions." + purpose)


@router.post("/subscriptions/pull", include_in_schema=False)
async def pull_subscription_changes(request: Request):
    raw = await _subscription_request(request, "pull")
    if raw != b"{}":
        raise HTTPException(400, "Invalid subscription request", headers=NO_STORE)
    try:
        result = await asyncio.wait_for(marketing_preferences.pending_changes(), timeout=55)
    except Exception:
        raise HTTPException(503, "Subscription projection unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


@router.post("/subscriptions/ack", include_in_schema=False)
async def acknowledge_subscription_changes(request: Request):
    raw = await _subscription_request(request, "ack")
    try:
        body = SubscriptionAcks.model_validate_json(raw)
        result = await asyncio.wait_for(
            marketing_preferences.acknowledge([(c.accountHash, c.revision) for c in body.changes]),
            timeout=20,
        )
    except ValidationError:
        raise HTTPException(400, "Invalid subscription acknowledgement", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(
            503, "Subscription acknowledgement unavailable", headers=NO_STORE
        ) from None
    return JSONResponse(result, headers=NO_STORE)


@router.post("/subscriptions/revoke", include_in_schema=False)
async def revoke_subscription_permission(request: Request):
    raw = await _subscription_request(request, "revoke")
    try:
        body = SubscriptionRevocation.model_validate_json(raw)
        result = await asyncio.wait_for(
            marketing_preferences.revoke_generation(body.accountHash, body.generation), timeout=20
        )
    except ValidationError:
        raise HTTPException(400, "Invalid subscription revocation", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Subscription revocation unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


@router.post("/subscriptions/check", include_in_schema=False)
async def check_subscription_permission(request: Request):
    raw = await _subscription_request(request, "check")
    try:
        body = SubscriptionCheck.model_validate_json(raw)
        result = await asyncio.wait_for(
            marketing_preferences.current_permission(
                body.accountId, body.generation, body.emailHash, body.revision
            ),
            timeout=30,
        )
    except ValidationError:
        raise HTTPException(400, "Invalid subscription check", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Subscription permission unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    generation: str = Field(min_length=36, max_length=36)
    operationId: str = Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")
    actionId: str = Field(min_length=1, max_length=256)
    phase: Literal["started", "returned", "failed", "cancelled", "blocked"]


@router.get("/activity", include_in_schema=False)
async def activity_admission(uid: str = Depends(require_firebase_auth_read_only)):
    try:
        result = await run_in_threadpool(product_activity.admission, uid)
    except Exception:
        raise HTTPException(503, "Product observation unavailable", headers=NO_STORE) from None
    return JSONResponse({"enabled": result is not None, **(result or {})}, headers=NO_STORE)


@router.post("/activity", include_in_schema=False)
async def report_activity(request: Request, uid: str = Depends(require_firebase_auth_read_only)):
    if not product_activity.enabled_for(uid):
        raise HTTPException(404, "Product observation unavailable", headers=NO_STORE)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 4000:
            raise HTTPException(413, "Request too large", headers=NO_STORE)
    try:
        payload = Observation.model_validate_json(body)
        UUID(payload.generation)
        recorded = await run_in_threadpool(
            product_activity.observe,
            uid,
            payload.generation,
            payload.actionId,
            payload.phase,
            "client_reported",
            payload.operationId,
        )
    except (ValueError, ValidationError):
        raise HTTPException(400, "Invalid product observation", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Product observation unavailable", headers=NO_STORE) from None
    return JSONResponse({"recorded": recorded}, headers=NO_STORE)


@router.post("/snapshot", include_in_schema=False)
async def export_snapshot(request: Request):
    secret = os.getenv("ONE_PLG_EXPORT_SECRET", "")
    allowed = {
        uid.strip() for uid in os.getenv("ONE_PLG_EXPORT_ACCOUNT_IDS", "").split(",") if uid.strip()
    }
    permission_cohort = os.getenv("ONE_PLG_SUBSCRIPTION_ENABLED") == "true"
    if (
        os.getenv("ONE_PLG_EXPORT_ENABLED") != "true"
        or os.getenv("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
        or current_auth_lane() != "production"
        or len(secret) < 32
        or len(allowed) > 100
        or (not allowed and not permission_cohort)
    ):
        raise HTTPException(404, "PLG export unavailable", headers=NO_STORE)
    body = await _signed_body(request, secret=secret, purpose="snapshot")
    try:
        payload = PilotRequest.model_validate_json(body)
        if request.headers.get("x-plg-version") == "2":
            payload = payload.model_copy(update={"version": 2})
        if permission_cohort:
            allowed.update(
                await marketing_preferences.permitted_snapshot_accounts(
                    [account.accountId for account in payload.accounts]
                )
            )
        result = await asyncio.wait_for(
            snapshot(payload, allowed, datetime.now(timezone.utc)), timeout=25
        )
    except (ValueError, ValidationError):
        raise HTTPException(
            400, "Invalid pilot request or result limit exceeded", headers=NO_STORE
        ) from None
    except Exception:
        raise HTTPException(503, "Task evidence unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


@router.post("/audience", include_in_schema=False)
async def export_audience(request: Request):
    # Contact identity has a separate credential/purpose from measurement,
    # enrollment and delivery. Registering never opts anyone into mail.
    secret = os.getenv("ONE_PLG_AUDIENCE_SECRET", "")
    if (
        os.getenv("ONE_PLG_AUDIENCE_ENABLED") != "true"
        or os.getenv("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
        or current_auth_lane() != "production"
        or len(secret) < 32
    ):
        raise HTTPException(404, "PLG audience unavailable", headers=NO_STORE)
    body = await _signed_body(request, secret=secret, purpose="audience")
    try:
        payload = AudienceRequest.model_validate_json(body)
        result = await asyncio.wait_for(
            audience_page(payload, secret, datetime.now(timezone.utc)), timeout=25
        )
    except (AudienceCursorError, ValidationError):
        raise HTTPException(400, "Invalid audience request", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Audience evidence unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


@router.post("/customer-cohort", include_in_schema=False)
async def export_customer_cohort(request: Request):
    secret = os.getenv("ONE_PLG_AUDIENCE_SECRET", "")
    if (
        os.getenv("ONE_PLG_AUDIENCE_ENABLED") != "true"
        or os.getenv("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
        or current_auth_lane() != "production"
        or len(secret) < 32
    ):
        raise HTTPException(404, "Customer cohort unavailable", headers=NO_STORE)
    body = await _signed_body(request, secret=secret, purpose="customer-cohort")
    try:
        payload = CohortRequest.model_validate_json(body)
    except ValidationError:
        raise HTTPException(400, "Invalid customer cohort request", headers=NO_STORE) from None
    try:
        result = await asyncio.wait_for(
            customer_cohort_page(payload, secret, datetime.now(timezone.utc)), timeout=25
        )
    except CohortCursorError:
        raise HTTPException(400, "Invalid customer cohort cursor", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Customer cohort unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)


async def _signed_body(request: Request, *, secret: str, purpose: str) -> bytearray:
    timestamp = request.headers.get("x-plg-timestamp", "")
    signature = request.headers.get("x-plg-signature", "")
    if (
        not re.fullmatch(r"[0-9]{13}", timestamp)
        or abs(time.time() * 1000 - int(timestamp)) > 300_000
    ):
        raise HTTPException(401, "Invalid integration signature", headers=NO_STORE)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 16_000:
            raise HTTPException(413, "Request too large", headers=NO_STORE)
    expected = hmac.new(
        secret.encode(), f"{purpose}\n{timestamp}\n".encode() + body, hashlib.sha256
    ).hexdigest()
    if not re.fullmatch(r"[a-f0-9]{64}", signature) or not hmac.compare_digest(signature, expected):
        raise HTTPException(401, "Invalid integration signature", headers=NO_STORE)
    return body
