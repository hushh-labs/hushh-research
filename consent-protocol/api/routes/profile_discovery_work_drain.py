"""OIDC-protected, bounded Cloud Scheduler entrypoint for profile discovery."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from hushh_mcp.services.public_profile_discovery_service import (
    PublicProfileDiscoveryService,
    profile_discovery_enabled,
)
from hushh_mcp.services.scheduler_identity import (
    SchedulerIdentityError,
    verified_scheduler_identity,
)

router = APIRouter(prefix="/api/internal/profile-discovery", tags=["internal-profile-discovery"])
_NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
_MAX_BODY_BYTES = 32


def _enabled() -> bool:
    return (
        profile_discovery_enabled()
        and os.getenv("ONE_PUBLIC_PROFILE_DISCOVERY_DRAIN_ENABLED", "false").strip().lower()
        == "true"
    )


@router.post("/drain")
async def drain_profile_discovery(request: Request, response: Response) -> dict[str, Any]:
    response.headers.update(_NO_STORE)
    if not _enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "PROFILE_DISCOVERY_DRAIN_DISABLED",
                "message": "Profile discovery worker is unavailable.",
            },
            headers=_NO_STORE,
        )
    try:
        identity = verified_scheduler_identity(request, "ONE_PUBLIC_PROFILE_DISCOVERY_DRAIN")
    except SchedulerIdentityError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "PROFILE_DISCOVERY_DRAIN_UNAUTHORIZED",
                "message": "Worker is not authorized.",
            },
            headers=_NO_STORE,
        ) from None
    if identity is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "PROFILE_DISCOVERY_DRAIN_UNAUTHORIZED",
                "message": "Worker is not authorized.",
            },
            headers=_NO_STORE,
        )

    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > _MAX_BODY_BYTES:
            break
    try:
        invalid_body = bool(raw) and (len(raw) > _MAX_BODY_BYTES or json.loads(raw) != {})
    except (UnicodeDecodeError, json.JSONDecodeError):
        invalid_body = True
    if invalid_body:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "PROFILE_DISCOVERY_DRAIN_INVALID_BODY",
                "message": "Invalid worker request.",
            },
            headers=_NO_STORE,
        )
    try:
        worker = PublicProfileDiscoveryService()
        async with asyncio.timeout(180):
            outcomes = await worker.drain(max_jobs=4)
            feed_rows = await worker.drain_feed_outbox(max_rows=50)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "PROFILE_DISCOVERY_DRAIN_UNAVAILABLE",
                "message": "Worker is temporarily unavailable.",
            },
            headers={**_NO_STORE, "Retry-After": "5"},
        ) from None
    return {"ok": True, "outcomes": outcomes, "feed_rows_settled": feed_rows}
