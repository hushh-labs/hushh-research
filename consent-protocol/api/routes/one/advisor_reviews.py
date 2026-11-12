"""Combined advisor introductions. Financial contents remain recipient ciphertext."""

import asyncio
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field

from api.middlewares.rate_limit import RateLimits, limiter
from api.routes.one.finance_sharing import PrivateFinanceRoute, identity
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.services.advisor_review_billing import AdvisorBillingService
from hushh_mcp.services.advisor_review_contract import (
    AdvisorPlan,
    CreateAdvisorReview,
    MeetingAction,
    MeetingTime,
    PlanCheckout,
    ReviewDecision,
)
from hushh_mcp.services.advisor_review_meetings import AdvisorMeetingService
from hushh_mcp.services.advisor_review_payouts import AdvisorSandboxPayouts
from hushh_mcp.services.advisor_review_service import AdvisorReviewService
from hushh_mcp.services.advisor_review_store import AdvisorReviewError
from hushh_mcp.services.finance_sharing_contract import StrictObject
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.one_portfolio_review import ReviewInput, run_portfolio_review
from hushh_mcp.services.owner_placement_guard import hub_content_owner, require_hub_content_current

router = APIRouter(
    prefix="/api/one/finance/advisor-reviews",
    tags=["Advisor reviews"],
    route_class=PrivateFinanceRoute,
)


class Discovery(StrictObject):
    scope: Literal["connections", "global", "nearby"] | None = None
    page: int = Field(default=1, ge=1, le=1000)
    query: str = Field(default="", max_length=100)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    postalCode: str | None = Field(default=None, min_length=3, max_length=12)
    radiusMiles: float = Field(default=5, gt=0, le=100)


@router.post("/candidates")
@limiter.limit(RateLimits.ONE_ADVISORS_DIRECTORY_READ)
async def discover(request: Request, body: Discovery, viewer: str = Depends(identity)):
    from hushh_mcp.services.advisor_directory_service import (
        AdvisorDirectoryError,
        AdvisorDirectoryService,
    )
    from hushh_mcp.services.advisor_review_directory import candidates

    nearby = body.latitude is not None or body.longitude is not None or body.postalCode is not None
    if body.scope == "nearby" and not nearby:
        raise AdvisorReviewError("ADVISOR_LOCATION_REQUIRED", 422)
    if nearby and body.scope in (None, "nearby"):
        try:
            directory = await AdvisorDirectoryService().search(
                lat=body.latitude,
                lng=body.longitude,
                postal_code=body.postalCode,
                radius_mi=body.radiusMiles,
                limit=30,
                offset=(body.page - 1) * 30,
                advisor_type="ia",
            )
        except AdvisorDirectoryError as exc:
            # Bad input is the person's to fix; anything else is a directory outage.
            if exc.status_code < 500 and exc.status_code != 429:
                raise AdvisorReviewError("ADVISOR_LOCATION_INVALID", 422) from exc
            raise AdvisorReviewError("ADVISOR_DIRECTORY_UNAVAILABLE", 503) from exc
        crds = [
            str(item["crd"])
            for item in directory["items"]
            if item.get("kind") == "advisor" and item.get("crd")
        ]
        people = await asyncio.to_thread(candidates, viewer, crds=crds)
        return {**people, "hasMore": directory["meta"]["hasMore"], "directory": directory}
    people = await asyncio.to_thread(
        candidates, viewer, query=body.query, connected=body.scope == "connections", page=body.page
    )
    return {**people, "directory": None}


@router.post("/portfolio-analysis")
@limiter.limit("6/minute")
async def portfolio_analysis(
    request: Request,
    body: ReviewInput,
    viewer: str = Depends(identity),
    owner: dict = Depends(hub_content_owner),
):
    if owner["user_id"] != viewer or not body.allow_model_processing:
        raise HTTPException(403, {"code": "FINANCE_REVIEW_APPROVAL_REQUIRED"})
    token = owner.get("token", "")

    async def check_owner() -> None:
        if await validate_first_party_owner_token(viewer, token) is None:
            raise HTTPException(403, {"code": "FINANCE_REVIEW_OWNER_REQUIRED"})

    await require_hub_content_current(viewer, "one_portfolio_review", check_owner)
    result = await run_portfolio_review(body, user_id=viewer, consent_token=token)
    await require_hub_content_current(viewer, "one_portfolio_review", check_owner)
    return result


@router.get("")
async def history(viewer: str = Depends(identity), ui: Literal["2"] | None = None):
    return await asyncio.to_thread(AdvisorReviewService().history, viewer, ui == "2")


@router.post("")
@limiter.limit("10/minute")
async def create(request: Request, body: CreateAdvisorReview, viewer: str = Depends(identity)):
    return await asyncio.to_thread(AdvisorReviewService().create, viewer, body)


@router.get("/{request_id}")
async def view(request_id: UUID, viewer: str = Depends(identity), ui: Literal["2"] | None = None):
    return await asyncio.to_thread(AdvisorReviewService().view, viewer, str(request_id), ui == "2")


@router.post("/{request_id}/decision")
async def decision(request_id: UUID, body: ReviewDecision, viewer: str = Depends(identity)):
    return await asyncio.to_thread(
        AdvisorReviewService().decide,
        viewer,
        str(request_id),
        body.action,
        body.requireExistingConnection,
    )


@router.post("/{request_id}/meeting")
async def propose_time(request_id: UUID, body: MeetingTime, viewer: str = Depends(identity)):
    return await asyncio.to_thread(
        AdvisorMeetingService().propose_time, viewer, str(request_id), body
    )


@router.post("/{request_id}/meeting/action")
@limiter.limit("20/minute")
async def meeting_action(
    request: Request,
    request_id: UUID,
    body: MeetingAction,
    viewer: str = Depends(identity),
    token: dict = Depends(hub_content_owner),
):
    if token["user_id"] != viewer:
        raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
    try:
        return await AdvisorMeetingService().act(viewer, str(request_id), body)
    except GoogleConnectionError as exc:
        code = (
            "ADVISOR_CONNECT_CALENDAR"
            if exc.status_code in (401, 403)
            or exc.reason_code
            in {
                "calendar_connection_changed",
                "calendar_scope_required",
                "google_connection_required",
            }
            else "ADVISOR_CALENDAR_UNAVAILABLE"
        )
        raise AdvisorReviewError(code, 409 if code == "ADVISOR_CONNECT_CALENDAR" else 503) from exc


@router.post("/{request_id}/meeting/decision")
async def meeting_decision(request_id: UUID, body: MeetingAction, viewer: str = Depends(identity)):
    if body.action not in {"agree", "complete"}:
        raise AdvisorReviewError("ADVISOR_CALENDAR_REVIEW_REQUIRED", 422)
    return await AdvisorMeetingService().act(viewer, str(request_id), body)


@router.post("/{request_id}/plan")
async def offer_plan(request_id: UUID, body: AdvisorPlan, viewer: str = Depends(identity)):
    return await asyncio.to_thread(AdvisorBillingService().offer, viewer, str(request_id), body)


@router.post("/{request_id}/checkout")
@limiter.limit("10/minute")
async def checkout(
    request: Request, request_id: UUID, body: PlanCheckout, viewer: str = Depends(identity)
):
    return await asyncio.to_thread(AdvisorBillingService().checkout, viewer, str(request_id), body)


@router.get("/{request_id}/billing")
async def billing(request_id: UUID, viewer: str = Depends(identity)):
    return await asyncio.to_thread(AdvisorBillingService().reconcile, viewer, str(request_id))


@router.delete("/{request_id}/billing")
async def cancel_billing(request_id: UUID, viewer: str = Depends(identity)):
    return await asyncio.to_thread(AdvisorBillingService().cancel, viewer, str(request_id))


@router.get("/{request_id}/sandbox-payout")
@limiter.limit("10/minute")
async def sandbox_payout(request: Request, request_id: UUID, viewer: str = Depends(identity)):
    payouts = await AdvisorSandboxPayouts.for_request(viewer, request_id)
    return await payouts.status()


@router.post("/{request_id}/sandbox-payout/{action}")
@limiter.limit("5/minute")
async def sandbox_payout_link(
    request: Request,
    request_id: UUID,
    action: Literal["onboarding", "dashboard"],
    viewer: str = Depends(identity),
):
    payouts = await AdvisorSandboxPayouts.for_request(viewer, request_id)
    return await payouts.link(action)
