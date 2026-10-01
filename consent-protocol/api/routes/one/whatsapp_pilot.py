"""Signed, read-only WhatsApp webhook ingress for the internal pilot.

The pilot acknowledges events and records only aggregate counts. It does not
store message content, associate a WhatsApp sender with a One owner, or reply.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/whatsapp/pilot", tags=["One WhatsApp Pilot"])
_MAX_BODY_BYTES = 64 * 1024


def _settings() -> tuple[str, str, str, str]:
    verify_token = os.getenv("HUSHH_WHATSAPP_PILOT_VERIFY_TOKEN", "").strip()
    app_secret = os.getenv("HUSHH_META_APP_SECRET", "").strip()
    waba_id = os.getenv("HUSHH_WHATSAPP_PILOT_WABA_ID", "").strip()
    phone_number_id = os.getenv("HUSHH_WHATSAPP_PILOT_PHONE_NUMBER_ID", "").strip()
    if not all((verify_token, app_secret, waba_id, phone_number_id)):
        raise HTTPException(status_code=503, detail="WhatsApp pilot is unavailable.")
    return verify_token, app_secret, waba_id, phone_number_id


@router.get("/webhook", response_class=PlainTextResponse)
async def verify_whatsapp_pilot_webhook(request: Request) -> PlainTextResponse:
    verify_token, _, _, _ = _settings()
    params = request.query_params
    challenge = params.get("hub.challenge", "")
    if (
        params.get("hub.mode") != "subscribe"
        or not params.get("hub.verify_token")
        or not hmac.compare_digest(params["hub.verify_token"], verify_token)
        or not challenge.isdecimal()
        or len(challenge) > 20
    ):
        raise HTTPException(status_code=403, detail="Webhook verification failed.")
    return PlainTextResponse(challenge, headers={"Cache-Control": "no-store"})


async def _bounded_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Webhook payload is too large.")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/webhook")
async def receive_whatsapp_pilot_webhook(request: Request) -> dict[str, bool]:
    _, app_secret, waba_id, phone_number_id = _settings()
    raw_body = await _bounded_body(request)
    signature = request.headers.get("X-Hub-Signature-256", "")
    digest = hmac.new(app_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, f"sha256={digest}"):
        raise HTTPException(status_code=401, detail="Webhook signature is invalid.")
    try:
        payload = json.loads(raw_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Webhook payload is invalid.") from exc
    if not isinstance(payload, dict) or payload.get("object") != "whatsapp_business_account":
        raise HTTPException(status_code=400, detail="Webhook payload is invalid.")

    entries = payload.get("entry")
    if not isinstance(entries, list):
        raise HTTPException(status_code=400, detail="Webhook payload is invalid.")
    inbound = 0
    statuses = 0
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("id") != waba_id:
            continue
        changes = entry.get("changes")
        if not isinstance(changes, list):
            continue
        for change in changes:
            if not isinstance(change, dict) or change.get("field") != "messages":
                continue
            value = change.get("value")
            if not isinstance(value, dict) or value.get("messaging_product") != "whatsapp":
                continue
            metadata = value.get("metadata")
            if not isinstance(metadata, dict) or metadata.get("phone_number_id") != phone_number_id:
                continue
            messages = value.get("messages")
            status_events = value.get("statuses")
            inbound += len(messages) if isinstance(messages, list) else 0
            statuses += len(status_events) if isinstance(status_events, list) else 0
    # No sender number, message text, message ID, or full payload enters logs.
    logger.info("one.whatsapp_pilot.webhook_received inbound=%d statuses=%d", inbound, statuses)
    return {"accepted": True}
