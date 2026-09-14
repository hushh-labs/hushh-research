"""Typed, import-safe Location command plans. No language classification or effects."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

LocationPlanMode = Literal["end_to_end", "needs_user_gate", "simulate"]


class CommandValue(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class LocationCommandStep(CommandValue):
    action_id: str = Field(min_length=1, max_length=128)
    slots: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=32)

    @field_validator("slots")
    @classmethod
    def bound_inputs(cls, slots: dict[str, str | int | float | bool]):
        if any(
            len(key) > 128 or (isinstance(value, str) and len(value) > 2000)
            for key, value in slots.items()
        ):
            raise ValueError("A proposed input exceeds the command limit.")
        return slots


class LocationWorkflowStep(CommandValue):
    workflow_id: str = Field(min_length=1, max_length=128)
    # Workflow policy, run identity and authority are never model inputs.
    slots: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=0)


class LocationStepDependency(CommandValue):
    slot: str = Field(min_length=1, max_length=128)
    source_step: int = Field(ge=0, lt=12)


class LocationCommandStepV2(LocationCommandStep):
    dependencies: list[LocationStepDependency] = Field(default_factory=list, max_length=8)
    references: list["LocationStepReference"] = Field(default_factory=list, max_length=8)


class LocationStepReference(CommandValue):
    slot: str = Field(min_length=1, max_length=128)
    reference: str = Field(pattern=r"^candidate_[a-f0-9]{32}$")


class LocationAssessment(CommandValue):
    """The model proposes meaning and steps; it cannot issue execution authority."""

    steps: list[LocationCommandStepV2 | LocationWorkflowStep] = Field(
        default_factory=list, max_length=12
    )
    clarification: str | None = Field(default=None, max_length=400)
    unsupported: bool = False
    intent_summary: str | None = Field(default=None, max_length=600)


class LocationGate(CommandValue):
    kind: Literal["input", "confirmation", "permission", "navigation", "unavailable"]
    message: str = Field(max_length=400)
    slot: str | None = None
    route: str | None = None


class _LocationPlanFields(CommandValue):
    capability_revision: str = Field(min_length=1, max_length=128)
    context_revision: str = Field(min_length=1, max_length=128)
    mode: LocationPlanMode
    gate_step: int = Field(default=0, ge=0, lt=12)
    gate: LocationGate | None = None
    intent_summary: str | None = Field(default=None, max_length=600)


class LocationPlanV1(_LocationPlanFields):
    # Preserve the legacy wire shape exactly: retained plans are HMAC-bound.
    schema_version: Literal["location.plan.v1"] = "location.plan.v1"
    steps: list[LocationCommandStep] = Field(default_factory=list, max_length=12)


class LocationPlanV2(_LocationPlanFields):
    schema_version: Literal["location.plan.v2"] = "location.plan.v2"
    steps: list[LocationCommandStepV2 | LocationWorkflowStep] = Field(
        default_factory=list, max_length=12
    )


LocationPlan = LocationPlanV1 | LocationPlanV2


class CommandCapsule(CommandValue):
    """Owner-encrypted payload; servers must never decrypt this inner envelope."""

    ciphertext: str = Field(min_length=1, max_length=180_000)
    iv: str = Field(min_length=16, max_length=24)
    tag: str = Field(min_length=20, max_length=28)
    algorithm: Literal["aes-256-gcm"] = "aes-256-gcm"
    encoding: Literal["base64"] = "base64"

    @model_validator(mode="after")
    def validate_envelope(self) -> CommandCapsule:
        try:
            ciphertext = base64.b64decode(self.ciphertext, validate=True)
            iv = base64.b64decode(self.iv, validate=True)
            tag = base64.b64decode(self.tag, validate=True)
        except ValueError as exc:
            raise ValueError("Invalid encrypted envelope.") from exc
        if not ciphertext or len(iv) != 12 or len(tag) != 16:
            raise ValueError("Invalid encrypted envelope.")
        return self


def fingerprint_slots(slots: dict[str, Any] | None) -> str:
    canonical = json.dumps(slots or {}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def missing_input(action: dict[str, Any], slots: dict[str, Any]) -> LocationGate | None:
    for spec in (action.get("goal") or {}).get("required_inputs") or []:
        name = str(spec.get("slot") or spec.get("name") or "")
        value = slots.get(name)
        if spec.get("required") and (
            value is None or (isinstance(value, str) and not value.strip())
        ):
            if spec.get("default_value") not in (None, ""):
                continue
            return LocationGate(
                kind="input", slot=name, message=spec.get("prompt") or "Add the missing detail."
            )
    return None


def validate_assessment(
    assessment: LocationAssessment,
    catalog: dict[str, dict[str, Any]],
    *,
    capability_revision: str,
    context_revision: str,
    plan_version: Literal["location.plan.v1", "location.plan.v2"] = "location.plan.v1",
    completed_steps: list[LocationCommandStep | LocationWorkflowStep] | None = None,
    reference_kinds: dict[str, str] | None = None,
) -> LocationPlan:
    """Validate exact generated IDs and inputs, never infer intent from words."""
    if (
        assessment.clarification
        and not assessment.steps
        and not (assessment.intent_summary or "").strip()
    ):
        raise ValueError("An unresolved request needs a normalized continuation intent.")
    gate = None
    mode: LocationPlanMode = "end_to_end"
    prefix = [step.model_copy(deep=True) for step in completed_steps or []]
    gate_step = len(prefix)
    # The authored workflow owns its required client tail. This expands an
    # already selected capability; it never classifies the user's sentence.
    steps: list[LocationCommandStep | LocationWorkflowStep] = list(prefix)
    source_indexes: dict[int, int] = {index: index for index in range(len(prefix))}
    for index, step in enumerate(assessment.steps):
        global_index = len(prefix) + index
        source_indexes[global_index] = len(steps)
        if isinstance(step, LocationCommandStepV2):
            if plan_version == "location.plan.v1":
                if step.dependencies or step.references:
                    raise ValueError("Step dependencies require the current plan version.")
                step = LocationCommandStep(action_id=step.action_id, slots=step.slots)
            else:
                step = step.model_copy(deep=True)
                for dependency in step.dependencies:
                    if dependency.source_step >= global_index:
                        raise ValueError("A dependency must reference a verified earlier step.")
                    dependency.source_step = source_indexes[dependency.source_step]
        steps.append(step)
        if isinstance(step, LocationWorkflowStep) and plan_version == "location.plan.v2":
            workflow = (catalog.get(step.workflow_id) or {}).get("workflow") or {}
            tail = workflow.get("command_completion_action_ids") or []
            for action_id in tail:
                completion = LocationCommandStepV2(action_id=action_id)
                if index + 1 >= len(assessment.steps) or assessment.steps[index + 1] != completion:
                    steps.append(completion)
    if len(steps) > 12:
        raise ValueError("The command exceeds the step limit.")
    if assessment.unsupported or not assessment.steps:
        gate = LocationGate(
            kind="input" if assessment.clarification else "unavailable",
            message=assessment.clarification or "That request is not supported by Location yet.",
        )
        mode = "needs_user_gate"
    for index, step in enumerate(steps):
        if index < len(prefix):
            continue  # Already settled and HMAC-verified by the command owner.
        if isinstance(step, LocationWorkflowStep):
            workflow = (catalog.get(step.workflow_id) or {}).get("workflow") or {}
            execution = workflow.get("execution") or {}
            if (
                plan_version != "location.plan.v2"
                or execution.get("outcome") != "EXECUTE"
                or execution.get("mode") != "durable_capability_run"
                or not execution.get("binding_ref")
                or workflow.get("settlement_proof")
                != "server_location_onboarding_completion_receipt"
            ):
                raise ValueError("The workflow has no verified Location execution binding.")
            continue
        action = catalog.get(step.action_id)
        if action is None:
            raise ValueError("The proposed action is outside the Location capability package.")
        if "confirmed" in step.slots or any(key.startswith("__") for key in step.slots):
            raise ValueError("The model cannot supply execution authority.")
        specs = (action.get("goal") or {}).get("required_inputs") or []
        allowed_slots = {str(s.get("slot") or s.get("name")) for s in specs}
        if set(step.slots) - allowed_slots:
            raise ValueError("The proposed inputs are not declared by the action.")
        dependencies = step.dependencies if isinstance(step, LocationCommandStepV2) else []
        bound_slots: set[str] = set()
        for dependency in dependencies:
            if dependency.slot in bound_slots or dependency.slot in step.slots:
                raise ValueError("An input cannot have more than one source.")
            source = steps[dependency.source_step]
            resource_kind = (
                ((catalog.get(source.action_id) or {}).get("command") or {}).get("result_resource")
                if isinstance(source, LocationCommandStep)
                else None
            )
            if (
                not resource_kind
                or (action.get("command") or {}).get("resource_inputs", {}).get(dependency.slot)
                != resource_kind
            ):
                raise ValueError(
                    "The dependency does not match an authored resource result and input."
                )
            bound_slots.add(dependency.slot)
        for reference in step.references if isinstance(step, LocationCommandStepV2) else []:
            kind = (reference_kinds or {}).get(reference.reference)
            if (
                not kind
                or reference.slot in bound_slots
                or reference.slot in step.slots
                or (action.get("command") or {}).get("resource_inputs", {}).get(reference.slot)
                != kind
            ):
                raise ValueError("A reference must match one observed, authored resource input.")
            bound_slots.add(reference.slot)
        for spec in specs:
            name = str(spec.get("slot") or spec.get("name"))
            value = step.slots.get(name)
            if value is None and spec.get("default_value") is not None:
                value = step.slots[name] = spec["default_value"]
            if value is not None and spec.get("options") and str(value) not in spec["options"]:
                raise ValueError("A proposed input is outside the declared choices.")
        missing = missing_input(
            action, {**step.slots, **dict.fromkeys(bound_slots, "verified_prior_result")}
        )
        # Manual screens own their form inputs and device gates. Opening one
        # must not ask command-only questions before the authored handoff.
        if missing and gate is None and not (action.get("command") or {}).get("review_only"):
            gate, mode, gate_step = missing, "needs_user_gate", index
        target = action.get("execution_target") or {}
        if action.get("execution_policy") == "manual_only" or target.get("status") != "wired":
            if not (action.get("command") or {}).get("review_route"):
                raise ValueError("The action has no executable or review destination.")
            if gate is None:
                gate = LocationGate(
                    kind="navigation",
                    message="Continue on this screen.",
                    route=action["command"]["review_route"],
                )
                mode, gate_step = "simulate", index
        if (action.get("command") or {}).get("review_only") and gate is None:
            gate = LocationGate(
                kind="navigation",
                message="Review this in Location.",
                route=action["command"]["review_route"],
            )
            mode, gate_step = "simulate", index
    if assessment.clarification and gate is None:
        gate, mode = LocationGate(kind="input", message=assessment.clarification), "needs_user_gate"
    plan_type = LocationPlanV2 if plan_version == "location.plan.v2" else LocationPlanV1
    return plan_type(
        capability_revision=capability_revision,
        context_revision=context_revision,
        mode=mode,
        steps=steps,
        gate=gate,
        gate_step=gate_step,
        intent_summary=assessment.intent_summary,
    )
