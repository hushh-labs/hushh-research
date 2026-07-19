"""Authenticated, non-persistent runtime-provider checks for Connections."""

from __future__ import annotations

import asyncio
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, SecretStr

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.runtime_providers.factory import build_runtime_client

router = APIRouter(prefix="/api/one/runtime", tags=["One runtime configuration"])

_GEMINI_PROBE_MODEL = "gemini-2.5-flash"
_PROBE_TIMEOUT_SECONDS = 8.0
_VERTEX_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_VERTEX_LOCATION_RE = re.compile(r"^(?:global|[a-z]+-[a-z]+[0-9]+)$")


class GeminiCredentialValidationRequest(BaseModel):
    credential: SecretStr = Field(min_length=1, max_length=12_000)
    transport: Literal["developer_api", "vertex_api_key"] = "developer_api"
    vertex_project: str | None = Field(default=None, max_length=30)
    vertex_location: str | None = Field(default=None, max_length=64)


class GeminiCredentialValidationResponse(BaseModel):
    status: str


def _safe_failure_code(exc: Exception) -> str:
    # Classify without logging or reflecting provider text: it can contain
    # request metadata and must never be associated with a user's secret.
    message = str(exc).lower()
    if any(token in message for token in ("invalid", "api key", "unauth", "permission")):
        return "invalid_key"
    if any(token in message for token in ("quota", "billing", "rate limit", "resource exhausted")):
        return "quota_or_billing"
    if "model" in message and any(
        token in message for token in ("not found", "unsupported", "unavailable")
    ):
        return "unsupported_model"
    return "temporary_unavailable"


@router.post("/gemini/validate", response_model=GeminiCredentialValidationResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def validate_gemini_credential(
    request: Request,
    body: GeminiCredentialValidationRequest,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> GeminiCredentialValidationResponse:
    """Bounded pre-save probe; the credential is never stored server-side."""
    credential = body.credential.get_secret_value()
    project = (body.vertex_project or "").strip()
    location = (body.vertex_location or "").strip()
    if body.transport == "vertex_api_key":
        if not _VERTEX_PROJECT_RE.fullmatch(project) or not _VERTEX_LOCATION_RE.fullmatch(location):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "GEMINI_CREDENTIAL_VALIDATION_FAILED",
                    "status": "invalid_vertex_configuration",
                },
            )
    elif project or location:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GEMINI_CREDENTIAL_VALIDATION_FAILED",
                "status": "invalid_vertex_configuration",
            },
        )
    try:
        client = build_runtime_client(
            "gemini",
            credential,
            gemini_byok_transport=body.transport,
            vertex_project=project or None,
            vertex_location=location or None,
        )
        await asyncio.wait_for(
            asyncio.to_thread(client.models.get, model=_GEMINI_PROBE_MODEL),
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # noqa: BLE001 - preserve a safe public taxonomy
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GEMINI_CREDENTIAL_VALIDATION_FAILED",
                "status": _safe_failure_code(exc),
            },
        ) from None
    finally:
        credential = ""
        project = ""
        location = ""
    return GeminiCredentialValidationResponse(status="ready")
