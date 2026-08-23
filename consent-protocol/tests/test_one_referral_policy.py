"""The referral qualification rules, at their boundaries.

Fifteen minutes is the product's promise, so 899 seconds versus 900 is the line
the whole program turns on. It is asserted here in milliseconds against the same
function that runs in production, because the alternative -- waiting fifteen
real minutes -- is a test nobody runs twice.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.operons.referral.policy import (
    ALLOWED_TRANSITIONS,
    ATTRIBUTED,
    ENGAGING,
    EXPIRED,
    QUALIFIED,
    REJECTED,
    REVOKED,
    TERMINAL_STATES,
    UNDER_REVIEW,
    IllegalTransition,
    QualificationInput,
    ReferralPolicy,
    assert_transition,
    can_transition,
    counts_toward_public_total,
    credit_for_heartbeat,
    eligible_credited_seconds,
    evaluate,
    merge_intervals,
    public_status,
)

NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc)
POLICY = ReferralPolicy(version=1, eligible_agent_keys=("one_location",))


def _candidate(**overrides) -> QualificationInput:
    base = dict(
        status=ENGAGING,
        phone_verified=True,
        onboarding_complete=True,
        entered_application=True,
        credited_active_seconds=900,
        meaningful_event_count=3,
        used_eligible_agent=True,
        onboarded_at=NOW - timedelta(days=1),
        now=NOW,
        risk_level="low",
    )
    base.update(overrides)
    return QualificationInput(**base)


# --- the fifteen-minute line ------------------------------------------------


@pytest.mark.parametrize(
    "seconds,expected",
    [(0, ENGAGING), (899, ENGAGING), (900, QUALIFIED), (901, QUALIFIED)],
)
def test_the_active_time_boundary_is_exact(seconds, expected):
    assert evaluate(_candidate(credited_active_seconds=seconds), POLICY).target_status == expected


@pytest.mark.parametrize("events,expected", [(0, ENGAGING), (2, ENGAGING), (3, QUALIFIED)])
def test_the_meaningful_event_boundary_is_exact(events, expected):
    assert evaluate(_candidate(meaningful_event_count=events), POLICY).target_status == expected


def test_a_twenty_minute_policy_moves_the_line_without_touching_the_code():
    twenty = ReferralPolicy(version=2, required_active_seconds=1200)
    assert evaluate(_candidate(credited_active_seconds=900), twenty).target_status == ENGAGING
    assert evaluate(_candidate(credited_active_seconds=1200), twenty).target_status == QUALIFIED


# --- every requirement is load-bearing --------------------------------------


@pytest.mark.parametrize(
    "missing",
    ["phone_verified", "onboarding_complete", "entered_application", "used_eligible_agent"],
)
def test_no_single_requirement_can_be_skipped(missing):
    # Each of these alone must block qualification, with everything else passing.
    assert evaluate(_candidate(**{missing: False}), POLICY).target_status == ENGAGING


def test_signing_in_alone_never_qualifies():
    signed_in_only = _candidate(
        status=ATTRIBUTED,
        onboarding_complete=False,
        entered_application=False,
        used_eligible_agent=False,
        credited_active_seconds=0,
        meaningful_event_count=0,
        onboarded_at=None,
    )
    assert evaluate(signed_in_only, POLICY).changed is False


# --- windows, risk and settled states ---------------------------------------


def test_time_spent_after_the_window_closes_does_not_qualify():
    late = _candidate(onboarded_at=NOW - timedelta(days=8))
    assert evaluate(late, POLICY).target_status == EXPIRED


def test_the_window_boundary_is_exact():
    closes = NOW - timedelta(days=POLICY.qualification_window_days)
    assert (
        evaluate(_candidate(onboarded_at=closes + timedelta(seconds=1)), POLICY).target_status
        == QUALIFIED
    )
    assert evaluate(_candidate(onboarded_at=closes), POLICY).target_status == EXPIRED


def test_medium_risk_is_held_for_a_human_and_high_risk_is_refused():
    assert evaluate(_candidate(risk_level="medium"), POLICY).target_status == UNDER_REVIEW
    assert evaluate(_candidate(risk_level="high"), POLICY).target_status == REJECTED


def test_a_referral_already_under_review_is_not_re_flagged_every_pass():
    held = _candidate(status=UNDER_REVIEW, risk_level="medium")
    assert evaluate(held, POLICY).changed is False


def test_qualifying_twice_changes_nothing():
    assert evaluate(_candidate(status=QUALIFIED), POLICY).changed is False


@pytest.mark.parametrize("state", sorted(TERMINAL_STATES))
def test_a_settled_referral_is_never_re_evaluated(state):
    assert evaluate(_candidate(status=state), POLICY).changed is False


def test_a_disabled_program_qualifies_nobody():
    off = ReferralPolicy(version=1, program_enabled=False)
    assert evaluate(_candidate(), off).changed is False


# --- the state machine ------------------------------------------------------


def test_terminal_states_have_no_way_out():
    for state in TERMINAL_STATES:
        assert ALLOWED_TRANSITIONS[state] == frozenset()


def test_the_funnel_cannot_be_skipped():
    assert not can_transition(ATTRIBUTED, QUALIFIED)
    with pytest.raises(IllegalTransition):
        assert_transition(REJECTED, QUALIFIED)


def test_the_only_exit_from_qualified_is_revocation():
    assert ALLOWED_TRANSITIONS[QUALIFIED] == frozenset({REVOKED})


def test_only_a_live_qualified_referral_is_counted():
    assert counts_toward_public_total(QUALIFIED) is True
    assert counts_toward_public_total(REVOKED) is False
    assert counts_toward_public_total(UNDER_REVIEW) is False


def test_the_label_never_leaks_the_reason():
    # A rejected referral reads exactly like an expired one. Telling someone
    # their friend was refused would also tell them what our checks look at.
    assert public_status(REJECTED) == public_status(EXPIRED) == "Expired"
    assert public_status("something_we_have_not_shipped_yet") == "In progress"


# --- credited time ----------------------------------------------------------


def _beat(**overrides) -> int:
    base = dict(
        previous_beat_at=NOW - timedelta(seconds=30),
        beat_at=NOW,
        last_interaction_at=NOW - timedelta(seconds=5),
        foreground=True,
        policy=POLICY,
    )
    base.update(overrides)
    return credit_for_heartbeat(**base)


def test_a_normal_heartbeat_credits_one_interval():
    assert _beat() == 30


def test_background_and_idle_time_earn_nothing():
    assert _beat(foreground=False) == 0
    assert _beat(last_interaction_at=None) == 0
    assert _beat(last_interaction_at=NOW - timedelta(seconds=120)) == 0


def test_a_replayed_or_out_of_order_beat_earns_nothing():
    assert _beat(previous_beat_at=NOW) == 0
    assert _beat(previous_beat_at=NOW + timedelta(seconds=10)) == 0


def test_a_silent_gap_is_not_credited_as_presence():
    assert _beat(previous_beat_at=NOW - timedelta(seconds=600)) == 0


def test_beating_slowly_is_never_worth_more_than_beating_on_time():
    assert (
        _beat(previous_beat_at=NOW - timedelta(seconds=89)) <= POLICY.max_credit_per_heartbeat_secs
    )


def test_the_first_beat_of_a_session_credits_one_interval_not_the_whole_gap():
    assert _beat(previous_beat_at=None) == POLICY.max_credit_per_heartbeat_secs


# --- overlapping sessions ---------------------------------------------------


def test_two_devices_do_not_earn_double_time():
    a = (NOW, NOW + timedelta(minutes=10))
    b = (NOW + timedelta(minutes=5), NOW + timedelta(minutes=15))
    # Naive addition would say 1200 seconds. The real answer is the wall clock.
    assert eligible_credited_seconds([a, b]) == 900


def test_separate_sessions_still_add_up():
    a = (NOW, NOW + timedelta(minutes=5))
    b = (NOW + timedelta(minutes=30), NOW + timedelta(minutes=40))
    assert eligible_credited_seconds([a, b]) == 900


def test_a_fully_contained_session_adds_nothing():
    outer = (NOW, NOW + timedelta(minutes=20))
    inner = (NOW + timedelta(minutes=5), NOW + timedelta(minutes=6))
    assert eligible_credited_seconds([outer, inner]) == 1200


def test_zero_length_and_backwards_intervals_are_discarded():
    assert merge_intervals([(NOW, NOW)]) == []
    assert merge_intervals([(NOW, NOW - timedelta(minutes=5))]) == []
