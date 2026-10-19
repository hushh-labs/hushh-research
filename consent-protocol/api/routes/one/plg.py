"""Server-only signed PLG evidence export; no customer content or send authority."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from api.utils.firebase_auth import current_auth_lane
from hushh_mcp.services.plg_evidence import PilotRequest, snapshot

router = APIRouter(prefix="/api/one/plg", tags=["One PLG integration"])
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


@router.post("/snapshot", include_in_schema=False)
async def export_snapshot(request: Request):
    secret = os.getenv("ONE_PLG_EXPORT_SECRET", "")
    allowed = {
        uid.strip() for uid in os.getenv("ONE_PLG_EXPORT_ACCOUNT_IDS", "").split(",") if uid.strip()
    }
    if (
        os.getenv("ONE_PLG_EXPORT_ENABLED") != "true"
        or current_auth_lane() != "production"
        or len(secret) < 32
        or not 1 <= len(allowed) <= 100
    ):
        raise HTTPException(404, "PLG export unavailable", headers=NO_STORE)
    timestamp = request.headers.get("x-plg-timestamp", "")
    signature = request.headers.get("x-plg-signature", "")
    if (
        not re.fullmatch(r"[0-9]{13}", timestamp)
        or abs(time.time() * 1000 - int(timestamp)) > 300_000
    ):
        raise HTTPException(401, "Invalid integration signature", headers=NO_STORE)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 16_000:
            raise HTTPException(413, "Request too large", headers=NO_STORE)
    expected = hmac.new(
        secret.encode(), f"snapshot\n{timestamp}\n".encode() + body, hashlib.sha256
    ).hexdigest()
    if not re.fullmatch(r"[a-f0-9]{64}", signature) or not hmac.compare_digest(signature, expected):
        raise HTTPException(401, "Invalid integration signature", headers=NO_STORE)
    try:
        payload = PilotRequest.model_validate_json(body)
        result = await asyncio.wait_for(
            snapshot(payload, allowed, datetime.now(timezone.utc)), timeout=25
        )
    except (ValueError, ValidationError):
        # Pydantic's default errors echo input; these account identifiers stay private.
        raise HTTPException(
            400, "Invalid pilot request or result limit exceeded", headers=NO_STORE
        ) from None
    except Exception:
        raise HTTPException(503, "Task evidence unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)
