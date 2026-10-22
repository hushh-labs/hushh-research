"""Owner-bound discovery and suggestion completion; no profile or claim writes."""

from ipaddress import ip_address

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter
from api.utils.private_no_store import (
    PRIVATE_NO_STORE_HEADERS as _NO_STORE,
)
from api.utils.private_no_store import PrivateNoStoreRoute as _PrivateSuggestionRoute
from hushh_mcp.services.business_profile_completion import (
    BusinessReviewNotCommitted,
    complete_business_profile,
)
from hushh_mcp.services.business_suggestion_service import (
    BusinessSuggestionUnavailable,
    get_business_suggestion,
)

router = APIRouter(
    prefix="/api/one/business",
    tags=["Business suggestions"],
    route_class=_PrivateSuggestionRoute,
)


async def _owner(token: dict = Depends(require_vault_owner_token)) -> str:
    user_id = token.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=403, detail="Unlock your vault.", headers=_NO_STORE)
    return user_id


class BusinessReviewCommit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    domain: str = Field(min_length=1, max_length=120)
    plan_id: str = Field(min_length=1, max_length=160)


class BusinessReviewCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commits: list[BusinessReviewCommit] = Field(min_length=1, max_length=64)


@router.post("/suggestion/complete")
@limiter.limit("10/minute")
async def business_review_complete(
    request: Request, body: BusinessReviewCompletion, user_id: str = Depends(_owner)
) -> JSONResponse:
    try:
        await complete_business_profile(
            user_id, [(row.domain, row.plan_id) for row in body.commits]
        )
    except BusinessReviewNotCommitted:
        raise HTTPException(
            status_code=409,
            detail="Reviewed details have not all been confirmed.",
            headers=_NO_STORE,
        ) from None
    except Exception:
        return JSONResponse(
            {"detail": "Completion could not be confirmed. Retry the saved review."},
            status_code=503,
            headers={**_NO_STORE, "Retry-After": "5"},
        )
    return JSONResponse({"saved": True}, headers=_NO_STORE)


@router.get("/suggestion")
@limiter.limit("10/minute")
async def business_suggestion(request: Request, user_id: str = Depends(_owner)) -> JSONResponse:
    # Use the actual peer, never spoofable Forwarded/X-Forwarded-For headers.
    try:
        loopback = bool(request.client and ip_address(request.client.host).is_loopback)
    except ValueError:
        loopback = False
    try:
        result = await get_business_suggestion(user_id, local_loopback=loopback)
    except BusinessSuggestionUnavailable:
        return JSONResponse(
            {
                "detail": {
                    "code": "BUSINESS_IDENTITY_UNAVAILABLE",
                    "message": "Verified business identity is temporarily unavailable.",
                }
            },
            status_code=503,
            headers={**_NO_STORE, "Retry-After": "5"},
        )
    return JSONResponse(result, headers=_NO_STORE)
