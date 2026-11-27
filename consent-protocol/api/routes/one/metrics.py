"""Default-closed, signed server-only Metrics aggregate; no owner/content API."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from api.utils.firebase_auth import current_auth_lane
from hushh_mcp.services import metrics_adoption, metrics_feature_observations

router = APIRouter(prefix="/api/one/metrics", tags=["Metrics aggregate"])
NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


@router.post("/adoption", include_in_schema=False)
async def adoption(request: Request):
    lane = current_auth_lane()
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if (project, lane) == ("hushh-pda", "production"):
        environment, enabled, secret_name = (
            "production",
            "ONE_METRICS_ADOPTION_ENABLED",
            "ONE_METRICS_ADOPTION_SECRET",
        )
        purpose = b"metrics-one-aggregate-v1:"
    elif (project, lane) == ("hushh-pda-uat", "uat"):
        environment, enabled, secret_name = (
            "uat",
            "ONE_METRICS_UAT_ADOPTION_ENABLED",
            "ONE_METRICS_UAT_ADOPTION_SECRET",
        )
        purpose = b"metrics-one-aggregate-uat-v1:"
    else:
        raise HTTPException(404, "Metrics aggregate unavailable", headers=NO_STORE)
    secret = os.environ.get(secret_name, "")
    if os.environ.get(enabled) != "true" or not 32 <= len(secret.encode()) <= 256:
        raise HTTPException(404, "Metrics aggregate unavailable", headers=NO_STORE)
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
                purpose + timestamp.encode() + b":" + body,
                hashlib.sha256,
            ).hexdigest(),
        )
    ):
        raise HTTPException(401, "Invalid aggregate signature", headers=NO_STORE)
    try:
        raw = json.loads(body)
        if isinstance(raw, dict) and raw.get("reportKind") == "feature_observations":
            payload = metrics_feature_observations.FeatureObservationRequest.model_validate(raw)
            binding = metrics_feature_observations.approved_binding(environment)
            result = await metrics_feature_observations.bounded_aggregate(
                payload, binding, environment=environment
            )
        else:
            payload = metrics_adoption.AdoptionRequest.model_validate(raw)
            binding = (
                metrics_adoption.approved_binding(environment)
                if environment == "uat"
                else metrics_adoption.approved_binding()
            )
            result = (
                await metrics_adoption.bounded_adoption_aggregate(
                    payload, binding, environment="uat"
                )
                if environment == "uat"
                else await metrics_adoption.bounded_adoption_aggregate(payload, binding)
            )
    except (ValueError, ValidationError):
        raise HTTPException(400, "Invalid aggregate request", headers=NO_STORE) from None
    except Exception:
        raise HTTPException(503, "Metrics aggregate unavailable", headers=NO_STORE) from None
    return JSONResponse(result, headers=NO_STORE)
