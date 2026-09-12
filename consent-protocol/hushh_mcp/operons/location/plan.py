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


class LocationAssessment(CommandValue):
    """The model proposes meaning and steps; it cannot issue execution authority."""

    steps: list[LocationCommandStep] = Field(default_factory=list, max_length=12)
    clarification: str | None = Field(default=None, max_length=400)
    unsupported: bool = False
    intent_summary: str | None = Field(default=None, max_length=600)


class LocationGate(CommandValue):
    kind: Literal["input", "confirmation", "permission", "navigation", "unavailable"]
    message: str = Field(max_length=400)
    slot: str | None = None
    route: str | None = None


class LocationPlanV1(CommandValue):
    schema_version: Literal["location.plan.v1"] = "location.plan.v1"
    capability_revision: str = Field(min_length=1, max_length=128)
    context_revision: str = Field(min_length=1, max_length=128)
    mode: LocationPlanMode
    steps: list[LocationCommandStep] = Field(default_factory=list, max_length=12)
    gate_step: int = Field(default=0, ge=0, lt=12)
    gate: LocationGate | None = None
    intent_summary: str | None = Field(default=None, max_length=600)


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
) -> LocationPlanV1:
    """Validate exact generated IDs and inputs, never infer intent from words."""
    if (
        assessment.clarification
        and not assessment.steps
        and not (assessment.intent_summary or "").strip()
    ):
        raise ValueError("An unresolved request needs a normalized continuation intent.")
    gate = None
    mode: LocationPlanMode = "end_to_end"
    gate_step = 0
    if assessment.unsupported or not assessment.steps:
        gate = LocationGate(
            kind="input" if assessment.clarification else "unavailable",
            message=assessment.clarification or "That request is not supported by Location yet.",
        )
        mode = "needs_user_gate"
    for index, step in enumerate(assessment.steps):
        action = catalog.get(step.action_id)
        if action is None:
            raise ValueError("The proposed action is outside the Location capability package.")
        if "confirmed" in step.slots or any(key.startswith("__") for key in step.slots):
            raise ValueError("The model cannot supply execution authority.")
        specs = (action.get("goal") or {}).get("required_inputs") or []
        allowed_slots = {str(s.get("slot") or s.get("name")) for s in specs}
        if set(step.slots) - allowed_slots:
            raise ValueError("The proposed inputs are not declared by the action.")
        for spec in specs:
            name = str(spec.get("slot") or spec.get("name"))
            value = step.slots.get(name)
            if value is None and spec.get("default_value") is not None:
                value = step.slots[name] = spec["default_value"]
            if value is not None and spec.get("options") and str(value) not in spec["options"]:
                raise ValueError("A proposed input is outside the declared choices.")
        missing = missing_input(action, step.slots)
        if missing and gate is None:
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
    return LocationPlanV1(
        capability_revision=capability_revision,
        context_revision=context_revision,
        mode=mode,
        steps=assessment.steps,
        gate=gate,
        gate_step=gate_step,
        intent_summary=assessment.intent_summary,
    )
