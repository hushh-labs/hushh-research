"""Advisor directory routes — advisers near a coordinate, and one profile.

The upstream bearer key never leaves the backend, so the app calls these
endpoints instead of the directory API directly. Coordinates arrive per
request, are used only to build the upstream query, and are never persisted.

The search is a POST even though it reads nothing: a GET would put the user's
exact position in the request line, which the access log records verbatim, and
which also lands in browser history and any Referer. The Maps proxy endpoints
in api/routes/one/location.py are POST for the same reason.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.advisor_directory_service import (
    AdvisorDirectoryError,
    AdvisorDirectoryService,
)

router = APIRouter(prefix="/api/one", tags=["Advisors"])


class AdvisorSearchRequest(BaseModel):
    """A location to search around, or a postal code when there is none."""

    model_config = ConfigDict(populate_by_name=True)

    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    postal_code: str | None = Field(default=None, alias="postalCode", max_length=12)
    radius_mi: float | None = Field(default=None, alias="radiusMi", gt=0, le=100)
    limit: int = Field(default=10, ge=1, le=50)
    offset: int = Field(default=0, ge=0)
    advisor_type: str = Field(default="ia", alias="type", max_length=8)


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


@router.post("/advisors/search")
@limiter.limit(RateLimits.ONE_ADVISORS_DIRECTORY_READ)
async def advisors_search(
    request: Request,
    response: Response,
    payload: AdvisorSearchRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    _ = firebase_uid  # auth-gate only; results are not user-scoped
    _no_store(response)
    try:
        return await _service().search(
            lat=payload.lat,
            lng=payload.lng,
            postal_code=payload.postal_code,
            radius_mi=payload.radius_mi,
            limit=payload.limit,
            offset=payload.offset,
            advisor_type=payload.advisor_type,
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
    # A CRD is a public FINRA identifier, not a location, so it is safe in a path.
    _ = firebase_uid
    _no_store(response)
    try:
        return await _service().profile(crd)
    except AdvisorDirectoryError as exc:
        raise _handle(exc) from exc
