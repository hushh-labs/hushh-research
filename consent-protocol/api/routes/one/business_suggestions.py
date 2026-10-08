"""Owner-bound, read-only B2B suggestion fixture; no claim or save operation."""

from ipaddress import ip_address

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter
from hushh_mcp.services.business_suggestion_service import (
    BusinessSuggestionUnavailable,
    get_business_suggestion,
)

_NO_STORE = {"Cache-Control": "private, no-store"}


class _PrivateSuggestionRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request: Request):
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                exc.headers = {**(exc.headers or {}), **_NO_STORE}
                raise
            response.headers.update(_NO_STORE)
            return response

        return private_handler


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
