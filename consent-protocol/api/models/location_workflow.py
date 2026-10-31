"""Shared wire projection for the existing Location workflow and command endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class _CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


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


class LocationCommandBindingResponse(_CamelModel):
    command_id: UUID = Field(alias="commandId")
    command_step: int = Field(alias="commandStep", ge=0, le=11)
    operation_id: str = Field(alias="operationId", pattern=r"^[0-9a-f]{64}$")


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
    command_binding: LocationCommandBindingResponse | None = Field(
        default=None, alias="commandBinding"
    )
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


def location_run_result(payload: dict[str, Any]) -> LocationOnboardingRunResultResponse:
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
        commandBinding=payload.get("command_binding"),
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
