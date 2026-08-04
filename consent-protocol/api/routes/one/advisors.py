"""Advisor directory routes — advisers near a coordinate, and one profile.

The upstream bearer key never leaves the backend, so the app calls these
endpoints instead of the directory API directly. Coordinates arrive per request,
are used only to build the upstream query, and are never persisted or logged.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.advisor_directory_service import (
    AdvisorDirectoryError,
    AdvisorDirectoryService,
)

router = APIRouter(prefix="/api/one", tags=["Advisors"])


def _service() -> AdvisorDirectoryService:
    return AdvisorDirectoryService()


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


def _handle(exc: AdvisorDirectoryError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": "ONE_ADVISORS_UNAVAILABLE", "message": str(exc)},
    )


@router.get("/advisors/nearby")
@limiter.limit(RateLimits.ONE_ADVISORS_DIRECTORY_READ)
async def advisors_nearby(
    request: Request,
    response: Response,
    lat: float | None = Query(default=None, ge=-90, le=90),
    lng: float | None = Query(default=None, ge=-180, le=180),
    postal_code: str | None = Query(default=None, alias="postalCode", max_length=12),
    radius_mi: float | None = Query(default=None, alias="radiusMi", gt=0, le=100),
    limit: int = Query(default=10, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    advisor_type: str = Query(default="ia", alias="type", max_length=8),
    firebase_uid: str = Depends(require_firebase_auth),
):
    _ = firebase_uid  # auth-gate only; results are not user-scoped
    _no_store(response)
    try:
        return await _service().search(
            lat=lat,
            lng=lng,
            postal_code=postal_code,
            radius_mi=radius_mi,
            limit=limit,
            offset=offset,
            advisor_type=advisor_type,
        )
    except AdvisorDirectoryError as exc:
        raise _handle(exc) from exc


@router.get("/advisors/{crd}")
@limiter.limit(RateLimits.ONE_ADVISORS_DIRECTORY_READ)
async def advisor_profile(
    request: Request,
    response: Response,
    crd: str = Path(..., min_length=1, max_length=12),
    firebase_uid: str = Depends(require_firebase_auth),
):
    _ = firebase_uid
    _no_store(response)
    try:
        return await _service().profile(crd)
    except AdvisorDirectoryError as exc:
        raise _handle(exc) from exc
