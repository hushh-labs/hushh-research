"""Authenticated, stateless public-professional synthesis; no private-record access."""

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from api.developer_auth import authenticate_developer_principal
from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler
from api.utils.private_no_store import PRIVATE_NO_STORE_HEADERS, PrivateNoStoreRoute
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from hushh_mcp.services.professional_profile_synthesis import (
    ProfessionalProfileReport,
    ProfessionalProfileRequest,
    synthesize_professional_profile,
)


class PrivateSynthesisRoute(PrivateNoStoreRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def private_handler(request: Request):
            try:
                return await handler(request)
            except RateLimitExceeded as error:
                response = rate_limit_exceeded_handler(request, error)
                response.headers.update(PRIVATE_NO_STORE_HEADERS)
                return response
            except RequestValidationError as error:
                # Never echo input values, validation context or unknown field names.
                fields = {"name", "dob", "gender", "school", "college", "company"}
                invalid = sorted(
                    {str(loc) for item in error.errors() for loc in item["loc"] if loc in fields}
                )
                return JSONResponse(
                    status_code=422,
                    content={
                        "detail": {
                            "code": "INVALID_PROFILE_INPUT",
                            "message": "Name, ISO dob and gender are required; provide at least two of school, college and company.",
                            "invalid_fields": invalid,
                        }
                    },
                    headers=PRIVATE_NO_STORE_HEADERS,
                )
            except HTTPException:
                raise
            except Exception:
                # Authentication/storage failures occur before the endpoint body too.
                return JSONResponse(
                    status_code=503,
                    content={
                        "detail": {
                            "code": "PROFILE_SYNTHESIS_UNAVAILABLE",
                            "message": "Profile synthesis is temporarily unavailable.",
                        }
                    },
                    headers=PRIVATE_NO_STORE_HEADERS,
                )

        return private_handler


router = APIRouter(
    prefix="/api/v1/professional-profile", tags=["Developer API"], route_class=PrivateSynthesisRoute
)


def require_synthesis_developer(
    request: Request, authorization: str | None = Header(default=None)
) -> DeveloperPrincipal:
    return authenticate_developer_principal(
        authorization=authorization, token=request.query_params.get("token"), request=request
    )


@router.post("/synthesize", response_model=ProfessionalProfileReport)
@limiter.limit("3/hour")
async def synthesize_profile(
    request: Request,
    body: ProfessionalProfileRequest,
    principal: DeveloperPrincipal = Depends(require_synthesis_developer),
):
    try:
        report = await synthesize_professional_profile(body)
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "PROFILE_SYNTHESIS_UNAVAILABLE",
                "message": "No report was received. A provider outcome may be unknown; do not automatically replay this request.",
            },
        ) from None
    # Revalidate credentials before releasing a long-running result.
    require_synthesis_developer(request, request.headers.get("Authorization"))
    return report
