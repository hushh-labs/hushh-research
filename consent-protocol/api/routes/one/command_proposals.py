"""Canonical non-Live command proposals; semantic assessment has no effect tools."""

from __future__ import annotations

import hmac
import importlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from google.genai.errors import APIError
from pydantic import Field

from api.middleware import require_vault_owner_token
from api.models.location_workflow import location_run_result
from api.routes.one.agent_context import sanitize_agent_context
from hushh_mcp.agents.location.command_brain import LocationCommandBrain
from hushh_mcp.operons.location.capabilities import compile_location_capabilities
from hushh_mcp.operons.location.plan import (
    CommandCapsule,
    CommandValue,
    LocationAssessment,
    LocationCommandStep,
    LocationCommandStepV2,
    LocationPlan,
    LocationWorkflowStep,
    missing_input,
    validate_assessment,
)
from hushh_mcp.operons.location.references import LocationObservation
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.action_gateway import is_navigation_action, list_action_gateway_actions
from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict, CommandCheckpointStore
from hushh_mcp.services.location_command_continuation import (
    inspect_remaining_command,
    pause_remaining_command,
    renew_remaining_command,
)
from hushh_mcp.services.location_command_effect_receipts import prepare_effect_hmac
from hushh_mcp.services.location_command_execution import execute_atomic
from hushh_mcp.services.location_command_membership_receipts import (
    MembershipPreparation,
    prepare_membership_plan,
)
from hushh_mcp.services.location_command_workflow import (
    WorkflowAlreadyBound,
    cancel_bound_command,
    reconcile_command_workflow,
    start_command_workflow,
    workflow_command_descriptor,
)

router = APIRouter(tags=["Agent One"])
_checkpoints = CommandCheckpointStore()
_ledger = ActionDirectiveStore()


class ProposalRequest(CommandValue):
    plan_version: Literal["location.plan.v1", "location.plan.v2"] = "location.plan.v1"
    request_id: UUID
    query: str = Field(min_length=1, max_length=4096)
    context: dict[str, Any]
    observations: list[LocationObservation] = Field(default_factory=list, max_length=50)


class TypedProposalRequest(CommandValue):
    request_id: UUID
    action: LocationCommandStep
    context: dict[str, Any]


class TranscriptionRequest(CommandValue):
    audio_base64: str = Field(min_length=64, max_length=2_580_000)


class StepRequest(CommandValue):
    revision: int = Field(ge=1)
    plan: LocationPlan
    context: dict[str, Any]
    resource_binding_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    prefer_screen: bool = False


class CheckpointRequest(StepRequest):
    capsule: CommandCapsule
    assessment_token: str | None = None


class ResolveRequest(StepRequest):
    saved_observations: list[LocationObservation] = Field(default_factory=list, max_length=50)
    query: str = Field(min_length=1, max_length=8192)
    observations: list[LocationObservation] = Field(default_factory=list, max_length=50)


class ClaimRequest(StepRequest):
    membership_preparation: MembershipPreparation | None = None
    effect_preparation: MembershipPreparation | None = None
    confirmation_receipt: str | None = Field(default=None, max_length=128)


class ResumeRequest(StepRequest):
    preparation: MembershipPreparation | None = None
    resume_snapshot: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ConfirmationRequest(StepRequest):
    directive_id: str = Field(max_length=128)
    directive_context_revision: str = Field(max_length=256)
    trusted_activation: Literal[True]


class SettlementRequest(CommandValue):
    step: int = Field(ge=0, lt=12)
    operation_id: str = Field(max_length=128)
    execution_receipt: str = Field(max_length=128)
    status: Literal["succeeded", "failed", "review_required"]


def _catalog(plan_version: str = "location.plan.v1") -> tuple[str, dict[str, dict[str, Any]]]:
    workflows = None
    if plan_version == "location.plan.v2":
        from hushh_mcp.services.app_intelligence_runtime import get_service_onboarding_workflow

        workflow = get_service_onboarding_workflow("workflow.setup.location")
        if workflow is None:
            raise HTTPException(503, "Location workflow capabilities are unavailable.")
        workflows = [workflow]
    return cast(
        tuple[str, dict[str, dict[str, Any]]],
        compile_location_capabilities(list_action_gateway_actions(), workflows),
    )


def _context(value: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(value)) > 48_000:
        raise HTTPException(413, "Command context is too large.")
    context = sanitize_agent_context(value)
    # Derive the revision from the sanitized state, rather than trusting a caller label.
    context["context_revision"] = _ledger._hmac(
        {
            key: item
            for key, item in context.items()
            if key not in {"context_revision", "context_id", "voice_state"}
        }
    )
    settings = context.get("voice_settings") or {}
    if settings.get("voice_enabled") is False or "location" in settings.get("disabled_domains", []):
        raise HTTPException(403, "Location commands are disabled in your settings.")
    return context


def _digest(plan: LocationPlan) -> str:
    return str(_ledger._hmac(plan.model_dump(mode="json")))


def _public(state: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value for key, value in state.items() if key not in {"plan_digest", "step_digests"}
    }


async def _load(user: str, command: str) -> dict[str, Any]:
    state = await _checkpoints.get(user, command)
    if state is None:
        raise HTTPException(404, "Command not found or expired.")
    return dict(state)


def _check_plan(
    state: dict[str, Any], payload: StepRequest, *, refresh: bool = False
) -> dict[str, dict[str, Any]]:
    if state["status"] in {"completed", "cancelled", "failed", "review_required"}:
        raise HTTPException(409, "This command is closed.")
    if state["revision"] != payload.revision:
        raise HTTPException(409, "The command changed. Refresh its checkpoint.")
    if not hmac.compare_digest(state["plan_digest"], _digest(payload.plan)):
        raise HTTPException(409, "The submitted plan does not match the checkpoint.")
    revision, catalog = _catalog(payload.plan.schema_version)
    if not refresh and revision != payload.plan.capability_revision:
        raise HTTPException(409, "Location capabilities changed. Review a refreshed plan.")
    return catalog


async def _save(
    user: str,
    command: str,
    state: dict[str, Any],
    *,
    replan_from: int | None = None,
    preserve_admission: bool = False,
    **changes: Any,
) -> dict[str, Any]:
    try:
        saved = await _checkpoints.update(
            user,
            command,
            state["revision"],
            {**state, **changes},
            replan_from=replan_from,
            preserve_admission=preserve_admission,
        )
        return dict(saved)
    except CommandCheckpointConflict as exc:
        raise HTTPException(409, str(exc)) from None


async def _assess(
    query: str,
    context: dict[str, Any],
    plan_version: Literal["location.plan.v1", "location.plan.v2"] = "location.plan.v1",
    *,
    token: dict[str, Any] | None = None,
    completed_steps: list[Any] | None = None,
    observations: list[LocationObservation] | None = None,
    observed: list[dict[str, Any]] | None = None,
    saved_observations: list[LocationObservation] | None = None,
) -> LocationPlan:
    revision, catalog = _catalog(plan_version)
    try:
        from hushh_mcp.hushh_adk.context import HushhContext
        from hushh_mcp.services.location_command_reads import LocationCommandReadService

        if not token or not token.get("user_id") or not token.get("token"):
            raise HTTPException(401, "Location command read authority is required.")
        brain = LocationCommandBrain()
        from hushh_mcp.services.app_intelligence_runtime import get_dynamic_service_knowledge

        service = get_dynamic_service_knowledge("location") or {}
        knowledge = {
            "package": service.get("knowledge_package"),
            "semantic_profile": (service.get("knowledge_projection") or {}).get("semantic_profile"),
            "feature_groups": service.get("feature_groups", []),
        }
        # The authored command roster is separate from the compatibility text
        # tools, some of which mutate. Only scoped, declared read adapters bind.
        read_tools = []
        for path in brain.manifest.capabilities.get("command_read_tools", []):
            module, name = path.rsplit(".", 1)
            if module != "hushh_mcp.agents.location.command_read_tools":
                raise ValueError("A command tool is outside the read-only owner.")
            read_tools.append(getattr(importlib.import_module(module), name))
        reads = LocationCommandReadService(
            user_id=token["user_id"],
            observations=observations,
            saved_observations=saved_observations,
        )
        with HushhContext(
            user_id=token["user_id"],
            consent_token=token["token"],
            service_ports={"location_command_reads": reads},
        ):
            assessment = await brain.assess(
                query=query,
                context={
                    **context,
                    "observations": reads.semantic_observations(),
                    "completed_steps": [
                        {"step_index": index, **step.model_dump()}
                        for index, step in enumerate(completed_steps or [])
                    ],
                },
                catalog=catalog,
                read_tools=read_tools,
                knowledge=knowledge,
            )
        plan = validate_assessment(
            assessment,
            catalog,
            capability_revision=revision,
            context_revision=str(context.get("context_revision") or "initial"),
            plan_version=plan_version,
            completed_steps=completed_steps,
            reference_kinds={key: value["kind"] for key, value in reads.references.items()},
        )
        if observed is not None:
            observed.extend(
                reads.observations(
                    {
                        item.reference
                        for step in plan.steps
                        if isinstance(step, LocationCommandStepV2)
                        for item in step.references
                    }
                )
            )
        return plan
    except (ValueError, TimeoutError):
        raise HTTPException(
            422, "One could not prepare a valid Location plan. Please try again."
        ) from None

    except APIError:
        raise HTTPException(
            503, "Location understanding is temporarily unavailable. Please try again."
        ) from None


@router.post("/api/one/transcriptions")
async def transcribe(
    payload: TranscriptionRequest, token: dict = Depends(require_vault_owner_token)
):
    try:
        return {"transcript": await LocationCommandBrain().transcribe(payload.audio_base64)}
    except (ValueError, TimeoutError):
        raise HTTPException(
            422, "The recording could not be transcribed. Please try again."
        ) from None

    except APIError:
        raise HTTPException(
            503, "Transcription is temporarily unavailable. Please try again."
        ) from None


@router.post("/api/one/agent-chat/proposals")
async def propose(payload: ProposalRequest, token: dict = Depends(require_vault_owner_token)):
    user, command = str(token["user_id"]), str(payload.request_id)
    existing = await _checkpoints.get(user, command)
    if existing:
        return {"checkpoint": _public(existing), "recovery_required": True}
    if await _ledger.command_outcome(user_id=user, command_id=command, step=0):
        raise HTTPException(409, "This command identity was already used. Start a new request.")
    observed: list[dict[str, Any]] = []
    plan = await _assess(
        payload.query,
        _context(payload.context),
        payload.plan_version,
        token=token,
        observations=payload.observations,
        observed=observed,
    )
    return {**await _create_proposal(user, command, plan), "observations": observed}


@router.post("/api/one/agent-chat/proposals/typed")
async def propose_typed(
    payload: TypedProposalRequest, token: dict = Depends(require_vault_owner_token)
):
    """An already typed invocation uses identical validation and effect authority."""
    user, command = str(token["user_id"]), str(payload.request_id)
    existing = await _checkpoints.get(user, command)
    if existing:
        return {"checkpoint": _public(existing), "recovery_required": True}
    if await _ledger.command_outcome(user_id=user, command_id=command, step=0):
        raise HTTPException(409, "This command identity was already used. Start a new request.")
    revision, catalog = _catalog()
    context = _context(payload.context)
    try:
        plan = validate_assessment(
            LocationAssessment(steps=[payload.action.model_dump()]),
            catalog,
            capability_revision=revision,
            context_revision=context["context_revision"],
        )
    except ValueError:
        raise HTTPException(
            422, "This typed Location action or its inputs are not registered."
        ) from None
    return await _create_proposal(user, command, plan)


async def _create_proposal(user: str, command: str, plan: LocationPlan):
    state = {
        "status": "awaiting_checkpoint",
        "plan_digest": _digest(plan),
        "capsule": None,
        "next_step": 0,
        "step_count": len(plan.steps),
        "plan_version": plan.schema_version,
        "step_digests": [_ledger._hmac(step.model_dump()) for step in plan.steps],
        "expires_at": (datetime.now(UTC) + timedelta(hours=24)).isoformat(),
    }
    try:
        checkpoint = await _checkpoints.create(user, command, state)
    except CommandCheckpointConflict as exc:
        raise HTTPException(409, str(exc)) from None
    return {"plan": plan, "checkpoint": _public(checkpoint)}


@router.get("/api/one/action-proposals")
async def list_commands(token: dict = Depends(require_vault_owner_token)):
    states = await _checkpoints.list(str(token["user_id"]))
    return {"commands": [_public(state) for state in states if state.get("capsule")]}


@router.get("/api/one/action-proposals/{proposal_id}")
async def get_command(
    proposal_id: str, response: Response, token: dict = Depends(require_vault_owner_token)
):
    from hushh_mcp.services.location_command_reads import LocationCommandReadService

    response.headers["Cache-Control"] = "private, no-store"
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    outcome = await _ledger.command_outcome(
        user_id=user, command_id=proposal_id, step=state["next_step"]
    )
    results = [
        {key: value for key, value in result.items() if key != "step_hmac"}
        for result in await _ledger.command_results(user_id=user, command_id=proposal_id)
        if 0 <= result["step"] < state["next_step"]
        and result["step_hmac"] == state["step_digests"][result["step"]]
    ]
    observations = await LocationCommandReadService(user_id=user).observe_created_circles(results)
    return {
        "checkpoint": _public(state),
        "outcome": outcome,
        "results": results,
        "observations": observations,
        "explicit_resume_required": True,
        "capability_revision": _catalog(state.get("plan_version", "location.plan.v1"))[0],
    }


@router.post("/api/one/action-proposals/{proposal_id}/resolve")
async def resolve(
    proposal_id: str, payload: ResolveRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    _check_plan(state, payload, refresh=True)
    index = state["next_step"]
    outcome = await _ledger.command_outcome(user_id=user, command_id=proposal_id, step=index)
    if outcome and (outcome["state"] in {"consumed", "settled"} or outcome.get("consumed_at")):
        raise HTTPException(
            409, "An admitted step must be completed or reviewed before changing the plan."
        )
    # Prefix identities were checked against the owner checkpoint above. Verify
    # their outcomes too: a semantic continuation may refer to them, never replay
    # or rewrite them. Dependency indices are global in the assembled plan.
    for prior_index in range(index):
        prior = await _ledger.command_outcome(
            user_id=user, command_id=proposal_id, step=prior_index
        )
        if (
            not prior
            or prior["state"] != "settled"
            or prior.get("settlement_status") != "succeeded"
            or prior.get("step_hmac") != state["step_digests"][prior_index]
        ):
            raise HTTPException(409, "Review the earlier operation before changing this command.")
    pending_handles = {
        item.reference
        for step in payload.plan.steps[index:]
        if isinstance(step, LocationCommandStepV2)
        for item in step.references
    }
    if any(item.reference not in pending_handles for item in payload.saved_observations):
        raise HTTPException(422, "Saved references must belong to this unfinished task.")
    observed: list[dict[str, Any]] = []
    proposed = await _assess(
        payload.query,
        _context(payload.context),
        payload.plan.schema_version,
        token=token,
        completed_steps=payload.plan.steps[:index],
        observations=payload.observations,
        observed=observed,
        saved_observations=payload.saved_observations,
    )
    if len(proposed.steps) > 12:
        raise HTTPException(422, "The command has too many steps.")
    assessment_token = _ledger._hmac([user, proposal_id, state["revision"], _digest(proposed)])
    return {"plan": proposed, "assessment_token": assessment_token, "observations": observed}


@router.put("/api/one/action-proposals/{proposal_id}/checkpoint")
async def checkpoint(
    proposal_id: str, payload: CheckpointRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    if payload.assessment_token:
        expected = _ledger._hmac([user, proposal_id, state["revision"], _digest(payload.plan)])
        if (
            not hmac.compare_digest(expected, payload.assessment_token)
            or state["revision"] != payload.revision
        ):
            raise HTTPException(409, "The assessment expired. Refresh the command.")
        if state["status"] != "ready":
            raise HTTPException(409, "This command cannot be changed.")
    else:
        _check_plan(state, payload)
    state = await _save(
        user,
        proposal_id,
        state,
        status="ready",
        capsule=payload.capsule.model_dump(),
        replan_from=state["next_step"] if payload.assessment_token else None,
        preserve_admission=not bool(payload.assessment_token),
        plan_digest=_digest(payload.plan),
        step_count=len(payload.plan.steps),
        step_digests=[_ledger._hmac(step.model_dump()) for step in payload.plan.steps],
    )
    return {"checkpoint": _public(state)}


async def _admission(user: str, proposal_id: str, payload: StepRequest, *, renew: bool = False):
    state = await _load(user, proposal_id)
    catalog = _check_plan(state, payload, refresh=True)
    if not state.get("capsule") or state["status"] != "ready":
        raise HTTPException(409, "Save an encrypted checkpoint before continuing.")
    index = state["next_step"]
    if index >= len(payload.plan.steps):
        return {"status": "needs_user_gate", "gate": payload.plan.gate}, state, None, None
    step = payload.plan.steps[index]
    workflow_step = isinstance(step, LocationWorkflowStep)
    action = (
        workflow_command_descriptor(catalog.get(step.workflow_id) or {})
        if workflow_step
        else catalog.get(step.action_id) or {"command": {"review_route": "/one/location"}}
    )
    context = _context(payload.context)
    outcome = await _ledger.command_outcome(user_id=user, command_id=proposal_id, step=index)
    if outcome and outcome.get("step_hmac") != state["step_digests"][index]:
        raise HTTPException(409, "The operation does not match this command step. Review Location.")
    if (
        outcome
        and outcome["state"] == "consumed"
        and outcome.get("action_id") == "location.add_to_circle"
    ):
        if await _ledger.reconcile_membership_command(
            user_id=user, command_id=proposal_id, step=index
        ):
            outcome = await _ledger.command_outcome(
                user_id=user, command_id=proposal_id, step=index
            )
    if outcome and outcome["state"] == "consumed" and outcome.get("command_effect") == "workflow":
        result = await reconcile_command_workflow(
            ledger=_ledger,
            user_id=user,
            command_id=proposal_id,
            step=index,
            outcome=outcome,
            resume=renew,
        )
        outcome = await _ledger.command_outcome(user_id=user, command_id=proposal_id, step=index)
        if outcome and outcome["state"] != "settled":
            return (
                {
                    "status": "workflow",
                    "workflow": location_run_result(result),
                    "workflow_finalize_renewed": result.get("finalize_retry_fenced") is True,
                    "checkpoint": _public(state),
                },
                state,
                action,
                context,
            )
    if (
        renew
        and isinstance(payload, ResumeRequest)
        and payload.preparation
        and outcome
        and outcome.get("consumed_at")
        and outcome.get("state") in {"consumed", "issued", "confirmed"}
        and (outcome.get("membership_plan") or outcome.get("audience_plan"))
    ):
        try:
            continuation = inspect_remaining_command(
                _ledger,
                owner=user,
                outcome=outcome,
                preparation=payload.preparation,
                binding_digest=payload.resource_binding_digest or "",
            )
            if not payload.resume_snapshot:
                return (
                    {"status": "resume_preparation_required", "continuation": continuation},
                    state,
                    action,
                    context,
                )
            if (
                payload.plan.capability_revision != _catalog(payload.plan.schema_version)[0]
                or payload.prefer_screen
            ):
                raise ActionDirectiveAuthorityError(
                    "Location capabilities changed. Review the unfinished action."
                )
            if action["action_id"] not in context.get("executable_action_ids", []):
                return (
                    {
                        "status": "needs_user_gate",
                        "gate": {
                            "kind": "navigation",
                            "message": "Open Location to review the remaining operation.",
                            "route": (action.get("command") or {}).get("review_route"),
                        },
                    },
                    state,
                    action,
                    context,
                )
            directive = await renew_remaining_command(
                _ledger,
                owner=user,
                command=proposal_id,
                step=index,
                checkpoint_revision=state["revision"],
                plan_digest=state["plan_digest"],
                action=action,
                context_revision=context["context_revision"],
                preparation=payload.preparation,
                binding_digest=payload.resource_binding_digest or "",
                snapshot=payload.resume_snapshot,
            )
            return (
                {
                    "status": "needs_confirmation"
                    if directive["requires_confirmation"]
                    else "ready",
                    "directive": directive,
                    "continuation": continuation,
                },
                state,
                action,
                context,
            )
        except ActionDirectiveAuthorityError as exc:
            raise HTTPException(409, str(exc)) from None
        except (ValueError, TypeError, KeyError):
            # Bound inputs are transient personal information. Validation
            # errors must not echo their contents or escape as a server error.
            raise HTTPException(
                422, "The saved selection is invalid. Review this Location task."
            ) from None
    if outcome and outcome["state"] in {"consumed", "settled"}:
        if outcome["state"] == "settled":
            next_step = index + 1
            status = (
                "ready"
                if outcome["settlement_status"] == "succeeded"
                else outcome["settlement_status"]
            )
            if status == "ready" and next_step == state["step_count"]:
                status = "completed"
            saved = await _save(
                user,
                proposal_id,
                state,
                next_step=next_step,
                status=status,
                capsule=state["capsule"] if status == "ready" else None,
            )
            return {"status": "advanced", "checkpoint": _public(saved)}, saved, action, context
        return (
            {
                "status": "reconcile",
                "outcome": outcome,
                "review_route": (action.get("command") or {}).get("review_route"),
            },
            state,
            action,
            context,
        )
    dependent_slots = {}
    for dependency in step.dependencies if isinstance(step, LocationCommandStepV2) else []:
        prior = await _ledger.command_outcome(
            user_id=user, command_id=proposal_id, step=dependency.source_step
        )
        expected_kind = (
            (action.get("command") or {}).get("resource_inputs", {}).get(dependency.slot)
        )
        if (
            dependency.source_step >= index
            or not prior
            or prior["state"] != "settled"
            or prior.get("settlement_status") != "succeeded"
            or not prior.get("result_resource_id")
            or prior.get("result_resource_kind") != expected_kind
            or prior.get("step_hmac") != state["step_digests"][dependency.source_step]
        ):
            raise HTTPException(
                409,
                "The earlier operation has no verified resource result. Review it before continuing.",
            )
        dependent_slots[dependency.slot] = "verified_prior_result"
    for reference in step.references if isinstance(step, LocationCommandStepV2) else []:
        # The plan's HMAC binds the selected locator. Only the client preparer
        # can resolve/revalidate it; it supplies no server execution authority.
        if not (action.get("command") or {}).get("resource_inputs", {}).get(reference.slot):
            raise HTTPException(409, "This action no longer accepts the selected reference.")
        dependent_slots[reference.slot] = "requires_client_resource_preparation"
    gate = missing_input(action, {**step.slots, **dependent_slots})
    if payload.plan.capability_revision != _catalog(payload.plan.schema_version)[0]:
        raise HTTPException(409, "Location capabilities changed. Refresh the remaining plan.")
    if gate or (
        index == payload.plan.gate_step
        and payload.plan.gate
        and payload.plan.gate.kind in {"input", "unavailable"}
    ):
        return (
            {"status": "needs_user_gate", "gate": gate or payload.plan.gate},
            state,
            action,
            context,
        )
    if workflow_step:
        directive = await _ledger.issue_command(
            user_id=user,
            command_id=proposal_id,
            step=index,
            action=action,
            slots=step.slots,
            checkpoint_revision=state["revision"],
            plan_digest=state["plan_digest"],
            context_revision=context["context_revision"],
            resource_binding={"digest": payload.resource_binding_digest},
            renew=renew,
            step_identity=step.model_dump(),
        )
        return (
            {"status": "ready", "directive": directive, "workflow_id": step.workflow_id},
            state,
            action,
            context,
        )
    metadata = action.get("command") or {}
    if (
        payload.prefer_screen
        or metadata.get("review_only")
        or action.get("execution_policy") == "manual_only"
    ):
        if not metadata.get("review_route"):
            raise HTTPException(409, "This action has no authored review destination.")
        action = {
            **action,
            "execution_policy": "allow_direct",
            "activation_policy": "none",
            "_command_effect": "screen",
        }
        directive = await _ledger.issue_command(
            user_id=user,
            command_id=proposal_id,
            step=index,
            action=action,
            slots=step.slots,
            checkpoint_revision=state["revision"],
            plan_digest=state["plan_digest"],
            context_revision=str(context.get("context_revision") or "initial"),
            resource_binding={"digest": payload.resource_binding_digest},
            renew=renew,
            step_identity=step.model_dump(),
        )
        return (
            {"status": "simulate", "route": metadata["review_route"], "directive": directive},
            state,
            action,
            context,
        )
    layer = context.get("interaction_layer") or {}
    navigation_blocked = layer.get("lifecycle_state") != "closing" and bool(
        (layer and not layer.get("underlying_actions_available"))
        or layer.get("modality") in {"modal", "blocking"}
        or (layer and layer.get("agent_continuity") != "interactive")
    )
    global_navigation = (
        is_navigation_action(action)
        and action.get("execution_policy") == "allow_direct"
        and (action.get("execution_target") or {}).get("status") == "wired"
        and not navigation_blocked
    )
    if (
        step.action_id not in context.get("executable_action_ids", [])
        and not metadata.get("backend_binding")
        and not global_navigation
    ):
        return (
            {
                "status": "needs_user_gate",
                "gate": {
                    "kind": "navigation",
                    "message": "Open Location to continue.",
                    "route": metadata.get("review_route"),
                },
            },
            state,
            action,
            context,
        )
    directive = await _ledger.issue_command(
        user_id=user,
        command_id=proposal_id,
        step=index,
        action=action,
        slots=step.slots,
        checkpoint_revision=state["revision"],
        plan_digest=state["plan_digest"],
        context_revision=str(context.get("context_revision") or "initial"),
        resource_binding={"digest": payload.resource_binding_digest},
        renew=renew,
        step_identity=step.model_dump(),
    )
    return (
        {
            "status": "needs_confirmation" if directive["requires_confirmation"] else "ready",
            "directive": directive,
            "action": {"action_id": action["action_id"], "label": action["label"]},
        },
        state,
        action,
        context,
    )


@router.post("/api/one/action-proposals/{proposal_id}/admit")
async def admit(
    proposal_id: str, payload: StepRequest, token: dict = Depends(require_vault_owner_token)
):
    admission, _, _, _ = await _admission(str(token["user_id"]), proposal_id, payload)
    return admission


@router.post("/api/one/action-proposals/{proposal_id}/resume")
async def resume(
    proposal_id: str, payload: ResumeRequest, token: dict = Depends(require_vault_owner_token)
):
    admission, _, _, _ = await _admission(str(token["user_id"]), proposal_id, payload, renew=True)
    return admission


@router.post("/api/one/action-proposals/{proposal_id}/confirm")
async def confirm(
    proposal_id: str, payload: ConfirmationRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    admission, _, action, context = await _admission(user, proposal_id, payload)
    if (
        admission["status"] != "needs_confirmation"
        or admission["directive"]["directive_id"] != payload.directive_id
        or admission["directive"]["context_revision"] != payload.directive_context_revision
    ):
        raise HTTPException(409, "The confirmation card is stale.")
    try:
        return await _ledger.confirm(
            directive_id=payload.directive_id,
            user_id=user,
            action_id=action["action_id"],
            context_revision=str(context.get("context_revision") or "initial"),
            session_id=proposal_id,
            trusted_activation=True,
        )
    except ActionDirectiveAuthorityError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/api/one/action-proposals/{proposal_id}/claim")
async def claim(
    proposal_id: str, payload: ClaimRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    admission, state, action, context = await _admission(user, proposal_id, payload)
    if admission["status"] not in {"ready", "needs_confirmation", "simulate"}:
        raise HTTPException(409, "The command is not ready to execute.")
    if action.get("_command_effect") == "workflow" or (action.get("command") or {}).get(
        "backend_binding"
    ):
        raise HTTPException(409, "Use the registered backend executor for this action.")
    try:
        membership_plan = None
        effect_request_hmac = None
        audience_plan = None
        if (action.get("command") or {}).get("client_receipt") and admission[
            "status"
        ] != "simulate":
            if not payload.effect_preparation:
                raise ActionDirectiveAuthorityError(
                    "Prepare the exact Location operation before executing it."
                )
            if action["command"]["client_receipt"] == "location.audience.v1":
                from hushh_mcp.services.location_command_audience_receipts import (
                    prepare_audience_plan,
                )

                audience_plan = prepare_audience_plan(
                    payload.effect_preparation,
                    action=action["action_id"],
                    owner=user,
                    binding_digest=payload.resource_binding_digest,
                )
            else:
                effect_request_hmac = prepare_effect_hmac(
                    payload.effect_preparation,
                    action=action["action_id"],
                    owner=user,
                    binding_digest=payload.resource_binding_digest,
                )
        if action["action_id"] == "location.add_to_circle" and admission["status"] != "simulate":
            expected_circle = None
            step = payload.plan.steps[state["next_step"]]
            for dependency in step.dependencies if isinstance(step, LocationCommandStepV2) else []:
                if dependency.slot == "circle":
                    prior = await _ledger.command_outcome(
                        user_id=user, command_id=proposal_id, step=dependency.source_step
                    )
                    expected_circle = str(prior["result_resource_id"])
            membership_plan = prepare_membership_plan(
                payload.membership_preparation,
                owner=user,
                binding_digest=payload.resource_binding_digest,
                store=_ledger,
                expected_circle_id=expected_circle,
            )
        claimed = await _ledger.claim_command(
            user_id=user,
            command_id=proposal_id,
            step=state["next_step"],
            action=action,
            slots=payload.plan.steps[state["next_step"]].slots,
            checkpoint_revision=state["revision"],
            plan_digest=state["plan_digest"],
            context_revision=str(context.get("context_revision") or "initial"),
            confirmation_receipt=payload.confirmation_receipt,
            resource_binding={"digest": payload.resource_binding_digest},
            membership_plan=membership_plan,
            effect_request_hmac=effect_request_hmac,
            audience_plan=audience_plan,
        )
        return {
            **claimed,
            "effect": "screen" if admission["status"] == "simulate" else "action",
            "route": admission.get("route"),
        }
    except ValueError:
        raise HTTPException(
            422, "The membership preparation is invalid. Review its audience."
        ) from None
    except ActionDirectiveAuthorityError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/api/one/action-proposals/{proposal_id}/execute")
async def execute(
    proposal_id: str, payload: ClaimRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    admission, state, action, context = await _admission(user, proposal_id, payload)
    binding = (action.get("command") or {}).get("backend_binding") if action else None
    workflow_step = bool(action and action.get("_command_effect") == "workflow")
    if admission["status"] not in {"ready", "needs_confirmation"} or not (binding or workflow_step):
        raise HTTPException(409, "This action has no admitted backend executor.")
    try:
        authority = {
            "user_id": user,
            "command_id": proposal_id,
            "step": state["next_step"],
            "action": action,
            "slots": payload.plan.steps[state["next_step"]].slots,
            "context_revision": context["context_revision"],
            "checkpoint_revision": state["revision"],
            "plan_digest": state["plan_digest"],
            "confirmation_receipt": payload.confirmation_receipt,
            "resource_binding": {"digest": payload.resource_binding_digest},
        }
        if workflow_step:
            result = await start_command_workflow(authority=authority)
            if result.get("waiting_reason") == "already_complete":
                advanced, _, _, _ = await _admission(user, proposal_id, payload)
                return advanced
            return {
                "status": "workflow",
                "workflow": location_run_result(result),
                "checkpoint": _public(state),
            }
        await execute_atomic(binding=binding, authority=authority)
    except WorkflowAlreadyBound as exc:
        existing = await _load(user, exc.command_id)
        if not existing.get("capsule"):
            raise HTTPException(
                409, "Location setup already has a run. Refresh its current state."
            ) from None
        await cancel_bound_command(
            user_id=user, command_id=proposal_id, state=state, cipher=_checkpoints.cipher
        )
        return {"status": "recovery_required", "checkpoint": _public(existing)}
    except ActionDirectiveAuthorityError as exc:
        raise HTTPException(409, str(exc)) from None
    except Exception:
        # No exception details: service errors can include personal bound inputs.
        raise HTTPException(409, "Refresh this command to check the operation outcome.") from None
    advanced, _, _, _ = await _admission(user, proposal_id, payload)
    return advanced


@router.post("/api/one/action-proposals/{proposal_id}/settle")
async def settle(
    proposal_id: str, payload: SettlementRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    outcome = await _ledger.command_outcome(user_id=user, command_id=proposal_id, step=payload.step)
    if (
        payload.step >= len(state["step_digests"])
        or not outcome
        or outcome.get("step_hmac") != state["step_digests"][payload.step]
    ):
        raise HTTPException(409, "The operation does not match this command step.")
    if outcome.get("command_effect") == "workflow":
        raise HTTPException(409, "Only the workflow completion receipt can settle this command.")
    verified_membership = False
    verified_effect = bool(
        (
            (outcome.get("effect_request_hmac") and outcome.get("effect_receipt"))
            or outcome.get("audience_plan")
        )
        and outcome.get("state") == "settled"
        and outcome.get("settlement_status") == "succeeded"
    )
    if verified_effect:
        payload.status = "succeeded"
    elif (
        outcome.get("effect_request_hmac") or outcome.get("audience_plan")
    ) and payload.status == "succeeded":
        raise HTTPException(
            409, "The owning service has no verified receipt. Review this operation."
        )
    if outcome.get("action_id") == "location.add_to_circle" and outcome.get("membership_plan"):
        verified_membership = (
            outcome.get("state") == "settled" and outcome.get("settlement_status") == "succeeded"
        ) or await _ledger.reconcile_membership_command(
            user_id=user, command_id=proposal_id, step=payload.step
        )
        if verified_membership:
            # A lost final domain response is not an incomplete operation when
            # the server has every atomic batch receipt for the confirmed plan.
            payload.status = "succeeded"
        elif payload.status == "succeeded":
            raise HTTPException(
                409, "The complete membership audience has no verified result. Review the circle."
            )
    if (
        payload.status != "succeeded"
        and outcome.get("state") == "consumed"
        and (outcome.get("membership_plan") or outcome.get("audience_plan"))
    ):
        if await pause_remaining_command(
            _ledger,
            owner=user,
            command=proposal_id,
            step=payload.step,
            operation=payload.operation_id,
            execution_receipt=payload.execution_receipt,
        ):
            return {
                "checkpoint": _public(state),
                "settlement_status": "review_required",
                "resume_required": True,
                "verified_membership_result": False,
                "verified_effect_result": False,
            }
        # A final receipt or cancellation may have won the session lock.
        outcome = (
            await _ledger.command_outcome(user_id=user, command_id=proposal_id, step=payload.step)
            or outcome
        )
        if outcome.get("state") == "settled" and outcome.get("settlement_status") == "succeeded":
            payload.status = "succeeded"
            verified_effect = bool(outcome.get("audience_plan"))
            verified_membership = bool(outcome.get("membership_plan"))
    if outcome.get("command_effect") == "screen" and payload.status == "succeeded":
        payload.status = "review_required"
    try:
        await _ledger.settle_command(user_id=user, command_id=proposal_id, **payload.model_dump())
    except ActionDirectiveAuthorityError as exc:
        raise HTTPException(409, str(exc)) from None
    if state["next_step"] != payload.step or state["status"] == "cancelled":
        return {
            "checkpoint": _public(state),
            "settlement_status": payload.status,
            "verified_membership_result": verified_membership,
            "verified_effect_result": verified_effect,
        }
    next_step = payload.step + 1
    status: str = "ready" if payload.status == "succeeded" else payload.status
    if next_step == state["step_count"] and status == "ready":
        status = "completed"
    saved = await _save(
        user,
        proposal_id,
        state,
        next_step=next_step,
        status=status,
        capsule=state["capsule"] if status == "ready" else None,
    )
    return {
        "checkpoint": _public(saved),
        "settlement_status": payload.status,
        "verified_membership_result": verified_membership,
        "verified_effect_result": verified_effect,
    }


@router.delete("/api/one/action-proposals/{proposal_id}")
async def cancel(proposal_id: str, token: dict = Depends(require_vault_owner_token)):
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    try:
        saved = await cancel_bound_command(
            user_id=user, command_id=proposal_id, state=state, cipher=_checkpoints.cipher
        )
    except CommandCheckpointConflict as exc:
        raise HTTPException(409, str(exc)) from None
    return {"checkpoint": _public(saved)}
