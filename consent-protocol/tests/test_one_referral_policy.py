"""The referral qualification rules, at their boundaries.

Qualification turns on exactly one thing: has the referred person finished the
required Hushh One onboarding flow, server-side. There is no active-minutes
floor, no eligible-agent requirement, and no minimum-event count -- those used
to gate `evaluate()` and were retired along with the tests that pinned them.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.operons.referral.policy import (
    ALLOWED_TRANSITIONS,
    ATTRIBUTED,
    EXPIRED,
    ONBOARDED,
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
        status=ONBOARDED,
        phone_verified=True,
        onboarding_complete=True,
        risk_level="low",
    )
    base.update(overrides)
    return QualificationInput(**base)


# --- onboarding completion is the whole bar ---------------------------------


def test_completing_onboarding_alone_qualifies():
    # No engagement session, no eligible agent, no elapsed time -- onboarding
    # completion plus a verified phone is the entire bar.
    assert evaluate(_candidate(), POLICY).target_status == QUALIFIED


@pytest.mark.parametrize("missing", ["phone_verified", "onboarding_complete"])
def test_no_single_requirement_can_be_skipped(missing):
    # Each of these alone must block qualification, with everything else passing.
    assert evaluate(_candidate(**{missing: False}), POLICY).target_status == ONBOARDED


def test_signing_in_alone_never_qualifies():
    signed_in_only = _candidate(status=ATTRIBUTED, phone_verified=False, onboarding_complete=False)
    assert evaluate(signed_in_only, POLICY).changed is False


# --- risk and settled states -------------------------------------------------


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
