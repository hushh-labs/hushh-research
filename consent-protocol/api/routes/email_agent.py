"""Email agent routes — askkai@hushh.ai inbound webhook.

POST /api/email/inbound receives incoming emails (SendGrid Inbound Parse or
compatible JSON), routes the message through the Kai agent for KYC processing,
and queues a reply back to the sender.

Security:
- No Firebase auth required (webhook from email provider).
- Webhook authenticity should be verified via SENDGRID_WEBHOOK_SECRET when
  configured; otherwise the endpoint is open (suitable for dev/staging).
- Callers should apply rate limiting at the infrastructure level (e.g. WAF).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
from functools import partial
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from hushh_mcp.services.email_agent_service import (
    generate_agent_response,
    parse_sendgrid_inbound,
    send_reply,
)
from hushh_mcp.services.email_delivery_queue_service import (
    get_email_delivery_queue_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/email", tags=["Email Agent"])


# ---------------------------------------------------------------------------
# Webhook signature verification (optional — skipped when secret is unset)
# ---------------------------------------------------------------------------


def _verify_sendgrid_signature(request_body: bytes, signature: str | None) -> bool:
    """Verify SendGrid webhook signature if SENDGRID_WEBHOOK_SECRET is set."""
    secret = (os.getenv("SENDGRID_WEBHOOK_SECRET") or "").strip()
    if not secret:
        # No secret configured — skip verification (dev / staging).
        return True
    if not signature:
        return False
    expected = hmac.new(secret.encode(), request_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class InboundEmailPayload(BaseModel):
    """Subset of SendGrid Inbound Parse fields we require.

    SendGrid sends form-data, but we also accept JSON for easier testing
    and alternative providers.
    """

    # SendGrid field names use plain strings (from, to, subject, text, html)
    from_field: str = Field(..., alias="from", description="Sender address (Name <addr> or bare)")
    to: str = Field(default="", description="Recipient address")
    subject: str = Field(default="", description="Email subject line")
    text: str = Field(default="", description="Plain text body")
    html: str = Field(default="", description="HTML body (fallback if text is empty)")

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Inbound webhook endpoint
# ---------------------------------------------------------------------------


@router.post("/inbound", status_code=status.HTTP_202_ACCEPTED)
async def inbound_email_webhook(request: Request):
    """Receive an inbound email, process through Kai, and queue a reply.

    Accepts both JSON bodies and form-data (SendGrid default).
    """
    # Verify webhook signature before doing any body parsing.
    raw_body = await request.body()
    signature = request.headers.get("x-twilio-email-event-webhook-signature")
    if not _verify_sendgrid_signature(raw_body, signature):
        logger.warning("email_agent.inbound.invalid_signature")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid webhook signature.",
        )

    content_type = request.headers.get("content-type", "")

    if "application/json" in content_type:
        raw_payload: dict[str, Any] = await request.json()
    elif "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        raw_payload = dict(form)
    else:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Expected JSON or form-data payload.",
        )

    # Parse the email.
    try:
        parsed = parse_sendgrid_inbound(raw_payload)
    except ValueError as exc:
        logger.warning("email_agent.inbound.parse_failed reason=%s", exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    logger.info(
        "email_agent.inbound.received sender=%s subject=%s",
        parsed.sender_email,
        parsed.subject,
    )

    agent_reply = await asyncio.to_thread(generate_agent_response, parsed)

    # Queue the outbound reply via the existing email delivery queue.
    try:
        queue_result = await get_email_delivery_queue_service().enqueue(
            kind="support_message",  # reuse existing job kind
            send_callable=partial(
                send_reply,
                to_email=parsed.sender_email,
                subject=parsed.subject,
                body_text=agent_reply,
            ),
            context={
                "channel": "askkai_email",
                "sender": parsed.sender_email,
                "subject": parsed.subject,
            },
        )
    except Exception as exc:
        logger.exception("email_agent.inbound.queue_failed sender=%s", parsed.sender_email)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to queue reply.",
        ) from exc

    return {
        "accepted": True,
        "sender": parsed.sender_email,
        "subject": parsed.subject,
        "reply_queued": True,
        "job_id": queue_result.get("job_id"),
    }


@router.get("/health")
async def email_agent_health():
    """Simple health check for the email agent endpoint."""
    return {"status": "ok", "service": "askkai-email-agent"}
