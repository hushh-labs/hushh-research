"""The parity ruler, as a test. Phase 1 of the pod-journey-parity plan.

This does NOT assert the pod is at parity today -- it demonstrably is not, by
construction (directive drop + data-door miss are live). It asserts the ORACLE
correctly MEASURES the gap: each golden journey classifies into the failure
class the audit predicted, the reference journeys are non-vacuous, and the
pod's zero-database-credential posture holds so a future green oracle can never
certify a database grant.

As each remediation phase lands, its journey's pod_turn fixture is updated to
the fixed delivered contract and its assertion flips from "this class fires" to
"at parity" -- the same file, the same test, the divergence closing in place.
That is the loop: the ruler is written first and stays; the reality it measures
moves toward it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hushh_mcp.observability.parity_classes import (
    PARITY_FAILURE_COPY,
    ParityFailureClass,
    copy_for,
)
from hushh_mcp.observability.parity_evaluator import load_corpus

_CORPUS = load_corpus()
_BY_NAME = {j.name: j for j in _CORPUS}


def test_the_corpus_is_present_and_loads():
    assert _CORPUS, "no golden journeys found — the ruler has nothing to measure"
    for journey in _CORPUS:
        # A malformed/vacuous reference raises here; a green corpus means every
        # journey actually asserts something on the hub side.
        journey.assert_reference_is_not_vacuous()


def test_a_fully_matching_turn_is_at_parity():
    """The grounded turn does the same thing on both paths — the control."""
    diff = _BY_NAME["grounded_turn"].run()
    assert diff.at_parity, f"expected parity, got {diff.failures} :: {diff.detail}"


def test_the_debate_launch_reaches_parity_after_directive_transport():
    """Phase 2 closed the decisive gap IN PLACE: the same journey that was a
    directive-drop now reaches parity, because the pod carries directive payloads
    and the relay authorizes them into the same frames the hub emits.

    This assertion flipped from 'directive-drop fires' to 'at parity' -- same
    file, same journey, the divergence closing in the fixture. If it regresses to
    directive-drop, the transport path broke and the Debate no longer launches
    from a pod turn."""
    diff = _BY_NAME["analyze_nvidia_debate"].run()
    assert diff.at_parity, f"Debate launch regressed to {diff.failures} :: {diff.detail}"


@pytest.mark.parametrize("name", ["location_question", "consent_question"])
def test_db_backed_specialists_are_a_data_door_miss_today(name: str):
    """Location and consent serve on the hub, refuse in the pod (no DB cred)."""
    diff = _BY_NAME[name].run()
    assert ParityFailureClass.DATA_DOOR_MISS in diff.failures, diff.detail
    assert "phase-5-data-door" in diff.owners


def test_every_failure_class_has_honest_nontransient_copy():
    """The copy that replaces 'please try again'. A structural class must never
    be told to retry — assert the copy carries no transient promise."""
    for cls in ParityFailureClass:
        assert cls in PARITY_FAILURE_COPY, f"{cls} has no user-facing copy"
        text = copy_for(cls).lower()
        for transient in ("try again", "please retry", "temporarily"):
            assert transient not in text, (
                f"{cls} copy makes a transient promise for a structural condition: {text!r}"
            )


def test_the_pod_holds_zero_database_credentials():
    """The invariant that keeps a green oracle honest: no parity 'fix' may hand
    the pod a Postgres credential. If this fires, a data-door design regressed
    into a DB grant, and every downstream parity claim is void."""
    root = Path(__file__).resolve().parents[1]
    creds = ("DB_USER", "DB_PASSWORD", "DB_HOST", "DB_UNIX_SOCKET", "DATABASE_URL")
    for rel in (
        "hushh_mcp/services/gcp_backend.py",
        "hushh_mcp/services/user_gcp_backend.py",
    ):
        body = (root / rel).read_text()
        for cred in creds:
            assert cred not in body, (
                f"{rel} references {cred}: the pod's zero-role identity is the whole "
                "point; a specialist must reach data through the hub broker, never a "
                "database credential in the pod."
            )


# ---- regression guards: the five oracle holes the adversarial review found ----
# Each of these would have PASSED (wrongly) against the first-cut oracle. They
# pin the ruler so a future edit cannot silently reopen a false-parity hole.

from hushh_mcp.observability.parity_oracle import (  # noqa: E402
    DirectiveObservation,
    EquivalenceMode,
    SpecialistObservation,
    TurnObservation,
    classify,
    observe_hub,
)


def _hub_served(agent_id: str) -> TurnObservation:
    return TurnObservation(
        path="hub",
        has_text=True,
        grounded=True,
        runtime_mode="hub",
        specialists=(SpecialistObservation(agent_id=agent_id, status="ok"),),
    )


@pytest.mark.parametrize(
    "bad_status", ["error", "timeout", "unavailable", "", "failed", "degraded"]
)
def test_hole1_any_nonok_specialist_status_is_a_miss_not_parity(bad_status: str):
    """The false-parity blocker: the original ladder had no `else`, so a status
    it did not anticipate certified parity. Every non-ok outcome for a hub-served
    specialist is now a data-door miss."""
    pod = TurnObservation(
        path="pod",
        has_text=True,
        grounded=True,
        runtime_mode="pod",
        specialists=(SpecialistObservation(agent_id="agent_location", status=bad_status),),
    )
    diff = classify(pod, _hub_served("agent_location"), EquivalenceMode.EXACT)
    assert not diff.at_parity, f"status {bad_status!r} wrongly certified parity"
    assert ParityFailureClass.DATA_DOOR_MISS in diff.failures


def test_hole2_a_journey_that_asserts_nothing_is_rejected():
    """The vacuous-pass blocker: a journey declaring no expectation must raise,
    not silently pass empty-vs-empty as parity."""
    from hushh_mcp.observability.parity_evaluator import ParityJourney

    empty = ParityJourney(
        name="empty",
        mode=EquivalenceMode.EXACT,
        hub_frames=[],
        hub_grounded=False,
        pod_turn={},
        pod_specialist_statuses=[],
        expect_hub_directive_kinds=[],
        expect_hub_specialists=[],
        expect_hub_text=False,
        expect_hub_grounded=False,
    )
    with pytest.raises(AssertionError, match="asserts nothing"):
        empty.assert_reference_is_not_vacuous()


def test_hole3_a_silent_or_ungrounded_pod_is_not_parity():
    """classify used to ignore has_text/grounded, so a silent ungrounded pod
    scored parity against a texting grounded hub."""
    hub = TurnObservation(path="hub", has_text=True, grounded=True, runtime_mode="hub")
    silent = TurnObservation(path="pod", has_text=False, grounded=True, runtime_mode="pod")
    ungrounded = TurnObservation(path="pod", has_text=True, grounded=False, runtime_mode="pod")
    assert not classify(silent, hub, EquivalenceMode.EXACT).at_parity
    assert not classify(ungrounded, hub, EquivalenceMode.EXACT).at_parity


def test_hole4_a_hollow_action_directive_is_not_parity_in_exact_mode():
    """Keying on action_id alone let a hollow directive (right id, no execution
    target) pass. EXACT mode now requires dispatchability."""
    hub = TurnObservation(
        path="hub",
        has_text=True,
        grounded=True,
        runtime_mode="hub",
        directives=(
            DirectiveObservation(kind="action", action_id="analysis.start", dispatchable=True),
        ),
    )
    pod = TurnObservation(
        path="pod",
        has_text=True,
        grounded=True,
        runtime_mode="pod",
        directives=(
            DirectiveObservation(kind="action", action_id="analysis.start", dispatchable=False),
        ),
    )
    diff = classify(pod, hub, EquivalenceMode.EXACT)
    assert not diff.at_parity, "a hollow action directive was certified parity"
    assert ParityFailureClass.DIRECTIVE_DROP in diff.failures


def test_hole5_a_tool_waiting_only_hub_still_shows_the_directive():
    """tool_waiting had no branch, so a hub signalling an action only via
    tool_waiting was observed as having zero directives."""
    obs = observe_hub(
        [
            {
                "event": "tool_waiting",
                "data": {"action_id": "analysis.start", "execution": "frontend"},
            }
        ]
    )
    assert len(obs.directives) == 1
    assert obs.directives[0].action_id == "analysis.start"
    assert obs.directives[0].dispatchable is True


# ---- hole 6: the ruler was wrong about every LIVE pod ------------------------
#
# Found 2026-08-25, and the most consequential of the six because it is not a
# false PASS -- it is a false FAIL, on the only shape a real pod ever returns.
# `observe_pod` read `turn["frames"]`; `run_pod_turn` returns `directives`. So a
# pod that carried its directives perfectly scored DIRECTIVE_DROP, and the green
# fixture that "proved" the transport rested on a shape the pod does not produce.
#
# A ruler that mis-reads the thing it measures makes every measurement taken
# with it suspect, which is why these run before anything else is measured.


def _pod_live(directives: list[dict], **extra) -> TurnObservation:
    from hushh_mcp.observability.parity_oracle import observe_pod

    return observe_pod(
        {
            "text": "here you go",
            "grounded": True,
            "runtimeMode": "user_adc",
            "directiveCount": len(directives),
            "directives": directives,
            **extra,
        }
    )


def test_hole6_a_live_pod_directive_array_is_read_not_counted():
    """The exact shape `pod_turn.run_pod_turn` returns."""
    obs = _pod_live(
        [
            {
                "kind": "action",
                "payload": {"actionId": "analysis.start", "execution": "frontend"},
                "delegateAgentId": None,
            }
        ]
    )

    assert obs.directives_dropped is False, "a delivered directive array read as a drop"
    assert len(obs.directives) == 1
    assert obs.directives[0].action_id == "analysis.start"
    assert obs.directives[0].dispatchable is True


def test_hole6_a_live_pod_reaches_parity_with_the_hub_that_sent_the_same_action():
    """The end-to-end consequence: the classification, not just the observation."""
    hub = observe_hub(
        [{"event": "tool_start", "data": {"action_id": "analysis.start", "execution": "frontend"}}],
        grounded=True,
    )
    pod = _pod_live(
        [{"kind": "action", "payload": {"actionId": "analysis.start", "execution": "frontend"}}]
    )

    diff = classify(pod, hub, EquivalenceMode.EXACT)
    assert diff.at_parity, f"a correct live pod turn scored {diff.failures}"


def test_hole6_the_real_drop_fingerprint_still_fails():
    """The other half. A guard that never fails is as broken as one that never
    passes: a pod reporting a count with no payloads anywhere is still a drop."""
    from hushh_mcp.observability.parity_oracle import observe_pod

    obs = observe_pod({"text": "hi", "grounded": True, "directiveCount": 2})

    assert obs.directives_dropped is True
    assert obs.directives == ()


def test_hole6_a_delegate_directive_is_observed_as_a_specialist():
    obs = _pod_live([{"kind": "action", "payload": {}, "delegateAgentId": "agent_email"}])

    assert len(obs.directives) == 1
    assert obs.directives[0].kind == "specialist"
    assert obs.directives[0].delegate_agent_id == "agent_email"


def test_hole6_a_hollow_live_directive_is_still_hollow():
    """No `execution: frontend` means the directive cannot drive the app. The pod
    branch must apply the same rule the hub branch does, or the two transports
    would disagree about the same directive and every comparison would be noise."""
    obs = _pod_live([{"kind": "action", "payload": {"actionId": "analysis.start"}}])

    assert obs.directives[0].dispatchable is False


def test_hole6_a_live_pod_enumerates_its_own_specialist_outcomes():
    """When the turn carries statuses, they are the primary observation -- the
    harness parameter is only a stand-in for fixtures that predate them."""
    from hushh_mcp.observability.parity_oracle import observe_pod

    obs = observe_pod(
        {
            "text": "ok",
            "grounded": True,
            "specialists": [{"agent_id": "agent_nav", "status": "ok"}],
        },
        specialist_statuses=[{"agent_id": "agent_email", "status": "error"}],
    )

    assert obs.specialists == (SpecialistObservation(agent_id="agent_nav", status="ok"),)
