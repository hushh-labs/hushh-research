from __future__ import annotations

import time

from hushh_mcp.agents.onboarding.agent import (
    OnboardingAssessmentV1,
    OnboardingJourneyContext,
    resolve_onboarding_goal,
)


def _percentile(samples: list[float], percentile: float) -> float:
    ordered = sorted(samples)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * percentile)))
    return ordered[index]


def test_onboarding_policy_meets_morphy_ax_budget_over_10k_runs() -> None:
    context = OnboardingJourneyContext(
        phase="setup_hub",
        authenticated=True,
        phone_verified=True,
        vault_state="locked",
        screen="one_setup",
        available_action_ids=[
            "setup.open_gmail",
            "setup.open_location",
            "setup.open_email",
            "setup.open_finance",
        ],
        assessment=OnboardingAssessmentV1(
            intent="execute_visible_action",
            candidate_action_id="setup.open_email",
            confidence=0.99,
        ),
    )

    for _ in range(100):
        resolve_onboarding_goal(context)

    samples_ms: list[float] = []
    for _ in range(10_000):
        started_at = time.perf_counter()
        goal = resolve_onboarding_goal(context)
        samples_ms.append((time.perf_counter() - started_at) * 1000)
        assert goal.selected_action_id == "setup.open_email"

    assert _percentile(samples_ms, 0.95) <= 5
    assert _percentile(samples_ms, 0.99) <= 10
