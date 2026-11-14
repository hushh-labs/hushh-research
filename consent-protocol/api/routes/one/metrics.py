"""Default-closed, signed server-only Metrics aggregate; no owner/content API."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from api.utils.firebase_auth import current_auth_lane
from hushh_mcp.services import metrics_adoption

router = APIRouter(prefix="/api/one/metrics", tags=["Metrics aggregate"])
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


@router.post("/adoption", include_in_schema=False)
async def adoption(request: Request):
    secret = os.environ.get("ONE_METRICS_ADOPTION_SECRET", "")
    if (
        os.environ.get("ONE_METRICS_ADOPTION_ENABLED") != "true"
        or os.environ.get("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
        or current_auth_lane() != "production"
        or not 32 <= len(secret.encode()) <= 256
    ):
        raise HTTPException(404, "Metrics aggregate unavailable", headers=NO_STORE)
    try:
        binding = metrics_adoption.approved_binding()
    except metrics_adoption.AggregateUnavailable:
        raise HTTPException(503, "Metrics aggregate unavailable", headers=NO_STORE) from None
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2000:
            raise HTTPException(413, "Request too large", headers=NO_STORE)
    timestamp = request.headers.get("x-metrics-timestamp", "")
    signature = request.headers.get("x-metrics-signature", "")
    if (
        not re.fullmatch(r"[1-9]\d{12}", timestamp)
        or abs(int(timestamp) - int(time.time() * 1000)) > 60_000
        or not re.fullmatch(r"[a-f0-9]{64}", signature)
        or not hmac.compare_digest(
            signature,
            hmac.new(
                secret.encode(),
                b"metrics-one-aggregate-v1:" + timestamp.encode() + b":" + body,
                hashlib.sha256,
            ).hexdigest(),
        )
    ):
        raise HTTPException(401, "Invalid aggregate signature", headers=NO_STORE)
    try:
        payload = metrics_adoption.AdoptionRequest.model_validate_json(body)
        result = await metrics_adoption.bounded_adoption_aggregate(payload, binding)
    except (ValueError, ValidationError):
        raise HTTPException(400, "Invalid aggregate request", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Metrics aggregate unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)
