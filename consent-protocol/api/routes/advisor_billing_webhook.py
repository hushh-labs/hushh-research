"""Stripe Connect signatures, not browser redirects, reconcile advisor billing."""

import asyncio

from fastapi import APIRouter, Header, HTTPException, Request

from hushh_mcp.services.advisor_review_billing_events import process_event
from hushh_mcp.services.advisor_review_store import AdvisorReviewError

router = APIRouter(prefix="/api/payments/advisor/stripe", tags=["Advisor billing"])


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
