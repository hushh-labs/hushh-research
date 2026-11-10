"""Stripe-signed events and a dedicated UAT retirement drain."""

import asyncio

from fastapi import APIRouter, Header, HTTPException, Request

from hushh_mcp.services.advisor_review_billing import test_config
from hushh_mcp.services.advisor_review_billing_events import cleanup_async, process_event
from hushh_mcp.services.advisor_review_store import AdvisorReviewError
from hushh_mcp.services.scheduler_identity import SchedulerIdentityError, verify_scheduler_request
from hushh_mcp.services.stripe_mode import stripe_environment

router = APIRouter(prefix="/api/payments/advisor/stripe", tags=["Advisor billing"])
_CLEANUP_AUDIENCE = "https://api.uat.hushh.ai/api/payments/advisor/stripe/cleanup"
_CLEANUP_CALLER = "ria-sandbox-cleanup@hushh-pda-uat.iam.gserviceaccount.com"


@router.post("/webhook")
async def webhook(
    request: Request, signature: str | None = Header(default=None, alias="Stripe-Signature")
):
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 256000:
            raise HTTPException(413, "Event too large")
        chunks.append(chunk)
    try:
        return await asyncio.to_thread(process_event, b"".join(chunks), signature)
    except AdvisorReviewError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code}) from None


@router.post("/cleanup")
async def cleanup(authorization: str | None = Header(default=None)):
    if stripe_environment() != "uat":
        raise HTTPException(404)
    try:
        await asyncio.wait_for(
            asyncio.to_thread(
                verify_scheduler_request,
                authorization_header=authorization,
                audience=_CLEANUP_AUDIENCE,
                allowed_emails=(_CLEANUP_CALLER,),
            ),
            timeout=5,
        )
    except SchedulerIdentityError:
        raise HTTPException(401, {"code": "ADVISOR_CLEANUP_UNAUTHORIZED"}) from None
    except TimeoutError:
        raise HTTPException(503, {"code": "ADVISOR_CLEANUP_UNAVAILABLE"}) from None
    try:
        await asyncio.to_thread(test_config)
        settled = await cleanup_async(limit=2)
    except AdvisorReviewError as exc:
        raise HTTPException(503, {"code": exc.code}) from None
    return {"settled": settled}
