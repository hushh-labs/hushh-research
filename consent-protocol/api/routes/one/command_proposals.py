"""Canonical non-Live command proposals; semantic assessment has no effect tools."""

from __future__ import annotations

import hmac
import json
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from google.genai.errors import APIError
from pydantic import Field

from api.middleware import require_vault_owner_token
from api.routes.one.live_context import sanitize_live_context
from hushh_mcp.agents.location.command_brain import LocationCommandBrain
from hushh_mcp.operons.location.capabilities import compile_location_capabilities
from hushh_mcp.operons.location.plan import (
    CommandCapsule,
    CommandValue,
    LocationAssessment,
    LocationCommandStep,
    LocationPlanV1,
    missing_input,
    validate_assessment,
)
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.action_gateway import list_action_gateway_actions
from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict, CommandCheckpointStore
from hushh_mcp.services.location_command_execution import execute_atomic

router = APIRouter(tags=["Agent One"])
_checkpoints = CommandCheckpointStore()
_ledger = ActionDirectiveStore()


class ProposalRequest(CommandValue):
    request_id: UUID
    query: str = Field(min_length=1, max_length=4096)
    context: dict[str, Any]


class TypedProposalRequest(CommandValue):
    request_id: UUID
    action: LocationCommandStep
    context: dict[str, Any]


class TranscriptionRequest(CommandValue):
    audio_base64: str = Field(min_length=64, max_length=2_580_000)


class StepRequest(CommandValue):
    revision: int = Field(ge=1)
    plan: LocationPlanV1
    context: dict[str, Any]
    resource_binding_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    prefer_screen: bool = False


class CheckpointRequest(StepRequest):
    capsule: CommandCapsule
    assessment_token: str | None = None


class ResolveRequest(StepRequest):
    query: str = Field(min_length=1, max_length=8192)


class ClaimRequest(StepRequest):
    confirmation_receipt: str | None = Field(default=None, max_length=128)


class ConfirmationRequest(StepRequest):
    directive_id: str = Field(max_length=128)
    directive_context_revision: str = Field(max_length=256)
    trusted_activation: Literal[True]


class SettlementRequest(CommandValue):
    step: int = Field(ge=0, lt=12)
    operation_id: str = Field(max_length=128)
    execution_receipt: str = Field(max_length=128)
    status: Literal["succeeded", "failed", "review_required"]


def _catalog() -> tuple[str, dict[str, dict[str, Any]]]:
    return cast(
        tuple[str, dict[str, dict[str, Any]]],
        compile_location_capabilities(list_action_gateway_actions()),
    )


def _context(value: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(value)) > 48_000:
        raise HTTPException(413, "Command context is too large.")
    context = sanitize_live_context(value)
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


def _digest(plan: LocationPlanV1) -> str:
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
    revision, catalog = _catalog()
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


async def _assess(query: str, context: dict[str, Any]) -> LocationPlanV1:
    revision, catalog = _catalog()
    try:
        assessment = await LocationCommandBrain().assess(
            query=query, context=context, catalog=catalog
        )
        return validate_assessment(
            assessment,
            catalog,
            capability_revision=revision,
            context_revision=str(context.get("context_revision") or "initial"),
        )
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
    plan = await _assess(payload.query, _context(payload.context))
    return await _create_proposal(user, command, plan)


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
            LocationAssessment(steps=[payload.action]),
            catalog,
            capability_revision=revision,
            context_revision=context["context_revision"],
        )
    except ValueError:
        raise HTTPException(
            422, "This typed Location action or its inputs are not registered."
        ) from None
    return await _create_proposal(user, command, plan)


async def _create_proposal(user: str, command: str, plan: LocationPlanV1):
    state = {
        "status": "awaiting_checkpoint",
        "plan_digest": _digest(plan),
        "capsule": None,
        "next_step": 0,
        "step_count": len(plan.steps),
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
async def get_command(proposal_id: str, token: dict = Depends(require_vault_owner_token)):
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    outcome = await _ledger.command_outcome(
        user_id=user, command_id=proposal_id, step=state["next_step"]
    )
    return {
        "checkpoint": _public(state),
        "outcome": outcome,
        "explicit_resume_required": True,
        "capability_revision": _catalog()[0],
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
    if outcome and outcome["state"] in {"consumed", "settled"}:
        raise HTTPException(
            409, "An admitted step must be completed or reviewed before changing the plan."
        )
    proposed = await _assess(payload.query, _context(payload.context))
    proposed.steps = payload.plan.steps[:index] + proposed.steps
    proposed.gate_step += index
    if len(proposed.steps) > 12:
        raise HTTPException(422, "The command has too many steps.")
    assessment_token = _ledger._hmac([user, proposal_id, state["revision"], _digest(proposed)])
    return {"plan": proposed, "assessment_token": assessment_token}


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
    action = catalog.get(step.action_id) or {"command": {"review_route": "/one/location"}}
    context = _context(payload.context)
    outcome = await _ledger.command_outcome(user_id=user, command_id=proposal_id, step=index)
    if outcome and outcome.get("step_hmac") != state["step_digests"][index]:
        raise HTTPException(409, "The operation does not match this command step. Review Location.")
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
    gate = missing_input(action, step.slots)
    if payload.plan.capability_revision != _catalog()[0]:
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
        )
        return (
            {"status": "simulate", "route": metadata["review_route"], "directive": directive},
            state,
            action,
            context,
        )
    if step.action_id not in context.get("executable_action_ids", []) and not metadata.get(
        "backend_binding"
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
    proposal_id: str, payload: StepRequest, token: dict = Depends(require_vault_owner_token)
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
    if (action.get("command") or {}).get("backend_binding"):
        raise HTTPException(409, "Use the registered backend executor for this action.")
    try:
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
        )
        return {
            **claimed,
            "effect": "screen" if admission["status"] == "simulate" else "action",
            "route": admission.get("route"),
        }
    except ActionDirectiveAuthorityError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/api/one/action-proposals/{proposal_id}/execute")
async def execute(
    proposal_id: str, payload: ClaimRequest, token: dict = Depends(require_vault_owner_token)
):
    user = str(token["user_id"])
    admission, state, action, context = await _admission(user, proposal_id, payload)
    binding = (action.get("command") or {}).get("backend_binding") if action else None
    if admission["status"] not in {"ready", "needs_confirmation"} or not binding:
        raise HTTPException(409, "This action has no admitted backend executor.")
    try:
        await execute_atomic(
            binding=binding,
            authority={
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
            },
        )
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
    if outcome.get("command_effect") == "screen" and payload.status == "succeeded":
        payload.status = "review_required"
    try:
        await _ledger.settle_command(user_id=user, command_id=proposal_id, **payload.model_dump())
    except ActionDirectiveAuthorityError as exc:
        raise HTTPException(409, str(exc)) from None
    if state["next_step"] != payload.step or state["status"] == "cancelled":
        return {"checkpoint": _public(state)}
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
    return {"checkpoint": _public(saved)}


@router.delete("/api/one/action-proposals/{proposal_id}")
async def cancel(proposal_id: str, token: dict = Depends(require_vault_owner_token)):
    user = str(token["user_id"])
    state = await _load(user, proposal_id)
    saved = await _save(user, proposal_id, state, status="cancelled", capsule=None)
    await _ledger.cancel_command(user_id=user, command_id=proposal_id)
    return {"checkpoint": _public(saved)}
