"""Authenticated, non-persistent runtime-provider checks for Connections."""

from __future__ import annotations

import asyncio
import logging
import os
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
from hushh_mcp.services.user_cloud_service import resolve_user_cloud

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

    THE BYOC EXCEPTION, WHICH IS THE SAME RULE
    ------------------------------------------
    A person with a PROVEN user-owned cloud never touches the fleet binding: their
    pod generates on their own project's Vertex ADC (``user_adc``), so probing
    hushh's fleet identity answers nothing about THEIR runtime -- and couples their
    journey to hushh's billing state (observed 2026-08-20: fleet Vertex in dunning
    denied every BYOC onboarding despite every BYOC pod being unaffected). Their
    validate-then-provision evidence is the authorization proof itself: hushh
    minted a real token against their bootstrap account (a form cannot set it),
    and the first pod turn asserts ``runtimeMode=user_adc`` end-to-end.
    """
    cloud = await resolve_user_cloud(firebase_uid)
    if cloud is not None and cloud.is_user_owned and cloud.is_ready_to_provision:
        verdict = await on_ai_connection_verified(
            user_id=firebase_uid,
            provider="hushh_managed_vertex",
            transport="managed_vertex",
        )
        return ManagedGeminiSelectionResponse(
            status="ready",
            model=_ONE_RUNTIME_MODEL,
            location=(cloud.region or "").strip() or "user-project",
            agentScheduled=bool(verdict.get("scheduled")),
            agentReason=str(verdict.get("reason") or ""),
        )

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

    # THEIR saved cloud outranks the deterministic suggestion. The founder hit
    # the trap this closes: the per-person deterministic name collided with their
    # OWN soft-deleted project, so the field prefills an id Google refuses for 30
    # days while their real, authorized project sat one edit away. A person who
    # has already named a cloud gets THAT name back, always.
    saved = await resolve_user_cloud(firebase_uid)
    if saved is not None and (saved.project or "").strip():
        payload = suggest_project_id(firebase_uid).as_dict()
        payload["projectId"] = saved.project
        payload["rationale"] = "Your saved cloud. Change it only to switch projects."
        return ByocProjectSuggestionResponse(
            **payload,
            creationModes=[CREATION_GUIDED, CREATION_DELEGATED],
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


class ByocProjectSaveRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=64)
    region: str = Field(default="us-central1", max_length=32)
    # Matches BOOTSTRAP_SA_ID in deploy/iam/authorize_byoc_project.sh, which is the
    # artifact a person actually runs. Overridable for anyone who changed it there.
    bootstrapServiceAccountId: str = Field(default="one-bootstrap", max_length=30)


class ByocProjectSaveResponse(BaseModel):
    projectId: str
    region: str
    bootstrapServiceAccount: str
    # Proven, not asserted: True only when hushh just minted a token against their
    # project. A form cannot set this.
    authorized: bool
    # The single value the authorization script cannot run without. Returned on BOTH
    # outcomes, because the unauthorized case is exactly when a person needs it.
    hushhCaller: str
    nextStep: str


def _hushh_caller_identity() -> str:
    """The one hushh identity a person grants serviceAccountTokenCreator to.

    Normalized through `_bare_service_account` rather than read raw, because the same
    principal is spelled two ways across this codebase -- `HUSSH_POD_INVOKER_MEMBER`
    carries an IAM-member `serviceAccount:` prefix and `HUSSH_CONSENT_PLANE_SA` does
    not. Handing a person the prefixed form would have them build
    `serviceAccount:serviceAccount:...`, which IAM rejects with a 400 on every
    setIamPolicy, in their own project, with nothing naming the cause.
    """
    from hushh_mcp.services.user_gcp_backend import _bare_service_account

    # str() because `hushh_mcp.services.*` is excluded from mypy's strict section, so the
    # helper's declared `-> str` arrives here as Any and would silently widen this
    # function's contract.
    return str(_bare_service_account(os.getenv("HUSSH_CONSENT_PLANE_SA", "")))


async def _reserve_pending_agent_record(user_id: str) -> bool:
    """Reserve the pending registry row this person should already have had.

    Reads the verified phone from the identity service exactly as
    ``ai_connection_gate._verified_phone`` and the owner-authorized provision route do:
    the ``phone_verified`` FLAG, never merely the presence of a number, because an
    unverified number would mint a HusshID against a phone nobody proved they hold.

    Returns False when the phone is unverified, which is the one case the caller's 409
    genuinely describes -- so that message becomes true rather than misleading.
    """
    from hushh_mcp.services.actor_identity_service import ActorIdentityService
    from hushh_mcp.services.compute_backend import resolve_compute_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    try:
        identity = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
        if identity.get("phone_verified") is not True:
            return False
        phone = str(identity.get("phone_number") or "").strip()
        if not phone:
            return False
        # The SAME backend the owner-authorized route resolves. Constructing this
        # service without one silently yields NullBackend, and this path must not be
        # the one that quietly disagrees with every other about where a pod lives.
        service = PersonalAgentProvisioningService(
            registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
        )
        await service.register_pending(user_id=user_id, phone_e164=phone)
        return True
    except Exception:  # noqa: BLE001 - a failed reservation is a 409, never a 500
        logger.warning("byoc_project.reserve_pending_failed", exc_info=True)
        return False


@router.post("/byoc/project/save", response_model=ByocProjectSaveResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def save_byoc_project(
    request: Request,
    body: ByocProjectSaveRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> ByocProjectSaveResponse:
    """Record WHICH cloud is this person's, and prove hushh can actually reach it.

    This is the route that ends BYOC's single-tenancy. Until it existed, the target
    project was `os.getenv("HUSSH_USER_GCP_PROJECT")` -- one value for the whole
    deployment -- so the second person to choose their own cloud would have had their
    pod built inside the first person's project.

    IT READS THE GRANT BACK RATHER THAN BELIEVING THE FORM

    A person clicking "I ran the script" is not evidence that they ran it, and the
    failure that follows a wrong answer is expensive and far away: three steps into
    provisioning, inside someone else's cloud, with an error naming none of this. So
    authorization is established the only way it can honestly be established -- by
    minting a short-lived token against their bootstrap account. `mint_bootstrap_token`
    fails loudly rather than falling back to hushh's own identity, which is exactly the
    property being tested here.

    A FAILED PROOF IS NOT AN ERROR

    Naming a cloud before authorizing it is the normal order: a person needs
    `hushhCaller` from this response *in order to* run the script. So an unauthorized
    project is recorded (without the proof) and returned 200 with the next step, rather
    than 4xx. The state "named but not yet authorized" is a real, expected stage of
    onboarding, and provisioning refuses it later rather than silently falling back to
    hushh's cloud.

    IT PROVISIONS NOTHING, like its three siblings above.
    """
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError, mint_bootstrap_token
    from hushh_mcp.services.user_gcp_project import validate_project_id

    verdict = validate_project_id(body.projectId)
    if not verdict.valid:
        raise HTTPException(
            status_code=422, detail={"code": "INVALID_PROJECT_ID", "reason": verdict.reason}
        )

    project = verdict.project_id
    bootstrap_sa = f"{body.bootstrapServiceAccountId}@{project}.iam.gserviceaccount.com"
    hushh_caller = _hushh_caller_identity()

    authorized = False
    try:
        await asyncio.to_thread(mint_bootstrap_token, bootstrap_sa=bootstrap_sa)
        authorized = True
    except BootstrapError:
        logger.info("byoc_project.not_yet_authorized project=%s", project)
    except Exception:  # noqa: BLE001 - an unreachable IAM API is not a failed grant
        logger.info("byoc_project.authorization_probe_unavailable project=%s", project)

    repo = PersonalAgentRegistryRepo()

    async def _attach_cloud() -> bool:
        return bool(
            await repo.set_user_cloud(
                user_id=firebase_uid,
                project=project,
                region=body.region,
                bootstrap_sa=bootstrap_sa,
                authorized=authorized,
                # Named here, not in the registry: the common layer must not be able to
                # name a provider (test_deployment_boundary_holds). This route is the
                # layer that knows a person chose their own cloud, so it is the layer
                # allowed to say so.
                deployment_target="user_gcp",
                model_credential_mode="user_adc",
            )
        )

    wrote = await _attach_cloud()
    if not wrote:
        # `set_user_cloud` is an UPDATE, and the row it updates is written at phone
        # verification ONLY on the legacy trigger. With
        # PERSONAL_AGENT_PROVISION_ON_AI_CONNECTION at its default of True,
        # `schedule_provision_personal_agent` returns before `register_pending` -- its
        # one non-test caller -- so a person who did everything right arrives here with
        # no row. The cloud step then 409s permanently while telling them to re-verify a
        # phone that is already verified, which is a loop that cannot terminate.
        #
        # Reserving here is the smallest correct repair. `register_pending` mints the
        # HusshID and writes a `pending` row; it provisions NOTHING, so validate-then-
        # provision is untouched and a pod still has to be earned by a working AI
        # connection. Doing it on the failure path keeps the common case one query.
        if await _reserve_pending_agent_record(firebase_uid):
            wrote = await _attach_cloud()
    if not wrote:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "NO_AGENT_RECORD",
                "message": (
                    "Verify your phone number first. Your agent's record is created then, "
                    "and this is where your cloud gets attached to it."
                ),
            },
        )

    if authorized:
        # Server-written, never client-asserted. A marker that can exist without a
        # stored, proven project is a gate that does nothing.
        try:
            from hushh_mcp.onboarding_contract import normalize_setup_capability_ids
            from hushh_mcp.services.vault_keys_service import VaultKeysService

            service = VaultKeysService()
            state = await service.get_pre_vault_state(firebase_uid)
            current = list(state.get("setupCapabilityIds") or [])
            if "cloud" not in current:
                await service.update_pre_vault_state(
                    user_id=firebase_uid,
                    setup_capability_ids=normalize_setup_capability_ids([*current, "cloud"]),
                )
        except Exception:  # noqa: BLE001 - the cloud is recorded; the marker can be retried
            logger.warning("byoc_project.marker_write_failed", exc_info=True)

    return ByocProjectSaveResponse(
        projectId=project,
        region=body.region,
        bootstrapServiceAccount=bootstrap_sa,
        authorized=authorized,
        hushhCaller=hushh_caller,
        nextStep=(
            "Your cloud is connected. Choose how your agent reaches a model next."
            if authorized
            else (
                "Run the authorization script in your project, then continue. "
                f"It needs PROJECT_ID={project} and HUSHH_CALLER={hushh_caller}."
            )
        ),
    )


# ---------------------------------------------------------------------------
# ONE-CLICK CLOUD (founder-directed default, 2026-08-20): sign in to Google
# once and the whole cloud step happens — create the project if it does not
# exist (personal account, parentless), link the person's own billing, run the
# script's authorization plan under THEIR transient token, then prove and
# record it through the same save path the manual route uses. The console link
# and the copy-paste script remain as the fallback, not the default.
# ---------------------------------------------------------------------------


class ByocAuthorizeBeginRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=64)


class ByocAuthorizeBeginResponse(BaseModel):
    authUrl: str


class ByocAuthorizeCompleteRequest(BaseModel):
    code: str = Field(min_length=1)
    state: str = Field(min_length=1)
    region: str = Field(default="us-central1", max_length=32)
    bootstrapServiceAccountId: str = Field(default="one-bootstrap", max_length=30)


class ByocSetupAcceptedResponse(BaseModel):
    """The one-click completion is a JOB now; this is its claim ticket."""

    jobId: str
    projectId: str
    status: Literal["running"]


class ByocSetupStatusResponse(BaseModel):
    """The durable stage record, shaped for every surface that shows the truth."""

    status: str
    stage: str
    stages: list[dict]
    projectId: str
    errorCode: str | None = None
    errorMessage: str | None = None
    stale: bool = False
    updatedAt: str | None = None


@router.post("/byoc/authorize/begin", response_model=ByocAuthorizeBeginResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def begin_byoc_authorize(
    request: Request,
    body: ByocAuthorizeBeginRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> ByocAuthorizeBeginResponse:
    """The Google consent URL for the one-click cloud setup.

    The state is signed, expiring and bound to THIS caller; the grant requested
    is online-only (no refresh token exists to store)."""
    from hushh_mcp.services import byoc_oauth_authorizer as oauth
    from hushh_mcp.services.user_gcp_project import validate_project_id

    verdict = validate_project_id(body.projectId)
    if not verdict.valid:
        raise HTTPException(
            status_code=422, detail={"code": "INVALID_PROJECT_ID", "reason": verdict.reason}
        )
    try:
        return ByocAuthorizeBeginResponse(authUrl=oauth.begin(firebase_uid, verdict.project_id))
    except oauth.ByocAuthorizeError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}
        ) from exc


#: Strong references to in-flight setup jobs: asyncio keeps only weak refs to
#: tasks, and a garbage-collected job would die silently mid-chain.
_BYOC_SETUP_TASKS: set = set()

#: Backoff between proof probes while a freshly written IAM grant settles.
#: Deliberately short in total: the whole complete call must finish inside the
#: web client's 60s fetch timeout, chain steps included.
_GRANT_SETTLE_DELAYS_SECONDS: tuple[float, ...] = (2, 4, 8, 15)


async def _wait_for_bootstrap_grant(
    bootstrap_sa: str, *, deadline: float, delays: tuple[float, ...] | None = None
) -> bool:
    """True once the just-written tokenCreator grant answers to a proof mint.

    Google settles a new service-account IAM binding eventually, not instantly:
    the founder's one-click run applied authorization and then failed its proof
    ONE SECOND later (observed 2026-08-21, hussh-one-df5jxz). The one-click
    route knows the grant is brand new, so it alone earns a bounded wait before
    the save's single-attempt proof; the manual flow keeps its single attempt
    because the person returns minutes after running the script.
    """
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError, mint_bootstrap_token

    attempts = 0
    for delay in (0.0, *(delays if delays is not None else _GRANT_SETTLE_DELAYS_SECONDS)):
        if delay:
            if time.monotonic() + delay > deadline:
                break
            await asyncio.sleep(delay)
        attempts += 1
        try:
            await asyncio.to_thread(mint_bootstrap_token, bootstrap_sa=bootstrap_sa)
            logger.info("byoc_oauth.grant_settled sa=%s attempts=%s", bootstrap_sa, attempts)
            return True
        except BootstrapError:
            continue
        except Exception:  # noqa: BLE001 - an unreachable IAM API is not an unsettled grant
            # The save's own probe owns that classification; do not block on it.
            return True
    logger.warning("byoc_oauth.grant_not_settled sa=%s attempts=%s", bootstrap_sa, attempts)
    return False


@router.post("/byoc/authorize/complete", response_model=ByocSetupAcceptedResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def complete_byoc_authorize(
    request: Request,
    body: ByocAuthorizeCompleteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> ByocSetupAcceptedResponse:
    """Everything after the Google consent screen, as an OBSERVABLE JOB.

    The single-use OAuth code is burned synchronously (it cannot wait), then the
    in-memory token is handed to a background task that runs the chain and
    writes one durable stage record per transition. The response is a claim
    ticket, not a verdict: the status route serves the truth from here on, so
    the person can watch, leave, keep onboarding, and come back. The six-stage
    chain squeezed through one HTTP request lost to three stacked timeouts
    (measured live 2026-08-21); no timeout tuning fixes that shape.
    """
    from hushh_mcp.services import byoc_oauth_authorizer as oauth
    from hushh_mcp.services import byoc_setup_job_service as jobs
    from hushh_mcp.services.user_gcp_project import suggest_project_id

    try:
        project = oauth.verify_state(body.state, firebase_uid)
        token = await asyncio.to_thread(oauth.exchange_code, body.code)
    except oauth.ByocAuthorizeError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}
        ) from exc

    suggestion = suggest_project_id(firebase_uid)
    job_id = jobs.new_job_id()
    await jobs.ByocSetupJobRepo().start(user_id=firebase_uid, job_id=job_id, project_id=project)

    async def _save():
        return await save_byoc_project(
            request=request,
            body=ByocProjectSaveRequest(
                projectId=project,
                region=body.region,
                bootstrapServiceAccountId=body.bootstrapServiceAccountId,
            ),
            firebase_uid=firebase_uid,
        )

    task = asyncio.create_task(
        jobs.run_setup_job(
            user_id=firebase_uid,
            job_id=job_id,
            project=project,
            token=token,
            display_name=suggestion.display_name,
            caller_sa=_hushh_caller_identity(),
            bootstrap_account_id=body.bootstrapServiceAccountId,
            ensure_project=oauth.ensure_project,
            ensure_billing=oauth.ensure_billing,
            apply_authorization=oauth.apply_authorization,
            wait_for_grant=_wait_for_bootstrap_grant,
            save=_save,
        )
    )
    _BYOC_SETUP_TASKS.add(task)
    task.add_done_callback(_BYOC_SETUP_TASKS.discard)
    logger.info("byoc_setup_job.accepted user=%s job=%s project=%s", firebase_uid, job_id, project)
    return ByocSetupAcceptedResponse(jobId=job_id, projectId=project, status="running")


@router.get("/byoc/setup/status", response_model=ByocSetupStatusResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def byoc_setup_status(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
) -> ByocSetupStatusResponse:
    """The current truth of the person's cloud setup, for any surface to render.

    `stale` means the record stopped advancing while `running`: the instance
    restarted mid-job. The chain is idempotent, so the honest next move is a
    fresh attempt, and the UI says so instead of spinning forever.
    """
    from hushh_mcp.services import byoc_setup_job_service as jobs

    row = await jobs.ByocSetupJobRepo().get(firebase_uid)
    if not row:
        return ByocSetupStatusResponse(status="none", stage="", stages=[], projectId="")
    return ByocSetupStatusResponse(
        status=str(row.get("status") or ""),
        stage=str(row.get("stage") or ""),
        stages=list(row.get("stages") or []),
        projectId=str(row.get("project_id") or ""),
        errorCode=row.get("error_code"),
        errorMessage=row.get("error_message"),
        stale=jobs.is_stale(row),
        updatedAt=str(row.get("updated_at") or "") or None,
    )
