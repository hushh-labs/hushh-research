"""Insurance agent directory routes — Nationwide agencies near a coordinate.

The sibling of ``api/routes/one/advisors.py``, and a POST for the same reason:
a GET would put the user's exact position in the request line, which the access
log records verbatim and which also lands in browser history and any Referer.

There is no profile endpoint. The locator returns full agency data inline, so a
search row is already everything a detail view needs — a second round trip would
fetch nothing the client does not already hold.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.insurance_agent_directory_service import (
    InsuranceAgentDirectoryError,
    InsuranceAgentDirectoryService,
)

router = APIRouter(prefix="/api/one", tags=["Insurance Agents"])


class InsuranceAgentSearchRequest(BaseModel):
    """A location to search around, or a postal code when there is none."""

    model_config = ConfigDict(populate_by_name=True)

    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    postal_code: str | None = Field(default=None, alias="postalCode", max_length=12)
    radius_mi: float | None = Field(default=None, alias="radiusMi", gt=0, le=100)
    limit: int = Field(default=10, ge=1, le=50)
    offset: int = Field(default=0, ge=0)


def _service() -> InsuranceAgentDirectoryService:
    return InsuranceAgentDirectoryService()


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


def _handle(exc: InsuranceAgentDirectoryError) -> HTTPException:
    # The upstream limit is per-IP and every user shares this backend's egress
    # address, so its Retry-After applies to the whole surface. Passing it on
    # lets a client wait the stated time instead of hammering a closed door.
    headers = None
    if exc.status_code == 429 and exc.retry_after_seconds:
        headers = {"Retry-After": str(exc.retry_after_seconds)}
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": "ONE_INSURANCE_AGENTS_UNAVAILABLE", "message": str(exc)},
        headers=headers,
    )


@router.post("/insurance-agents/search")
@limiter.limit(RateLimits.ONE_INSURANCE_AGENTS_DIRECTORY_READ)
async def insurance_agents_search(
    request: Request,
    response: Response,
    payload: InsuranceAgentSearchRequest,
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
        )
    except InsuranceAgentDirectoryError as exc:
        raise _handle(exc) from exc
