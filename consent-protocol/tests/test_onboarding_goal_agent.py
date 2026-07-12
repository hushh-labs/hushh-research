from hushh_mcp.agents.onboarding.agent import (
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
    assert goal.expected_settlement == "external_redirect"
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
            requested_provider="apple",
            available_action_ids=["auth.sign_in_google", "auth.sign_in_apple"],
        )
    )

    assert goal.selected_action_id == "auth.sign_in_apple"
    assert goal.missing_input is None


def test_unavailable_explicit_provider_keeps_safe_provider_recovery() -> None:
    goal = resolve_onboarding_goal(
        OnboardingJourneyContext(
            phase="anonymous_auth",
            requested_provider="apple",
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
