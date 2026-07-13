"""Pure, bounded onboarding goal resolver used by One.

This is deliberately not an A2A or vault-bearing agent. It can guide an
anonymous person through sign-in and setup, but it never receives credentials,
private content, or a transcript and cannot execute any action itself.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.onboarding_contract import (
    SETUP_CAPABILITY_IDS,
    SETUP_CAPABILITY_ORDER,
)

_PHASES = (
    "anonymous_auth",
    "phone_required",
    "setup_hub",
    "capability_setup",
    "external_connector",
    "root_completion",
)
_PHASE_ACTIONS = {
    "anonymous_auth": {
        "onboarding.claim_one",
        "auth.sign_in_google",
        "auth.sign_in_apple",
    },
    "phone_required": {
        "phone_mandate.submit_number",
        "phone_mandate.submit_code",
    },
    "setup_hub": {
        "setup.hub_master_ack",
        "setup.open_gmail",
        "setup.open_location",
        "setup.open_email",
        "setup.open_finance",
        "setup.open_ria",
        "setup.open_connected_systems",
    },
    "capability_setup": {
        "setup.finish_gmail",
        "setup.skip_gmail",
        "setup.finish_location",
        "setup.skip_location",
        "setup.finish_email",
        "setup.skip_email",
        "setup.finish_finance",
        "setup.skip_finance",
        "setup.finish_ria",
        "setup.skip_ria",
        "setup.finish_connected_systems",
        "setup.skip_connected_systems",
        "kai.setup.answer_horizon",
        "kai.setup.answer_drawdown",
        "kai.setup.answer_volatility",
        "kai.setup.launch_dashboard",
    },
    "external_connector": set(),
    "root_completion": set(),
}
_CAPABILITY_TERMINAL_ACTIONS = {
    "gmail": {
        "setup.connect_gmail",
        "setup.finish_gmail",
        "setup.skip_gmail",
    },
    "location": {"setup.finish_location", "setup.skip_location"},
    "email": {"setup.finish_email", "setup.skip_email"},
    "finance": {
        "setup.finish_finance",
        "setup.skip_finance",
        "kai.setup.answer_horizon",
        "kai.setup.answer_drawdown",
        "kai.setup.answer_volatility",
        "kai.setup.launch_dashboard",
    },
    "ria": {"setup.finish_ria", "setup.skip_ria"},
    "connected-systems": {
        "setup.finish_connected_systems",
        "setup.skip_connected_systems",
    },
}


class OnboardingAssessmentV1(BaseModel):
    """Semantic interpretation authored by One or the bounded adjudicator."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    source: Literal["one", "agent_onboarding"] = "one"
    intent: Literal[
        "execute_visible_action",
        "confirm_visible_action",
        "answer_current_page",
        "answer_conversationally",
        "ask_clarifying_question",
        "provide_input",
        "recover",
        "next_step",
    ] = "next_step"
    candidate_action_id: str | None = Field(default=None, max_length=128)
    provider: Literal["google", "apple"] | None = None
    missing_input: str | None = Field(default=None, max_length=64)
    ambiguous: bool = False
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


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
    assessment: OnboardingAssessmentV1 = Field(default_factory=OnboardingAssessmentV1)


class OnboardingGoal(BaseModel):
    """Bounded instruction returned to One; browser guards execute actions."""

    model_config = ConfigDict(extra="forbid")

    phase: str
    next_route: str
    permitted_action_ids: list[str]
    setup_completed_ids: list[str] = Field(default_factory=list)
    setup_remaining_ids: list[str] = Field(default_factory=list)
    selected_action_id: str | None = None
    missing_input: str | None = None
    expected_settlement: Literal[
        "route", "auth_session", "external_redirect", "callback", "local_action", "none"
    ]
    return_to_hub: bool
    resolves_root: bool
    recovery: Literal["retry", "choose_provider", "verify_phone", "unlock", "return_to_hub", "none"]
    assessment_status: Literal[
        "admitted", "guidance_only", "needs_input", "rejected", "not_applicable"
    ] = "guidance_only"
    reason_code: str | None = Field(default=None, max_length=64)


def build_onboarding_specialist():
    """Manifest factory seam; returns the pure resolver, never an LLM agent."""
    return resolve_onboarding_goal


def resolve_onboarding_goal(context: OnboardingJourneyContext) -> OnboardingGoal:
    """Resolve the next allowed onboarding move without side effects."""
    phase = context.phase
    completed_set = set(context.setup_capability_ids)
    setup_progress = {
        "setup_completed_ids": [
            capability for capability in SETUP_CAPABILITY_ORDER if capability in completed_set
        ],
        "setup_remaining_ids": [
            capability for capability in SETUP_CAPABILITY_ORDER if capability not in completed_set
        ],
    }
    if context.root_resolved:
        phase = "root_completion"
    elif not context.authenticated:
        phase = "anonymous_auth"
    elif context.phone_verified is False:
        phase = "phone_required"
    elif (
        context.phase == "capability_setup"
        and context.active_capability
        and context.active_capability in SETUP_CAPABILITY_IDS
    ):
        phase = "capability_setup"

    allowed = _PHASE_ACTIONS[phase]
    if phase == "capability_setup" and context.active_capability:
        # The active capability is redacted route state, not an inferred intent.
        # It narrows terminal authority before the available visible-action
        # intersection below, so a stale sibling action fails closed.
        allowed = _CAPABILITY_TERMINAL_ACTIONS.get(context.active_capability, set())
    permitted = [action_id for action_id in context.available_action_ids if action_id in allowed]
    assessment = context.assessment
    candidate = assessment.candidate_action_id
    provider_candidate = (
        f"auth.sign_in_{assessment.provider}" if assessment.provider is not None else None
    )
    proposal_conflict = bool(candidate and provider_candidate and candidate != provider_candidate)
    if candidate is None:
        candidate = provider_candidate
    action_intent = assessment.intent in {
        "execute_visible_action",
        "confirm_visible_action",
        "provide_input",
    }
    selected = (
        candidate
        if action_intent
        and candidate in permitted
        and not assessment.ambiguous
        and not proposal_conflict
        else None
    )
    assessment_missing = assessment.missing_input if assessment.ambiguous else None
    if assessment.intent in {"answer_current_page", "answer_conversationally"}:
        assessment_status = "not_applicable"
        reason_code = None
    elif assessment.ambiguous or assessment.intent == "ask_clarifying_question":
        assessment_status = "needs_input"
        reason_code = assessment_missing or "ambiguous_intent"
    elif proposal_conflict:
        assessment_status = "rejected"
        reason_code = "provider_action_mismatch"
    elif candidate and candidate not in permitted:
        assessment_status = "rejected"
        reason_code = "action_not_available_on_screen"
    elif selected:
        assessment_status = "admitted"
        reason_code = None
    else:
        assessment_status = "guidance_only"
        reason_code = None

    if phase == "anonymous_auth":
        if context.screen == "one_intro" and selected == "onboarding.claim_one":
            return OnboardingGoal(
                **setup_progress,
                phase=phase,
                next_route="/login",
                permitted_action_ids=permitted,
                selected_action_id="onboarding.claim_one",
                missing_input=None,
                expected_settlement="route",
                return_to_hub=False,
                resolves_root=False,
                recovery="none",
                assessment_status=assessment_status,
                reason_code=reason_code,
            )
        return OnboardingGoal(
            **setup_progress,
            phase=phase,
            next_route="/login",
            permitted_action_ids=permitted,
            selected_action_id=selected,
            missing_input=assessment_missing or ("provider" if selected is None else None),
            expected_settlement="auth_session",
            return_to_hub=False,
            resolves_root=False,
            recovery="choose_provider",
            assessment_status=assessment_status,
            reason_code=reason_code,
        )
    if phase == "phone_required":
        return OnboardingGoal(
            **setup_progress,
            phase=phase,
            next_route="/register-phone",
            permitted_action_ids=permitted,
            selected_action_id=selected,
            missing_input=assessment_missing or ("verified_phone" if selected is None else None),
            expected_settlement="callback",
            return_to_hub=False,
            resolves_root=False,
            recovery="verify_phone",
            assessment_status=assessment_status,
            reason_code=reason_code,
        )
    if phase == "capability_setup":
        return OnboardingGoal(
            **setup_progress,
            phase=phase,
            next_route="/one/setup",
            permitted_action_ids=permitted,
            selected_action_id=selected,
            missing_input=assessment_missing,
            expected_settlement="local_action",
            return_to_hub=True,
            resolves_root=False,
            recovery="return_to_hub",
            assessment_status=assessment_status,
            reason_code=reason_code,
        )
    if phase == "setup_hub":
        return OnboardingGoal(
            **setup_progress,
            phase=phase,
            next_route="/one/setup",
            permitted_action_ids=permitted,
            selected_action_id=selected,
            missing_input=assessment_missing,
            expected_settlement="route",
            return_to_hub=True,
            resolves_root=False,
            recovery="none",
            assessment_status=assessment_status,
            reason_code=reason_code,
        )
    if phase == "external_connector":
        callback_failed = context.callback_state in {"cancelled", "failed"}
        return OnboardingGoal(
            **setup_progress,
            phase=phase,
            next_route="/one/setup",
            permitted_action_ids=[],
            missing_input="retry_connector" if callback_failed else None,
            expected_settlement="callback" if context.callback_state == "pending" else "route",
            return_to_hub=True,
            resolves_root=False,
            recovery="retry" if callback_failed else "return_to_hub",
            assessment_status=assessment_status,
            reason_code=reason_code,
        )
    return OnboardingGoal(
        **setup_progress,
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
        assessment_status=assessment_status,
        reason_code=reason_code,
    )
