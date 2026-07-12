"""Pure, bounded onboarding goal resolver used by One.

This is deliberately not an A2A or vault-bearing agent. It can guide an
anonymous person through sign-in and setup, but it never receives credentials,
private content, or a transcript and cannot execute any action itself.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

_PHASES = (
    "anonymous_auth",
    "phone_required",
    "setup_hub",
    "capability_setup",
    "external_connector",
    "root_completion",
)
_CAPABILITIES = {
    "finance",
    "gmail",
    "email",
    "location",
    "pkm",
    "consent",
    "marketplace",
    "connected-systems",
}
_PHASE_ACTIONS = {
    "anonymous_auth": {"auth.sign_in_google", "auth.sign_in_apple"},
    "phone_required": {"phone_mandate.submit_number"},
    "setup_hub": {
        "setup.hub_master_ack",
        "setup.open_finance",
        "setup.open_gmail",
        "setup.open_email",
        "setup.open_location",
        "setup.open_personal_data",
        "setup.open_consent",
        "setup.open_connected_systems",
    },
    "capability_setup": {
        "setup.capability_continue",
        "kai.setup.answer_horizon",
        "kai.setup.answer_drawdown",
        "kai.setup.answer_volatility",
        "kai.setup.launch_dashboard",
    },
    "external_connector": set(),
    "root_completion": set(),
}


class OnboardingJourneyContext(BaseModel):
    """The only state the deterministic onboarding specialist may inspect."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    phase: Literal[
        "anonymous_auth",
        "phone_required",
        "setup_hub",
        "capability_setup",
        "external_connector",
        "root_completion",
    ]
    authenticated: bool = False
    phone_verified: bool | None = None
    vault_state: Literal["absent", "locked", "unlocked"] = "absent"
    active_capability: str | None = Field(default=None, max_length=32)
    root_resolved: bool = False
    return_route: Literal["/one/setup"] = "/one/setup"
    callback_state: Literal["none", "pending", "succeeded", "cancelled", "failed"] = "none"
    available_action_ids: list[str] = Field(default_factory=list, max_length=18)
    setup_capability_ids: list[str] = Field(default_factory=list, max_length=10)
    screen: str = Field(default="unknown", max_length=64)
    requested_provider: Literal["google", "apple"] | None = None


class OnboardingGoal(BaseModel):
    """Bounded instruction returned to One; browser guards execute actions."""

    model_config = ConfigDict(extra="forbid")

    phase: str
    next_route: str
    permitted_action_ids: list[str]
    selected_action_id: str | None = None
    missing_input: str | None = None
    expected_settlement: Literal["route", "external_redirect", "callback", "local_action", "none"]
    return_to_hub: bool
    resolves_root: bool
    recovery: Literal["retry", "choose_provider", "verify_phone", "unlock", "return_to_hub", "none"]


def build_onboarding_specialist():
    """Manifest factory seam; returns the pure resolver, never an LLM agent."""
    return resolve_onboarding_goal


def resolve_onboarding_goal(context: OnboardingJourneyContext) -> OnboardingGoal:
    """Resolve the next allowed onboarding move without side effects."""
    phase = context.phase
    if context.root_resolved:
        phase = "root_completion"
    elif not context.authenticated:
        phase = "anonymous_auth"
    elif context.phone_verified is False:
        phase = "phone_required"
    elif (
        context.phase == "capability_setup"
        and context.active_capability
        and context.active_capability in _CAPABILITIES
    ):
        phase = "capability_setup"

    allowed = _PHASE_ACTIONS[phase]
    permitted = [action_id for action_id in context.available_action_ids if action_id in allowed]

    if phase == "anonymous_auth":
        provider_action = (
            f"auth.sign_in_{context.requested_provider}" if context.requested_provider else None
        )
        selected = provider_action if provider_action in permitted else None
        return OnboardingGoal(
            phase=phase,
            next_route="/login",
            permitted_action_ids=permitted,
            selected_action_id=selected,
            missing_input="provider" if selected is None else None,
            expected_settlement="external_redirect",
            return_to_hub=False,
            resolves_root=False,
            recovery="choose_provider",
        )
    if phase == "phone_required":
        return OnboardingGoal(
            phase=phase,
            next_route="/register-phone",
            permitted_action_ids=permitted,
            missing_input="verified_phone",
            expected_settlement="callback",
            return_to_hub=False,
            resolves_root=False,
            recovery="verify_phone",
        )
    if phase == "capability_setup":
        return OnboardingGoal(
            phase=phase,
            next_route="/one/setup",
            permitted_action_ids=permitted,
            expected_settlement="local_action",
            return_to_hub=True,
            resolves_root=False,
            recovery="return_to_hub",
        )
    if phase == "setup_hub":
        return OnboardingGoal(
            phase=phase,
            next_route="/one/setup",
            permitted_action_ids=permitted,
            expected_settlement="route",
            return_to_hub=True,
            resolves_root=False,
            recovery="none",
        )
    if phase == "external_connector":
        callback_failed = context.callback_state in {"cancelled", "failed"}
        return OnboardingGoal(
            phase=phase,
            next_route="/one/setup",
            permitted_action_ids=[],
            missing_input="retry_connector" if callback_failed else None,
            expected_settlement="callback" if context.callback_state == "pending" else "route",
            return_to_hub=True,
            resolves_root=False,
            recovery="retry" if callback_failed else "return_to_hub",
        )
    return OnboardingGoal(
        phase=phase,
        next_route="/one",
        permitted_action_ids=[],
        expected_settlement="none",
        return_to_hub=False,
        # Root completion is an already-settled terminal state. The hub is
        # the only authority that resolves it; this resolver never claims it
        # needs to resolve it again.
        resolves_root=False,
        recovery="none",
    )
