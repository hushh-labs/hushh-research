"""Authenticated, non-persistent runtime-provider checks for Connections."""

from __future__ import annotations

import asyncio
import logging
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
from hushh_mcp.services.ai_connection_gate import on_ai_connection_verified

logger = logging.getLogger(__name__)

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
    location: str


_managed_readiness_cache: tuple[float, ManagedGeminiReadinessResponse] | None = None
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


class ManagedGeminiSelectionResponse(BaseModel):
    status: Literal["ready"]
    model: str
    location: str
    # Whether this selection started the person's private agent. Stated rather than
    # implied: "we are building your agent" and "you are on the shared runtime" are
    # different promises and the UI must be able to tell them apart.
    agentScheduled: bool
    agentReason: str


async def _managed_readiness() -> ManagedGeminiReadinessResponse:
    """Cached, output-suppressed proof that the attached identity can generate."""
    global _managed_readiness_cache
    now = time.monotonic()
    if (
        _managed_readiness_cache
        and now - _managed_readiness_cache[0] <= _MANAGED_READINESS_TTL_SECONDS
    ):
        return _managed_readiness_cache[1]
    return await _probe_managed_gemini()


@router.post("/managed/select", response_model=ManagedGeminiSelectionResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def select_managed_gemini(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
) -> ManagedGeminiSelectionResponse:
    """A person chose the hussh-managed runtime. Verify it, then start their agent.

    THE GAP THIS CLOSES
    -------------------
    Managed is the DEFAULT connection mode, and choosing it used to be an entirely
    client-side act: the webapp wrote the mode into the user's own PKM vault and
    contacted no server route at all. ``GET /managed/readiness`` existed but had zero
    callers anywhere in the webapp. So for the majority of users the server never
    learned an AI connection had been established -- the provisioning gate had
    exactly one caller, the BYOK validate route, and the default onboarding path
    completed with no pod, no error, and nothing anywhere saying so.

    WHY IT PROBES RATHER THAN TAKING THE CLIENT'S WORD
    -------------------------------------------------
    The founder's rule is validate-then-provision, and it has to mean the same thing
    in both modes or it is not a rule. A BYOK key earns a pod by answering a real
    generation request; managed earns one the same way. Accepting "I picked managed"
    as proof would reintroduce exactly the failure the gate exists to prevent -- a
    billable host behind an event that says nothing about whether the agent can think.

    The probe is the same one ``/managed/readiness`` serves, cache included, because
    the managed binding is process-wide: it is the fleet's own identity, so one
    verification genuinely answers for every caller. The gate runs on a cache hit too
    -- it is idempotent by registry status, so the pod decision belongs to the user
    and the probe result belongs to the process.

    A failed probe is a 503 and NO provisioning. That is the honest ordering: a
    person whose runtime cannot generate does not get a host that cannot serve.
    """
    readiness = await _managed_readiness()
    verdict = await on_ai_connection_verified(
        user_id=firebase_uid,
        provider="hushh_managed_vertex",
        transport="managed_vertex",
    )
    return ManagedGeminiSelectionResponse(
        status=readiness.status,
        model=readiness.model,
        location=readiness.location,
        agentScheduled=bool(verdict.get("scheduled")),
        agentReason=str(verdict.get("reason") or ""),
    )


@router.get("/managed/readiness", response_model=ManagedGeminiReadinessResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def managed_gemini_readiness(
    request: Request,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> ManagedGeminiReadinessResponse:
    """Cached, output-suppressed proof that the attached identity can generate."""
    return await _managed_readiness()


async def _probe_managed_gemini() -> ManagedGeminiReadinessResponse:
    global _managed_readiness_cache
    now = time.monotonic()
    try:
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
    # The AI connection just proved itself with a real generation call. THIS is the
    # event that earns a person a pod -- not their login. Provisioning before a key
    # works stands up a billable agent that cannot think; see ai_connection_gate.
    #
    # Fire-and-forget and swallowed by the gate itself: a person testing their API
    # key must never be shown a provisioning error, and the two concerns are
    # unrelated. Idempotent, because this endpoint is a pre-save probe the UI is
    # free to call repeatedly.
    verdict = await on_ai_connection_verified(
        user_id=_firebase_uid, provider="gemini", transport=body.transport
    )
    logger.info("runtime.ai_connection_verified provision=%s", verdict.get("reason"))
    return GeminiCredentialValidationResponse(status="ready")


# --- BYOC: naming and creating the project a person's pod will live in --------------
#
# The frontend asks one question -- "what should we call your cloud?" -- and these three
# routes are behind it. They are deliberately separate from the two connection routes
# above: choosing a runtime is a per-turn credential decision, whereas this creates
# infrastructure a person will own long after they stop using hushh.
#
# None of these provisions a pod. Naming a project is not a working AI connection, so
# `ai_connection_gate` is untouched by them -- the rule that a pod is earned by a
# connection and never by a form still holds.


class ByocProjectSuggestionResponse(BaseModel):
    projectId: str
    displayName: str
    editable: bool
    rationale: str
    creationModes: list[str]


class ByocProjectCheckRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=64)


class ByocProjectCheckResponse(BaseModel):
    projectId: str
    valid: bool
    # Tri-state on purpose: None means "could not determine", which is NOT "taken".
    # Rendering it as unavailable would tell people a free name is used.
    available: bool | None
    reason: str


class ByocProjectPlanRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=64)
    displayName: str = Field(default="", max_length=64)
    parentType: Literal["organization", "folder"] | None = None
    parentId: str = Field(default="", max_length=64)


@router.get("/byoc/project/suggest", response_model=ByocProjectSuggestionResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def suggest_byoc_project(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
) -> ByocProjectSuggestionResponse:
    """The pre-filled, editable name we put in the field.

    Stable for a given person: reload, come back tomorrow, retry a failed creation --
    same name. A suggestion that changed under someone between seeing it and accepting
    it would be a poor thing to do to a person naming infrastructure they will own.
    """
    from hushh_mcp.services.user_gcp_project import (
        CREATION_DELEGATED,
        CREATION_GUIDED,
        suggest_project_id,
    )

    suggestion = suggest_project_id(firebase_uid)
    return ByocProjectSuggestionResponse(
        **suggestion.as_dict(),
        creationModes=[CREATION_GUIDED, CREATION_DELEGATED],
    )


@router.post("/byoc/project/check", response_model=ByocProjectCheckResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def check_byoc_project(
    request: Request,
    body: ByocProjectCheckRequest,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> ByocProjectCheckResponse:
    """Validity now, availability best-effort.

    Validity is Google's own rule set and is decided locally, so a person hears about a
    bad name while typing rather than after committing to it. Availability needs a
    network call and cannot be answered definitively by anyone but Google at creation
    time -- see `check_project_id` for why 403 is reported as "unknown".
    """
    from hushh_mcp.services.user_gcp_project import check_project_id, validate_project_id

    verdict = validate_project_id(body.projectId)
    if verdict.valid:
        try:
            verdict = await asyncio.to_thread(check_project_id, body.projectId)
        except Exception:  # noqa: BLE001 - an unreachable probe is not a validation error
            logger.info("byoc_project.check_probe_unavailable")
    return ByocProjectCheckResponse(**verdict.as_dict())


@router.post("/byoc/project/plan")
@limiter.limit(RateLimits.AGENT_CHAT)
async def plan_byoc_project(
    request: Request,
    body: ByocProjectPlanRequest,
    _firebase_uid: str = Depends(require_firebase_auth),
) -> dict:
    """What creating this project will involve -- WITHOUT creating it.

    Returns the guided instructions always, and, when the person has named a parent,
    the disclosure for the delegated route beside them. Both are returned together on
    purpose: the larger permission should be read next to the alternative that avoids
    it, not discovered after choosing.

    This route creates nothing. Delegated creation is a separate, explicit action.
    """
    from hushh_mcp.services.user_gcp_project import (
        delegated_creation_disclosure,
        guided_creation_instructions,
        validate_project_id,
    )

    verdict = validate_project_id(body.projectId)
    if not verdict.valid:
        raise HTTPException(
            status_code=422, detail={"code": "INVALID_PROJECT_ID", "reason": verdict.reason}
        )

    plan: dict = {
        "guided": guided_creation_instructions(
            project_id=verdict.project_id, display_name=body.displayName
        )
    }
    if body.parentType and body.parentId:
        plan["delegated"] = delegated_creation_disclosure(
            parent_type=body.parentType, parent_id=body.parentId
        )
    else:
        plan["delegated"] = {
            "unavailable": (
                "Tell us which organization or folder to create it in, and we will show "
                "you exactly what that would let hushh do."
            )
        }
    return plan
