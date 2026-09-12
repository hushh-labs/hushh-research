"""Narrow HTTPS entrypoint for audited Agent One server-direct capabilities.

The Live tool path is still the normal voice path.  This route exists for
structured system handoffs such as Siri/App Intents, where calling a mounted
browser handler would bypass the CapabilityRun and verified-settlement
contract. It exposes the audited Circle executor plus Location's bounded
start/resume/interaction API; adding another action still requires graph,
executor, and test evidence.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services.capability_run_service import (
    CapabilityRunAuthorityError,
    CapabilityRunConflictError,
)
from hushh_mcp.services.location_circle_direct_executor import (
    get_location_circle_direct_executor,
)
from hushh_mcp.services.location_circle_name_interaction import (
    LocationCircleNameAuthorityError,
    LocationCircleNameConflictError,
    get_location_circle_name_interaction_service,
)
from hushh_mcp.services.location_onboarding_runtime import (
    LOCATION_ONBOARDING_WORKFLOW_VERSION,
    LocationOnboardingAuthorityError,
    LocationOnboardingConflictError,
    get_location_onboarding_runtime_service,
)

router = APIRouter(tags=["Agent One Capability Runtime"])


def _direct_execution_scope(*, user_id: str, action_id: str, invocation_id: str) -> str:
    """Derive a bounded replay scope without persisting transport identifiers.

    The public handoff includes an invocation correlation ID, but the audited
    Circle executor only accepts a server-derived opaque scope. Binding the
    digest to the authenticated owner and fixed capability keeps a lost
    response idempotent without making the client-provided value executable
    authority.
    """

    material = "\x1f".join((user_id, action_id, invocation_id))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


class _CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ServerDirectCapabilityDispatchRequest(_CamelModel):
    """The bounded system-handoff shape, not a general client executor."""

    action_id: Literal["location.create_circle"] = Field(alias="actionId")
    slots: dict[str, str] = Field(default_factory=dict, max_length=12)
    invocation_id: str = Field(alias="invocationId", min_length=1, max_length=96)


class ServerDirectCapabilityDispatchResponse(_CamelModel):
    status: Literal[
        "completed",
        "settling",
        "paused",
        "blocked",
        "failed",
        "input_needed",
        "invalid_slots",
    ]
    action_id: Literal["location.create_circle"] = Field(alias="actionId")
    message: str = Field(max_length=600)
    run_id: str | None = Field(default=None, alias="runId", max_length=96)
    missing_slot: Literal["name"] | None = Field(default=None, alias="missingSlot")


class CircleNameRunResponse(_CamelModel):
    run_id: str = Field(alias="runId", pattern=r"^run_[a-z0-9]{16,96}$")
    revision: int = Field(ge=1)
    graph_revision: str = Field(alias="graphRevision", min_length=1, max_length=128)
    context_revision: str = Field(
        alias="contextRevision", max_length=191, pattern=r"^[A-Za-z0-9_.:-]*$"
    )
    status: Literal["needs_input"]


class CircleNameLeaseResponse(_CamelModel):
    lease_id: str = Field(alias="leaseId", pattern=r"^loccirclelease_[0-9]{10,11}_[0-9a-f]{64}$")
    run_revision: int = Field(alias="runRevision", ge=1)


class CircleNameFieldResponse(_CamelModel):
    field_id: Literal["name"] = Field(alias="fieldId")
    type: Literal["string"]
    required: Literal[True]
    max_length: Literal[80] = Field(alias="maxLength")


class LocationCircleNameDirectiveResponse(_CamelModel):
    schema_version: Literal["one.location_circle_name_interaction.v1"] = Field(
        alias="schemaVersion"
    )
    action_id: Literal["location.create_circle"] = Field(alias="actionId")
    surface_id: Literal["render.form"] = Field(alias="surfaceId")
    form_id: Literal["one.location.create_circle_name.v1"] = Field(alias="formId")
    directive_id: str = Field(alias="directiveId", pattern=r"^loccirclecmd_[0-9a-f]{32}$")
    run: CircleNameRunResponse
    lease: CircleNameLeaseResponse
    expires_at: datetime = Field(alias="expiresAt")
    title_key: Literal["one.location.circle_name.title"] = Field(alias="titleKey")
    body_key: Literal["one.location.circle_name.body"] = Field(alias="bodyKey")
    fields: list[CircleNameFieldResponse] = Field(min_length=1, max_length=1)
    submit_key: Literal["one.location.circle_name.submit"] = Field(alias="submitKey")


class LocationCircleNameSubmitRequest(_CamelModel):
    run_revision: int = Field(alias="runRevision", ge=1)
    directive_id: str = Field(alias="directiveId", pattern=r"^loccirclecmd_[0-9a-f]{32}$")
    lease_id: str = Field(alias="leaseId", pattern=r"^loccirclelease_[0-9]{10,11}_[0-9a-f]{64}$")
    # The value is sent only over the form's leased endpoint, then encrypted
    # in CapabilityRunV1. It never appears in an API response or telemetry.
    name: str = Field(min_length=1, max_length=80)


class CircleNameStatusCardResponse(_CamelModel):
    schema_version: Literal["one.location_command_status_card.v1"] = Field(alias="schemaVersion")
    surface_id: Literal["render.data_card"] = Field(alias="surfaceId")
    card_id: Literal["one.location.command.circle_verified.v1"] = Field(alias="cardId")
    action_id: Literal["location.create_circle"] = Field(alias="actionId")
    settlement: Literal["verified"]


class LocationCircleNameSubmitResponse(_CamelModel):
    schema_version: Literal["one.location_circle_name_submit_result.v1"] = Field(
        alias="schemaVersion"
    )
    status: Literal["verified", "working", "failed"]
    action_id: Literal["location.create_circle"] = Field(alias="actionId")
    run_id: str = Field(alias="runId", pattern=r"^run_[a-z0-9]{16,96}$")
    status_card: CircleNameStatusCardResponse | None = Field(default=None, alias="statusCard")
    reason_code: str | None = Field(default=None, alias="reasonCode", max_length=96)


LocationInteractionResult = Literal[
    "continue",
    "request_permission",
    "permission_granted",
    "permission_denied",
    "permission_restricted",
    "services_disabled",
    "open_settings",
    "settings_returned",
    "retry_permission",
    "position_captured",
    "position_unavailable",
    "retry_position",
    "save_place",
    "skip_place",
    "vault_unavailable",
    "draft_unavailable",
    "retry_circle",
    "retry_completion",
    "open_location",
    "resume",
    "pause",
]


class LocationOnboardingStartRequest(_CamelModel):
    run_id: str | None = Field(default=None, alias="runId", pattern=r"^run_[a-z0-9]{16,96}$")
    context_revision: str | None = Field(
        default=None,
        alias="contextRevision",
        max_length=191,
        pattern=r"^[A-Za-z0-9_.:-]*$",
    )
    guide_mode: Literal["fast", "full_guide"] = Field(default="fast", alias="guideMode")


class LocationOnboardingCancelRequest(_CamelModel):
    """Revision-bound owner cancellation; never a broad fixture reset."""

    expected_revision: int = Field(alias="expectedRevision", ge=1)


class LocationPreVaultDraftMetadataRequest(_CamelModel):
    schema_version: Literal["one.location.pre_vault.draft_metadata.v1"] = Field(
        alias="schemaVersion"
    )
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: Literal["staged"]
    expires_at: datetime = Field(alias="expiresAt")
    run_id: str = Field(alias="runId", pattern=r"^run_[a-z0-9]{16,96}$")
    revision: int = Field(ge=1)


class LocationPositionObservationRequest(_CamelModel):
    """Non-sensitive client observation; never coordinates or attestation."""

    schema_version: Literal["one.location_position_observation.v1"] = Field(alias="schemaVersion")
    permission_status: Literal["granted"] = Field(alias="permissionStatus")
    captured_at: datetime = Field(alias="capturedAt")
    source_platform: Literal["web", "ios", "android", "native"] = Field(alias="sourcePlatform")


class LocationOnboardingInteractionRequest(_CamelModel):
    run_revision: int = Field(alias="runRevision", ge=1)
    lease_id: str = Field(alias="leaseId", pattern=r"^loclease_[a-z0-9]{16,96}$")
    result: LocationInteractionResult
    draft_metadata: LocationPreVaultDraftMetadataRequest | None = Field(
        default=None, alias="draftMetadata"
    )
    position_observation: LocationPositionObservationRequest | None = Field(
        default=None, alias="positionObservation"
    )


class LocationInteractionLeaseResponse(_CamelModel):
    lease_id: str = Field(alias="leaseId")
    run_revision: int = Field(alias="runRevision")


class LocationInteractionDirectiveResponse(_CamelModel):
    schema_version: Literal["one.location_interaction_directive.v1"] = Field(
        default="one.location_interaction_directive.v1", alias="schemaVersion"
    )
    directive_id: str = Field(alias="directiveId")
    contract_id: str = Field(alias="contractId")
    kind: Literal["information", "technical_interaction", "progress", "form", "recovery", "status"]
    surface_id: Literal["render.one_location_workflow_card"] = Field(
        default="render.one_location_workflow_card", alias="surfaceId"
    )
    title_key: str = Field(alias="titleKey")
    body_key: str = Field(alias="bodyKey")
    allowed_results: list[str] = Field(alias="allowedResults", min_length=1, max_length=12)
    expires_at: datetime = Field(alias="expiresAt")
    lease: LocationInteractionLeaseResponse


class LocationEvidenceResponse(_CamelModel):
    permission: bool
    place: bool
    circle: bool
    completion: bool


class LocationDraftResponse(_CamelModel):
    draft_ref: str = Field(alias="draftRef")
    status: Literal["staged"]
    expires_at: datetime = Field(alias="expiresAt")


class LocationPkmFinalizeAuthorizationResponse(_CamelModel):
    """Opaque, bounded, single-use authority; never contains Location values."""

    schema_version: Literal["one.location_pkm_finalize_authorization.v1"] = Field(
        default="one.location_pkm_finalize_authorization.v1", alias="schemaVersion"
    )
    authorization_id: str = Field(alias="authorizationId", pattern=r"^locpkmauth_[a-z0-9]{16,96}$")
    token: str = Field(pattern=r"^locpkmtoken_[a-z0-9]{16,96}_[0-9a-f]{64}$")
    run_id: str = Field(alias="runId", pattern=r"^run_[a-z0-9]{16,96}$")
    run_revision: int = Field(alias="runRevision", ge=1)
    lease_id: str = Field(alias="leaseId", pattern=r"^loclease_[a-z0-9]{16,96}$")
    directive_id: str = Field(alias="directiveId", pattern=r"^locdirective_[a-z0-9]{16,96}$")
    draft_ref: str = Field(alias="draftRef", pattern=r"^locdraft_[a-z0-9]{16,96}$")
    draft_digest: str = Field(alias="draftDigest", pattern=r"^[0-9a-f]{64}$")
    expected_commit_id: UUID = Field(alias="expectedCommitId")
    expires_at: datetime = Field(alias="expiresAt")


class LocationRunProjectionResponse(_CamelModel):
    schema_version: Literal["one.location_run_projection.v1"] = Field(
        default="one.location_run_projection.v1", alias="schemaVersion"
    )
    workflow_id: Literal["workflow.setup.location"] = Field(alias="workflowId")
    workflow_version: int = Field(alias="workflowVersion", ge=1)
    graph_revision: str = Field(alias="graphRevision", min_length=1, max_length=128)
    run_id: str = Field(alias="runId")
    revision: int = Field(ge=1)
    status: Literal[
        "proposed",
        "needs_input",
        "entity_choice",
        "interaction_required",
        "confirmation_required",
        "authorized",
        "executing",
        "settlement_received",
        "verified_succeeded",
        "verified_failed",
        "paused",
        "cancelled",
        "expired",
    ]
    cursor: Literal[
        "location.onboarding.preflight",
        "location.onboarding.introduction",
        "location.onboarding.permission",
        "location.onboarding.position",
        "location.onboarding.place",
        "location.onboarding.circle",
        "location.onboarding.complete",
    ]
    completion_claim_allowed: bool = Field(alias="completionClaimAllowed")
    pending_directive: LocationInteractionDirectiveResponse | None = Field(
        default=None, alias="pendingDirective"
    )
    evidence: LocationEvidenceResponse
    draft: LocationDraftResponse | None = None
    pkm_finalize_authorization: LocationPkmFinalizeAuthorizationResponse | None = Field(
        default=None, alias="pkmFinalizeAuthorization"
    )


class LocationOnboardingRunResultResponse(_CamelModel):
    schema_version: Literal["one.location_onboarding_run_result.v1"] = Field(
        default="one.location_onboarding_run_result.v1", alias="schemaVersion"
    )
    run: LocationRunProjectionResponse
    directive: LocationInteractionDirectiveResponse | None
    waiting_reason: str | None = Field(default=None, alias="waitingReason", max_length=96)


@dataclass(frozen=True)
class _LocationWorkflowRevisionPolicy:
    current_revision: str
    compatible_revisions: tuple[str, ...]
    migration_required_revisions: tuple[str, ...]
    rejected_revisions: tuple[str, ...]


def _current_location_workflow_revision_policy() -> _LocationWorkflowRevisionPolicy:
    """Resolve the generated workflow-specific policy for pinned runs."""

    from hushh_mcp.services.app_intelligence_runtime import (
        get_capability_workflow_revision_policy,
    )

    policy = get_capability_workflow_revision_policy("workflow.setup.location")
    if policy.workflow_version != LOCATION_ONBOARDING_WORKFLOW_VERSION:
        raise RuntimeError("Location capability graph is unavailable.")
    return _LocationWorkflowRevisionPolicy(
        current_revision=policy.current_revision,
        compatible_revisions=policy.compatible_revisions,
        migration_required_revisions=policy.migration_required_revisions,
        rejected_revisions=policy.rejected_revisions,
    )


def _current_capability_graph_revision() -> str:
    """Compatibility accessor for callers that only need new-run identity."""

    return _current_location_workflow_revision_policy().current_revision


def _location_result(payload: dict[str, Any]) -> LocationOnboardingRunResultResponse:
    raw_interaction = payload.get("interaction")
    directive: LocationInteractionDirectiveResponse | None = None
    if isinstance(raw_interaction, dict):
        directive = LocationInteractionDirectiveResponse(
            directiveId=str(raw_interaction["directive_id"]),
            contractId=str(raw_interaction["surface_id"]),
            kind=raw_interaction["kind"],
            titleKey=str(raw_interaction["title_key"]),
            bodyKey=str(raw_interaction["body_key"]),
            allowedResults=list(raw_interaction["allowed_actions"]),
            expiresAt=raw_interaction["expires_at"],
            lease=LocationInteractionLeaseResponse(
                leaseId=str(raw_interaction["lease_id"]),
                runRevision=int(raw_interaction["run_revision"]),
            ),
        )
    raw_draft = payload.get("draft")
    draft = (
        LocationDraftResponse(
            draftRef=str(raw_draft["draft_ref"]),
            status=raw_draft["status"],
            expiresAt=raw_draft["expires_at"],
        )
        if isinstance(raw_draft, dict)
        else None
    )
    raw_finalize_authorization = payload.get("pkm_finalize_authorization")
    finalize_authorization = (
        LocationPkmFinalizeAuthorizationResponse(
            authorizationId=str(raw_finalize_authorization["authorization_id"]),
            token=str(raw_finalize_authorization["token"]),
            runId=str(raw_finalize_authorization["run_id"]),
            runRevision=int(raw_finalize_authorization["run_revision"]),
            leaseId=str(raw_finalize_authorization["lease_id"]),
            directiveId=str(raw_finalize_authorization["directive_id"]),
            draftRef=str(raw_finalize_authorization["draft_ref"]),
            draftDigest=str(raw_finalize_authorization["draft_digest"]),
            expectedCommitId=raw_finalize_authorization["expected_commit_id"],
            expiresAt=raw_finalize_authorization["expires_at"],
        )
        if isinstance(raw_finalize_authorization, dict)
        else None
    )
    run = LocationRunProjectionResponse(
        workflowId=payload["workflow_id"],
        workflowVersion=int(payload["workflow_version"]),
        graphRevision=str(payload["graph_revision"]),
        runId=str(payload["run_id"]),
        revision=int(payload["revision"]),
        status=payload["status"],
        cursor=payload["step"],
        completionClaimAllowed=bool(payload["completion_claim_allowed"]),
        pendingDirective=directive,
        evidence=LocationEvidenceResponse(**dict(payload["evidence"])),
        draft=draft,
        pkmFinalizeAuthorization=finalize_authorization,
    )
    return LocationOnboardingRunResultResponse(
        run=run,
        directive=directive,
        waitingReason=payload.get("waiting_reason"),
    )


def _location_http_error(exc: Exception) -> HTTPException:
    if isinstance(
        exc,
        (
            LocationOnboardingConflictError,
            CapabilityRunConflictError,
        ),
    ):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Location setup changed. Resume it before continuing.",
        )
    if isinstance(exc, (LocationOnboardingAuthorityError, CapabilityRunAuthorityError)):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location setup task is unavailable.",
        )
    if isinstance(exc, ValueError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Location setup input is invalid.",
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Agent One could not safely continue Location setup. Try again.",
    )


def _circle_name_http_error(exc: Exception) -> HTTPException:
    """Map the leased form's authority failures without reflecting details."""

    if isinstance(exc, LocationCircleNameConflictError):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That Circle name request changed. Start it again.",
        )
    if isinstance(exc, LocationCircleNameAuthorityError):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That Circle name request is unavailable.",
        )
    if isinstance(exc, ValueError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Circle name input is invalid.",
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Agent One could not safely continue the Circle request. Try again.",
    )


@router.post(
    "/api/one/workflows/location/onboarding/runs",
    response_model=LocationOnboardingRunResultResponse,
    response_model_by_alias=True,
)
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def start_or_resume_location_onboarding_run(
    request: Request,
    payload: LocationOnboardingStartRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
) -> LocationOnboardingRunResultResponse:
    """Start or resume the signed-in owner's pre-vault-safe Location task."""

    del request
    response.headers["Cache-Control"] = "private, no-store"
    try:
        graph_policy = _current_location_workflow_revision_policy()
        result = await get_location_onboarding_runtime_service().start_or_resume(
            user_id=firebase_uid,
            graph_revision=graph_policy.current_revision,
            run_id=payload.run_id,
            context_revision=payload.context_revision or "",
            full_guide_requested=payload.guide_mode == "full_guide",
            compatible_graph_revisions=graph_policy.compatible_revisions,
            migration_required_graph_revisions=(graph_policy.migration_required_revisions),
            rejected_graph_revisions=graph_policy.rejected_revisions,
        )
        return _location_result(result)
    except Exception as exc:  # noqa: BLE001 - bounded public errors only
        raise _location_http_error(exc) from None


@router.get(
    "/api/one/workflows/location/onboarding/runs/active",
    response_model=LocationOnboardingRunResultResponse,
    response_model_by_alias=True,
    responses={204: {"description": "No active Location onboarding run."}},
)
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def find_active_location_onboarding_run(
    request: Request,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
) -> Any:
    """Recover the owner's active task, migrating a declared v1 cursor if needed."""

    del request
    response.headers["Cache-Control"] = "private, no-store"
    try:
        graph_policy = _current_location_workflow_revision_policy()
        result = await get_location_onboarding_runtime_service().find_active(
            user_id=firebase_uid,
            graph_revision=graph_policy.current_revision,
            compatible_graph_revisions=graph_policy.compatible_revisions,
            migration_required_graph_revisions=(graph_policy.migration_required_revisions),
            rejected_graph_revisions=graph_policy.rejected_revisions,
        )
        if result is None:
            return Response(
                status_code=status.HTTP_204_NO_CONTENT,
                headers={"Cache-Control": "private, no-store"},
            )
        return _location_result(result)
    except Exception as exc:  # noqa: BLE001 - bounded public errors only
        raise _location_http_error(exc) from None


@router.get(
    "/api/one/workflows/location/onboarding/runs/{run_id}",
    response_model=LocationOnboardingRunResultResponse,
    response_model_by_alias=True,
)
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def get_location_onboarding_run(
    request: Request,
    run_id: Annotated[str, Path(pattern=r"^run_[a-z0-9]{16,96}$", max_length=100)],
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
) -> LocationOnboardingRunResultResponse:
    """Read one owner-scoped durable task and its active server directive."""

    del request
    response.headers["Cache-Control"] = "private, no-store"
    try:
        graph_policy = _current_location_workflow_revision_policy()
        result = await get_location_onboarding_runtime_service().get(
            user_id=firebase_uid,
            run_id=run_id,
            graph_revision=graph_policy.current_revision,
            compatible_graph_revisions=graph_policy.compatible_revisions,
            migration_required_graph_revisions=(graph_policy.migration_required_revisions),
            rejected_graph_revisions=graph_policy.rejected_revisions,
        )
        return _location_result(result)
    except Exception as exc:  # noqa: BLE001 - bounded public errors only
        raise _location_http_error(exc) from None


@router.post(
    "/api/one/workflows/location/onboarding/runs/{run_id}/cancel",
    response_model=LocationOnboardingRunResultResponse,
    response_model_by_alias=True,
)
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def cancel_location_onboarding_run(
    request: Request,
    run_id: Annotated[str, Path(pattern=r"^run_[a-z0-9]{16,96}$", max_length=100)],
    payload: LocationOnboardingCancelRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
) -> LocationOnboardingRunResultResponse:
    """Cancel exactly one owned run at its expected revision.

    This endpoint exists for explicit cancellation and repeatable protected
    device tests. It delegates all authority and draft-metadata cleanup to the
    runtime; it cannot reset another owner or manufacture workflow evidence.
    """

    del request
    response.headers["Cache-Control"] = "private, no-store"
    try:
        result = await get_location_onboarding_runtime_service().cancel(
            user_id=firebase_uid,
            run_id=run_id,
            expected_revision=payload.expected_revision,
        )
        return _location_result(result)
    except Exception as exc:  # noqa: BLE001 - bounded public errors only
        raise _location_http_error(exc) from None


@router.post(
    "/api/one/workflows/location/onboarding/runs/{run_id}/interactions/{directive_id}",
    response_model=LocationOnboardingRunResultResponse,
    response_model_by_alias=True,
)
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def settle_location_onboarding_interaction(
    request: Request,
    run_id: Annotated[str, Path(pattern=r"^run_[a-z0-9]{16,96}$", max_length=100)],
    directive_id: Annotated[
        str,
        Path(pattern=r"^locdirective_[a-z0-9]{16,96}$", max_length=109),
    ],
    payload: LocationOnboardingInteractionRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
) -> LocationOnboardingRunResultResponse:
    """Consume one run/revision-bound interaction lease exactly once."""

    del request
    response.headers["Cache-Control"] = "private, no-store"
    try:
        graph_policy = _current_location_workflow_revision_policy()
        draft_metadata = (
            payload.draft_metadata.model_dump(by_alias=True, mode="json")
            if payload.draft_metadata is not None
            else None
        )
        position_observation = (
            payload.position_observation.model_dump(by_alias=True, mode="json")
            if payload.position_observation is not None
            else None
        )
        result = await get_location_onboarding_runtime_service().settle_interaction(
            user_id=firebase_uid,
            run_id=run_id,
            directive_id=directive_id,
            lease_id=payload.lease_id,
            expected_revision=payload.run_revision,
            graph_revision=graph_policy.current_revision,
            action=payload.result,
            draft_metadata=draft_metadata,
            position_observation=position_observation,
            compatible_graph_revisions=graph_policy.compatible_revisions,
            migration_required_graph_revisions=(graph_policy.migration_required_revisions),
            rejected_graph_revisions=graph_policy.rejected_revisions,
        )
        return _location_result(result)
    except Exception as exc:  # noqa: BLE001 - bounded public errors only
        raise _location_http_error(exc) from None


@router.get(
    "/api/one/commands/location/circle-name/active",
    response_model=LocationCircleNameDirectiveResponse,
    response_model_by_alias=True,
    responses={204: {"description": "No active Circle-name form."}},
)
@limiter.limit(RateLimits.ONE_LOCATION_MAPS_PROVIDER)
async def find_active_location_circle_name_form(
    request: Request,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
) -> Any:
    """Recover only a server-issued, still-valid Circle-name form.

    This is not an action endpoint. It lets an app restart restore the same
    durable form lease instead of rebuilding a client-local prompt.
    """

    del request
    response.headers["Cache-Control"] = "private, no-store"
    owner = str(token_data.get("user_id") or "").strip()
    if not owner:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Agent One could not verify the signed-in owner.",
        )
    try:
        directive = await get_location_circle_name_interaction_service().find_active(user_id=owner)
        if directive is None:
            return Response(
                status_code=status.HTTP_204_NO_CONTENT,
                headers={"Cache-Control": "private, no-store"},
            )
        return LocationCircleNameDirectiveResponse.model_validate(directive.wire_projection())
    except Exception as exc:  # noqa: BLE001 - only typed public failure categories
        raise _circle_name_http_error(exc) from None


@router.post(
    "/api/one/commands/location/circle-name/{run_id}/submit",
    response_model=LocationCircleNameSubmitResponse,
    response_model_by_alias=True,
)
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
async def submit_location_circle_name_form(
    request: Request,
    run_id: Annotated[str, Path(pattern=r"^run_[a-z0-9]{16,96}$", max_length=100)],
    payload: LocationCircleNameSubmitRequest,
    response: Response,
    token_data: dict = Depends(require_vault_owner_token),
) -> LocationCircleNameSubmitResponse:
    """Consume one revision/lease-bound name form and resume its exact run.

    This is intentionally a dedicated typed interaction settlement, not the
    public Siri/system direct-dispatch route and not a client-selected action.
    The backend repeats owner-token validation inside the audited adapter.
    """

    del request
    response.headers["Cache-Control"] = "private, no-store"
    owner = str(token_data.get("user_id") or "").strip()
    vault_owner_token = str(token_data.get("token") or "").strip()
    if not owner or not vault_owner_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Agent One could not verify the signed-in owner.",
        )
    try:
        result = await get_location_circle_name_interaction_service().submit(
            user_id=owner,
            vault_owner_token=vault_owner_token,
            run_id=run_id,
            expected_revision=payload.run_revision,
            directive_id=payload.directive_id,
            lease_id=payload.lease_id,
            name=payload.name,
        )
        return LocationCircleNameSubmitResponse.model_validate(result.wire_projection())
    except Exception as exc:  # noqa: BLE001 - never reflect name/adapter/backend details
        raise _circle_name_http_error(exc) from None


@router.post(
    "/api/one/capabilities/execute",
    response_model=ServerDirectCapabilityDispatchResponse,
    response_model_by_alias=True,
)
@limiter.limit(RateLimits.ONE_LOCATION_CIRCLE_MUTATION)
async def dispatch_server_direct_capability_route(
    request: Request,
    payload: ServerDirectCapabilityDispatchRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> ServerDirectCapabilityDispatchResponse:
    """Dispatch one server-owned capability from Siri or a trusted app handoff.

    The authenticated token determines the owner; a caller cannot provide a
    user id, route, graph revision, or execution target.  The runtime repeats
    token validation before mutation and returns only typed terminal/task
    state, never Circle details or raw backend errors.
    """

    del request
    user_id = str(token_data.get("user_id") or "").strip()
    vault_owner_token = str(token_data.get("token") or "").strip()
    if not user_id or not vault_owner_token:
        # This should be unreachable after the dependency, but preserving a
        # typed failure makes a misconfigured proxy fail closed rather than
        # allowing the direct executor to infer identity from client data.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Agent One could not verify the signed-in owner.",
        )
    name = payload.slots.get("name")
    if name is None or not name.strip():
        return ServerDirectCapabilityDispatchResponse(
            status="input_needed",
            actionId=payload.action_id,
            message="What should I call the new Circle?",
            runId=None,
            missingSlot="name",
        )

    try:
        # The old generic ADK dispatcher no longer exists. This endpoint is
        # intentionally still narrow: its one registered action must use the
        # same run-bound executor, authorization check, idempotency boundary,
        # and settlement readback as the transcript-first command runtime.
        result = await get_location_circle_direct_executor().execute(
            user_id=user_id,
            vault_owner_token=vault_owner_token,
            name=name,
            execution_scope=_direct_execution_scope(
                user_id=user_id,
                action_id=payload.action_id,
                invocation_id=payload.invocation_id,
            ),
        )
    except Exception:  # noqa: BLE001 - never reflect service/provider details to Siri
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent One could not safely run that action. Try again in a moment.",
        ) from None

    if result.status == "completed":
        message = "Circle is ready."
    elif result.status == "settling":
        message = "Circle creation is still being verified."
    elif result.status == "paused":
        message = "Circle creation needs an approved interaction before it can continue."
    elif result.status == "blocked":
        message = "Agent One could not verify the authorization needed to create a Circle."
    elif result.status == "invalid_slots":
        message = "Enter a valid Circle name."
    else:
        message = "Agent One could not safely run that action."

    return ServerDirectCapabilityDispatchResponse(
        status=result.status,
        actionId=payload.action_id,
        message=message,
        runId=result.run_id,
        missingSlot=None,
    )


__all__ = [
    "LocationCircleNameDirectiveResponse",
    "LocationCircleNameSubmitRequest",
    "LocationCircleNameSubmitResponse",
    "LocationOnboardingCancelRequest",
    "ServerDirectCapabilityDispatchRequest",
    "ServerDirectCapabilityDispatchResponse",
    "cancel_location_onboarding_run",
    "dispatch_server_direct_capability_route",
    "find_active_location_circle_name_form",
    "router",
    "submit_location_circle_name_form",
]
