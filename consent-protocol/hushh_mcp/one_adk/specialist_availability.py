"""Redacted per-turn specialist admission for One.

This module is policy projection, not a semantic router. One still decides
whether a request belongs to a specialist; this module tells deterministic
tool code whether that already-selected specialist can be called safely from
the current bounded state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.services.route_orchestration_index import is_one_delegate_admitted

SpecialistAvailabilityState = Literal[
    "ready",
    "setup_required",
    "needs_auth",
    "vault_locked",
    "scope_required",
    "authority_required",
    "route_not_admitted",
    "runtime_unavailable",
    "unavailable",
]


_SPECIALIST_LABELS = {
    "agent_compute": "Compute",
    "agent_connected_systems": "Connected Systems",
    "agent_connections": "Connections",
    "agent_email": "Email",
    "agent_location": "Location",
    "agent_nav": "Consent Center",
}
_AUTHORITY_INGRESS_ONLY = frozenset({"agent_connected_systems", "agent_connections", "agent_email"})


@dataclass(frozen=True)
class SpecialistAvailabilityV1:
    """UI-safe availability evidence. It intentionally contains no authority."""

    specialist_id: str
    state: SpecialistAvailabilityState
    reason_code: str
    context_revision: str | None
    admitted_action_ids: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "specialist_availability.v1",
            "specialist_id": self.specialist_id,
            "state": self.state,
            "reason_code": self.reason_code,
            "context_revision": self.context_revision,
            "admitted_action_ids": list(self.admitted_action_ids),
        }


def specialist_label(agent_id: str) -> str:
    return _SPECIALIST_LABELS.get(agent_id, "Specialist")


def resolve_specialist_availability(
    *,
    agent_id: str,
    user_id: str,
    consent_token: str,
    voice_context: object,
) -> SpecialistAvailabilityV1:
    """Resolve a specialist's callable state from redacted current context."""
    context = voice_context if isinstance(voice_context, dict) else {}
    route_family = str(context.get("route_family") or "").strip()
    screen = str(context.get("screen") or "").strip()
    revision = str(context.get("context_revision") or "").strip() or None
    action_ids = tuple(
        action_id
        for action_id in context.get("available_action_ids", [])
        if isinstance(action_id, str) and action_id.strip()
    )[:18]
    onboarding = context.get("onboarding")
    onboarding = onboarding if isinstance(onboarding, dict) else {}
    active_capability = str(onboarding.get("active_capability") or "").strip()
    onboarding_phase = str(onboarding.get("phase") or "").strip()

    def result(state: SpecialistAvailabilityState, reason_code: str) -> SpecialistAvailabilityV1:
        return SpecialistAvailabilityV1(
            specialist_id=agent_id,
            state=state,
            reason_code=reason_code,
            context_revision=revision,
            admitted_action_ids=action_ids,
        )

    if agent_id not in _SPECIALIST_LABELS:
        return result("unavailable", "specialist_unknown")

    # `/one/setup/location` deliberately admits only generated onboarding
    # actions. Returning setup_required here makes an accidental tool call
    # recoverable without widening the setup route's specialist surface.
    is_location_setup = agent_id == "agent_location" and (
        screen == "one_setup_location"
        or route_family.rstrip("/") == "/one/setup/location"
        or (onboarding_phase == "capability_setup" and active_capability == "location")
    )
    if is_location_setup:
        return result("setup_required", "location_setup_incomplete")

    if agent_id in _AUTHORITY_INGRESS_ONLY and not is_wired_specialist(agent_id):
        return result("authority_required", "exact_a2a_authority_required")

    if not is_wired_specialist(agent_id):
        return result("unavailable", "specialist_unwired")

    if not user_id:
        return result("needs_auth", "signed_in_user_required")
    if not consent_token:
        return result("vault_locked", "vault_authority_required")

    admission = is_one_delegate_admitted(route_family, agent_id) if route_family else None
    if admission is False:
        return result("route_not_admitted", "route_specialist_not_admitted")
    return result("ready", "admitted")
