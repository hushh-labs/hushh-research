"""Voice and typed command proposals validated and checkpointed in the owner's agent.

For a Shared owner the app sends the hub the command's semantic plan and the screen
it came from (``/api/one/agent-chat/proposals``), and the hub validates, checkpoints
and authorizes every step. For an owner whose agent runs in their own cloud that is
content reaching the hub. Here the agent does the same validation with the hub's
own code (``command_proposals._proposal_plan`` and ``validate_assessment`` against
the same capability catalog) and holds the checkpoint itself
(``PodCommandCheckpointStore``). The app then performs each step with the typed
effect a button tap sends (action, slots, context revision) and reports the outcome
back here. The hub never receives the query, the transcript, the screen or the plan.

Routes, included into ``pod_agent_chat.router`` (``/api/one/pod/agent-chat``):

* ``POST /proposals``: a semantic result from this pod's ``/commands/assess``.
  A raw ``query`` is refused: assessing it here would need the hub's reads.
* ``POST /proposals/typed``: one already typed action.
* ``GET /proposals/{id}``, ``POST /proposals/{id}/settle``, ``DELETE /proposals/{id}``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from api.routes.external_connectors import PrivateConnectorRoute
from api.routes.one.agent_context import sanitize_agent_context
from api.routes.one.command_proposals import (
    SemanticInputRequest,
    TypedProposalRequest,
    _proposal_plan,
)
from api.routes.one.pod_chat_owner import owner_context
from hushh_mcp.one_adk.pod_agui_context import PodChatContext
from hushh_mcp.operons.location.plan import (
    CommandValue,
    LocationAssessment,
    LocationPlan,
    validate_assessment,
)
from hushh_mcp.operons.location.references import LocationObservation
from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict
from hushh_mcp.services.pod_command_checkpoints import PodCommandCheckpointStore

router = APIRouter(prefix="/proposals", route_class=PrivateConnectorRoute)
store = PodCommandCheckpointStore()
# Digests are compared only inside this process, against this process's own store.
_KEY = secrets.token_bytes(32)
_CLOSED = {"completed", "cancelled", "failed", "review_required"}
_HIDDEN = {"plan", "plan_digest"}


class PodProposalRequest(SemanticInputRequest):
    plan_version: Literal["location.plan.v1", "location.plan.v2"] = "location.plan.v2"
    request_id: UUID
    context: dict[str, Any]
    observations: list[LocationObservation] = Field(default_factory=list, max_length=50)


class PodSettlementRequest(CommandValue):
    revision: int = Field(ge=1)
    step: int = Field(ge=0, lt=12)
    status: Literal["succeeded", "failed", "review_required"]


def _digest(value: Any) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hmac.new(_KEY, canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def pod_command_context(value: dict[str, Any]) -> dict[str, Any]:
    """The hub's ``_context`` rules, with this process's own revision key."""
    if len(json.dumps(value)) > 48_000:
        raise HTTPException(413, "Command context is too large.")
    context = sanitize_agent_context(value)
    context["context_revision"] = _digest(
        {
            k: v
            for k, v in context.items()
            if k not in {"context_revision", "context_id", "voice_state"}
        }
    )
    settings = context.get("voice_settings") or {}
    if settings.get("voice_enabled") is False or "location" in settings.get("disabled_domains", []):
        raise HTTPException(403, "Location commands are disabled in your settings.")
    return context


def _public(state: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key not in _HIDDEN}


async def _existing(owner: str, command: str) -> dict[str, Any] | None:
    found = await store.get(owner, command)
    return {"checkpoint": _public(found), "recovery_required": True} if found else None


async def _create(owner: str, command: str, plan: LocationPlan) -> dict[str, Any]:
    dumped = plan.model_dump(mode="json")
    state = {
        "status": "ready",
        "plan": dumped,
        "plan_digest": _digest(dumped),
        "capsule": None,
        "next_step": 0,
        "step_count": len(plan.steps),
        "plan_version": plan.schema_version,
        "expires_at": (datetime.now(UTC) + timedelta(hours=24)).isoformat(),
    }
    try:
        checkpoint = await store.create(owner, command, state)
    except CommandCheckpointConflict as exc:
        raise HTTPException(409, str(exc)) from None
    return {"plan": plan, "checkpoint": _public(checkpoint)}


@router.post("")
async def propose(payload: PodProposalRequest, owner: PodChatContext = Depends(owner_context)):
    command = str(payload.request_id)
    if existing := await _existing(owner.owner, command):
        return existing
    if payload.semantic is None:
        raise HTTPException(422, detail={"code": "COMMAND_SEMANTIC_REQUIRED"})
    observed: list[dict[str, Any]] = []
    plan = await _proposal_plan(
        payload,
        pod_command_context(payload.context),
        payload.plan_version,
        token={"user_id": owner.owner},
        observed=observed,
        observations=payload.observations,
    )
    return {**await _create(owner.owner, command, plan), "observations": observed}


@router.post("/typed")
async def propose_typed(
    payload: TypedProposalRequest, owner: PodChatContext = Depends(owner_context)
):
    from hushh_mcp.services.location_command_catalog import command_catalog

    command = str(payload.request_id)
    if existing := await _existing(owner.owner, command):
        return existing
    revision, catalog = command_catalog()
    context = pod_command_context(payload.context)
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
    return await _create(owner.owner, command, plan)


async def _load(owner: str, command_id: str) -> dict[str, Any]:
    state: dict[str, Any] | None = await store.get(owner, command_id)
    if state is None:
        raise HTTPException(404, "Command not found or expired.")
    return state


@router.get("/{command_id}")
async def read_checkpoint(command_id: UUID, owner: PodChatContext = Depends(owner_context)):
    return {"checkpoint": _public(await _load(owner.owner, str(command_id)))}


@router.post("/{command_id}/settle")
async def settle(
    command_id: UUID, payload: PodSettlementRequest, owner: PodChatContext = Depends(owner_context)
):
    """Record what the app's typed effect did for exactly the next step."""
    state = await _load(owner.owner, str(command_id))
    if state["status"] in _CLOSED:
        raise HTTPException(409, "This command is closed.")
    if state["revision"] != payload.revision or state["next_step"] != payload.step:
        raise HTTPException(409, "The command changed. Refresh its checkpoint.")
    if not hmac.compare_digest(state["plan_digest"], _digest(state["plan"])):
        raise HTTPException(409, "The submitted plan does not match the checkpoint.")
    next_step = payload.step + 1
    status = (
        payload.status
        if payload.status != "succeeded"
        else ("completed" if next_step >= state["step_count"] else "ready")
    )
    try:
        saved = await store.update(
            owner.owner,
            str(command_id),
            payload.revision,
            {**state, "status": status, "next_step": next_step},
        )
    except CommandCheckpointConflict as exc:
        raise HTTPException(409, str(exc)) from None
    return {"checkpoint": _public(saved)}


@router.delete("/{command_id}")
async def cancel(command_id: UUID, owner: PodChatContext = Depends(owner_context)):
    deleted = await store.delete(owner.owner, str(command_id))
    return {"command_id": str(command_id), "cancelled": deleted}


__all__ = ["pod_command_context", "router", "store"]
