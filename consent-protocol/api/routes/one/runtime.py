"""Authenticated, non-persistent runtime-provider checks for Connections."""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from google.genai import types as genai_types
from pydantic import BaseModel, Field, SecretStr

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.runtime_providers import build_generate_content_config
from hushh_mcp.runtime_providers.factory import (
    ManagedGeminiRuntimeBinding,
    build_runtime_client,
)

router = APIRouter(prefix="/api/one/runtime", tags=["One runtime configuration"])

_ONE_RUNTIME_MODEL = (
    ManifestLoader.load(
        str(Path(__file__).resolve().parents[3] / "hushh_mcp" / "agents" / "one" / "agent.yaml")
    )
    .model_config_for_runtime()
    .name
)
_PROBE_TIMEOUT_SECONDS = 8.0
_VERTEX_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_VERTEX_LOCATION_RE = re.compile(r"^(?:global|us|eu|[a-z]+-[a-z]+[0-9]+)$")


class GeminiCredentialValidationRequest(BaseModel):
    credential: SecretStr = Field(min_length=1, max_length=12_000)
    transport: Literal["developer_api", "vertex_api_key"] = "developer_api"
    vertex_project: str | None = Field(default=None, max_length=30)
    vertex_location: str | None = Field(default=None, max_length=64)


class GeminiCredentialValidationResponse(BaseModel):
    status: Literal["ready"]


class ManagedGeminiReadinessResponse(BaseModel):
    status: Literal["ready"]
    model: str
    location: str | None
    provider: Literal["azure_openai", "vertex"] = "vertex"
    fallback_used: bool = False


_managed_readiness_cache: tuple[float, ManagedGeminiReadinessResponse] | None = None
_managed_readiness_binding: tuple[str, str] | None = None
_MANAGED_READINESS_TTL_SECONDS = 60.0


def _safe_failure_code(exc: Exception) -> str:
    # Classify without logging or reflecting provider text: it can contain
    # request metadata and must never be associated with a user's secret.
    message = str(exc).lower()
    if any(
        token in message
        for token in (
            "quota",
            "rate limit",
            "resource exhausted",
            "resource_exhausted",
            "too many requests",
            "429",
        )
    ):
        return "quota_exhausted"
    if "billing" in message:
        return "billing_required"
    if any(
        token in message
        for token in ("serviceusage", "api has not been used", "api is not enabled")
    ):
        return "api_not_enabled"
    if any(token in message for token in ("permission denied", "forbidden", "403")):
        return "permission_denied"
    if any(token in message for token in ("invalid", "api key", "unauth", "permission")):
        return "invalid_key"
    if "model" in message and any(
        token in message for token in ("not found", "unsupported", "unavailable")
    ):
        return "unsupported_model"
    return "temporary_unavailable"


@router.get("/managed/readiness", response_model=ManagedGeminiReadinessResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def managed_gemini_readiness(
    request: Request,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> ManagedGeminiReadinessResponse:
    """Cached, output-suppressed proof that the attached identity can generate."""
    global _managed_readiness_cache, _managed_readiness_binding
    from hushh_mcp.runtime_providers.managed_text import (
        managed_text_binding,
        managed_text_policy,
        probe_managed_text_model,
    )

    try:
        policy = managed_text_policy()
        cache_binding = ("vertex", "")
        if policy is not None:
            descriptor = managed_text_binding()
            cache_binding = (policy["generation"], descriptor["config_fingerprint"])
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "MANAGED_GEMINI_NOT_READY",
                "status": "temporary_unavailable",
            },
        ) from None
    now = time.monotonic()
    if (
        _managed_readiness_cache
        and _managed_readiness_binding == cache_binding
        and now - _managed_readiness_cache[0] <= _MANAGED_READINESS_TTL_SECONDS
    ):
        return _managed_readiness_cache[1]
    try:
        if policy is not None:
            receipt = await asyncio.wait_for(
                probe_managed_text_model(scope="one_text_chat"),
                timeout=20,
            )
            response = ManagedGeminiReadinessResponse(
                status="ready",
                provider=receipt["provider"],
                model=receipt["model"],
                location=receipt["location"] or None,
                fallback_used=receipt["provider"] != policy["selected_provider"],
            )
            _managed_readiness_cache = (time.monotonic(), response)
            _managed_readiness_binding = cache_binding
            return response
        binding = ManagedGeminiRuntimeBinding.from_environment()
        client = binding.build_direct_client(model=_ONE_RUNTIME_MODEL)
        await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_ONE_RUNTIME_MODEL,
                contents="Reply OK.",
                config=build_generate_content_config(
                    genai_types,
                    _ONE_RUNTIME_MODEL,
                    temperature=0,
                    max_output_tokens=4,
                    thinking_config=genai_types.ThinkingConfig(
                        include_thoughts=False,
                        thinking_level=genai_types.ThinkingLevel.MINIMAL,
                    ),
                    automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(
                        disable=True
                    ),
                ),
            ),
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
        response = ManagedGeminiReadinessResponse(
            status="ready",
            model=_ONE_RUNTIME_MODEL,
            location=binding.primary_location,
        )
        _managed_readiness_cache = (now, response)
        _managed_readiness_binding = cache_binding
        return response
    except Exception as exc:  # noqa: BLE001 - expose only typed readiness evidence
        raise HTTPException(
            status_code=503,
            detail={
                "code": "MANAGED_GEMINI_NOT_READY",
                "status": _safe_failure_code(exc),
            },
        ) from None


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
    if body.transport == "vertex_api_key" and (
        not _VERTEX_PROJECT_RE.fullmatch(project) or not _VERTEX_LOCATION_RE.fullmatch(location)
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GEMINI_CREDENTIAL_VALIDATION_FAILED",
                "status": "invalid_vertex_configuration",
            },
        )
    if body.transport == "developer_api" and (project or location):
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
        # Model discovery alone does not prove that the credential has usable
        # generation quota. Run one bounded, deterministic request so the user
        # cannot confirm a key that is valid syntactically but exhausted,
        # billing-blocked, or unable to serve One. The response content is
        # deliberately ignored and the credential is never persisted here.
        await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_ONE_RUNTIME_MODEL,
                contents="Reply OK.",
                config=build_generate_content_config(
                    genai_types,
                    _ONE_RUNTIME_MODEL,
                    temperature=0,
                    max_output_tokens=4,
                    thinking_config=genai_types.ThinkingConfig(
                        include_thoughts=False,
                        thinking_level=genai_types.ThinkingLevel.MINIMAL,
                    ),
                    automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(
                        disable=True
                    ),
                ),
            ),
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
