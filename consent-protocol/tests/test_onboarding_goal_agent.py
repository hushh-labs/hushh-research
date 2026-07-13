from hushh_mcp.agents.onboarding.agent import (
    OnboardingAssessmentV1,
    OnboardingJourneyContext,
    resolve_onboarding_goal,
)


def test_login_only_permits_explicit_provider_actions_and_requests_choice() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            available_action_ids=[
                "auth.sign_in_google",
                "auth.sign_in_apple",
                "unrelated.action",
            ],
        )
    )

    assert goal.next_route == "/login"
    assert goal.expected_settlement == "auth_session"
    assert goal.permitted_action_ids == [
        "auth.sign_in_google",
        "auth.sign_in_apple",
    ]
    assert goal.missing_input == "provider"
    assert goal.resolves_root is False


def test_explicit_apple_request_selects_the_apple_action() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            assessment=OnboardingAssessmentV1(
                intent="execute_visible_action",
                provider="apple",
                candidate_action_id="auth.sign_in_apple",
            ),
            available_action_ids=["auth.sign_in_google", "auth.sign_in_apple"],
        )
    )

    assert goal.selected_action_id == "auth.sign_in_apple"
    assert goal.missing_input is None


def test_root_claim_is_selected_before_provider_choice() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            screen="one_intro",
            assessment=OnboardingAssessmentV1(
                intent="execute_visible_action",
                candidate_action_id="onboarding.claim_one",
            ),
            available_action_ids=["onboarding.claim_one"],
        )
    )

    assert goal.selected_action_id == "onboarding.claim_one"
    assert goal.expected_settlement == "route"
    assert goal.missing_input is None


def test_unavailable_explicit_provider_keeps_safe_provider_recovery() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            assessment=OnboardingAssessmentV1(
                intent="execute_visible_action",
                provider="apple",
                candidate_action_id="auth.sign_in_apple",
            ),
            available_action_ids=["auth.sign_in_google"],
        )
    )

    assert goal.selected_action_id is None
    assert goal.missing_input == "provider"


def test_finance_capability_returns_to_hub_without_resolving_root() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="capability_setup",
            authenticated=True,
            active_capability="finance",
            available_action_ids=["kai.setup.launch_dashboard"],
        )
    )

    assert goal.phase == "capability_setup"
    assert goal.next_route == "/one/setup"
    assert goal.return_to_hub is True
    assert goal.resolves_root is False
    assert goal.permitted_action_ids == ["kai.setup.launch_dashboard"]


def test_root_resolution_overrides_stale_capability_context() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="capability_setup",
            authenticated=True,
            active_capability="finance",
            root_resolved=True,
            available_action_ids=["kai.setup.launch_dashboard"],
        )
    )

    assert goal.phase == "root_completion"
    assert goal.next_route == "/one"
    assert goal.resolves_root is False
    assert goal.permitted_action_ids == []


def test_external_connector_failure_recovers_at_the_setup_hub() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="external_connector",
            authenticated=True,
            callback_state="failed",
        )
    )

    assert goal.next_route == "/one/setup"
    assert goal.return_to_hub is True
    assert goal.recovery == "retry"


def test_stale_capability_does_not_override_the_setup_hub_phase() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="setup_hub",
            authenticated=True,
            active_capability="finance",
            available_action_ids=["setup.open_finance"],
        )
    )

    assert goal.phase == "setup_hub"
    assert goal.permitted_action_ids == ["setup.open_finance"]


def test_setup_hub_admits_every_catalog_action() -> None:
    actions = [
        "setup.open_finance",
        "setup.open_gmail",
        "setup.open_email",
        "setup.open_location",
        "setup.open_pkm",
        "setup.open_consent",
        "setup.open_marketplace",
        "setup.open_connected_systems",
    ]
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="setup_hub",
            authenticated=True,
            available_action_ids=actions,
        )
    )

    assert goal.permitted_action_ids == actions


def test_intelligence_assessment_admits_only_current_visible_action() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="setup_hub",
            authenticated=True,
            available_action_ids=["setup.open_pkm"],
            assessment=OnboardingAssessmentV1(
                intent="execute_visible_action",
                candidate_action_id="setup.open_pkm",
                confidence=0.97,
            ),
        )
    )

    assert goal.selected_action_id == "setup.open_pkm"
    assert goal.assessment_status == "admitted"


def test_wrong_screen_intelligence_assessment_fails_closed() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="setup_hub",
            authenticated=True,
            available_action_ids=["setup.open_pkm"],
            assessment=OnboardingAssessmentV1(
                intent="execute_visible_action",
                candidate_action_id="auth.sign_in_apple",
            ),
        )
    )

    assert goal.selected_action_id is None
    assert goal.assessment_status == "rejected"
    assert goal.reason_code == "action_not_available_on_screen"


def test_conversational_assessment_does_not_force_onboarding() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            screen="one_intro",
            available_action_ids=["onboarding.claim_one"],
            assessment=OnboardingAssessmentV1(intent="answer_conversationally"),
        )
    )

    assert goal.selected_action_id is None
    assert goal.assessment_status == "not_applicable"


def test_ambiguous_assessment_retains_goal_and_requests_input() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            available_action_ids=["auth.sign_in_google", "auth.sign_in_apple"],
            assessment=OnboardingAssessmentV1(
                intent="ask_clarifying_question",
                ambiguous=True,
                missing_input="provider",
            ),
        )
    )

    assert goal.selected_action_id is None
    assert goal.assessment_status == "needs_input"
    assert goal.missing_input == "provider"


def test_provider_and_candidate_mismatch_is_rejected() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            available_action_ids=["auth.sign_in_google", "auth.sign_in_apple"],
            assessment=OnboardingAssessmentV1(
                intent="execute_visible_action",
                provider="apple",
                candidate_action_id="auth.sign_in_google",
            ),
        )
    )

    assert goal.selected_action_id is None
    assert goal.assessment_status == "rejected"
    assert goal.reason_code == "provider_action_mismatch"
